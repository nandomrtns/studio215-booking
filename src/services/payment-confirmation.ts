import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reservations } from '../db/schema.js';
import { checkAirbnbConflict } from './airbnb-sync.js';
import {
  derivePaymentMethod,
  refundOrder,
  relevantPayment,
  type OrderResponse,
} from './mercado-pago-payments.js';
import { ADVISORY_LOCK_KEY, PG_EXCLUSION_VIOLATION } from '../constants.js';

const TERMINAL_STATUSES = ['confirmed', 'confirmed_conflict', 'refunded', 'cancelled'];

/**
 * Único status da Orders API que significa "dinheiro creditado". Todos os
 * outros — `action_required`, `created`, `processing`, `failed`, `canceled`,
 * `expired` — deixam a reserva `pending`, seja porque o pagamento ainda está
 * em voo, seja porque falhou e o hóspede pode tentar de novo dentro do prazo.
 * Status desconhecido cai no mesmo balde: nunca confirma por engano.
 */
const ORDER_STATUS_APPROVED = 'processed';

/**
 * Ponto único de verdade pra aplicar o resultado de uma ordem numa reserva —
 * chamado tanto pelo fast-path síncrono do cartão (a resposta da criação já
 * vem com status final) quanto pelo webhook (fonte de verdade pro Pix, que é
 * assíncrono). Idempotente: reprocessar a mesma ordem (reentrega de webhook,
 * ou webhook chegando depois do fast-path já ter confirmado) não tem efeito
 * colateral.
 */
export async function applyOrderResult(order: OrderResponse): Promise<void> {
  const mpOrderId = order.id;
  const reservationId = order.external_reference;
  const status = order.status;
  // Pode não existir ainda: uma ordem recém-criada (`created`) não tem
  // pagamento associado. Por isso não entra no guard abaixo.
  const mpPaymentId = relevantPayment(order)?.id;

  if (!mpOrderId || !reservationId || !status) {
    console.error(
      `[payment-confirmation] ordem com dados incompletos (id=${mpOrderId}, external_reference=${reservationId}, status=${status}) — ignorada.`
    );
    return;
  }

  const [reservation] = await db.select().from(reservations).where(eq(reservations.id, reservationId)).limit(1);
  if (!reservation) {
    console.error(`[payment-confirmation] reserva ${reservationId} não encontrada pra ordem ${mpOrderId}.`);
    return;
  }

  if (TERMINAL_STATUSES.includes(reservation.status)) {
    console.log(
      `[payment-confirmation] reserva ${reservationId} já está em status terminal (${reservation.status}) — evento '${status}' da ordem ${mpOrderId} ignorado.`
    );
    return;
  }

  const paymentMethod = derivePaymentMethod(order);

  if (status === ORDER_STATUS_APPROVED) {
    await handleApproved(reservation, mpOrderId, mpPaymentId, paymentMethod);
    return;
  }

  // Guarda o status cru da ordem — mesmo vocabulário que aparece no painel do
  // MP, sem camada de tradução pra dessincronizar.
  await db
    .update(reservations)
    .set({
      mpPaymentStatus: status,
      mpOrderId,
      ...(mpPaymentId ? { mpPaymentId } : {}),
      paymentMethod,
      updatedAt: new Date(),
    })
    .where(eq(reservations.id, reservationId));
}

async function handleApproved(
  reservation: typeof reservations.$inferSelect,
  mpOrderId: string,
  mpPaymentId: string | undefined,
  paymentMethod: 'pix' | 'credit_card' | null
): Promise<void> {
  const paid = {
    status: 'confirmed' as const,
    mpPaymentStatus: ORDER_STATUS_APPROVED,
    mpOrderId,
    ...(mpPaymentId ? { mpPaymentId } : {}),
    paymentMethod,
    updatedAt: new Date(),
  };

  const confirmed = await db
    .update(reservations)
    .set(paid)
    .where(and(eq(reservations.id, reservation.id), eq(reservations.status, 'pending')))
    .returning({ id: reservations.id });

  if (confirmed.length > 0) {
    console.log(
      `[payment-confirmation] reserva ${reservation.id} confirmada (ordem ${mpOrderId}, pagamento ${mpPaymentId ?? 'n/d'}).`
    );
    return;
  }

  // A reserva não estava mais 'pending' — provavelmente expirou antes do
  // webhook chegar (Pix pode demorar). Decisão de negócio: resgata pra
  // confirmed se a data ainda estiver livre (mais gentil com quem já pagou);
  // só vira confirmed_conflict quando alguém de fato ocupou a data nesse
  // meio tempo. A EXCLUDE constraint do banco decide de verdade pra outras
  // reservas (mesmo mecanismo de routes/reservations.ts); o Airbnb continua
  // checado manualmente porque o calendário sincronizado não tem trava no
  // banco.
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK_KEY}))`);

      const airbnbConflict = await checkAirbnbConflict(tx, reservation.checkIn, reservation.checkOut);
      if (airbnbConflict) {
        throw Object.assign(new Error('conflito_airbnb'), { conflictCode: 'AIRBNB' });
      }

      await tx.update(reservations).set(paid).where(eq(reservations.id, reservation.id));
    });

    console.log(
      `[payment-confirmation] reserva ${reservation.id} resgatada e confirmada (ordem ${mpOrderId} chegou atrasada, data ainda estava livre).`
    );
  } catch (err) {
    const anyErr = err as { conflictCode?: string; code?: string; cause?: { code?: string } };
    const isConflict =
      anyErr.conflictCode === 'AIRBNB' ||
      anyErr.code === PG_EXCLUSION_VIOLATION ||
      anyErr.cause?.code === PG_EXCLUSION_VIOLATION;

    if (!isConflict) throw err;

    await markConflictAndRefund(reservation.id, mpOrderId, mpPaymentId);
  }
}

async function markConflictAndRefund(
  reservationId: string,
  mpOrderId: string,
  mpPaymentId: string | undefined
): Promise<void> {
  await db
    .update(reservations)
    .set({
      status: 'confirmed_conflict',
      mpPaymentStatus: ORDER_STATUS_APPROVED,
      mpOrderId,
      ...(mpPaymentId ? { mpPaymentId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(reservations.id, reservationId));

  try {
    await refundOrder(mpOrderId, reservationId);
    await db
      .update(reservations)
      .set({ status: 'refunded', updatedAt: new Date() })
      .where(eq(reservations.id, reservationId));
    console.log(
      `[payment-confirmation] reserva ${reservationId}: conflito real detectado, ordem ${mpOrderId} estornada automaticamente.`
    );
  } catch (refundErr) {
    // Fica em confirmed_conflict (não 'refunded') — sinaliza que o dinheiro
    // ainda não voltou pro hóspede e precisa de ação manual. Sem painel
    // admin ainda (Fase 4), isso só aparece nos logs do Railway ou numa
    // query direta no banco.
    console.error(
      `[payment-confirmation] reserva ${reservationId}: conflito real detectado, mas o ESTORNO FALHOU pra ordem ${mpOrderId} (pagamento ${mpPaymentId ?? 'n/d'}) — ação manual necessária.`,
      refundErr
    );
  }
}
