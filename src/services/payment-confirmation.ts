import { and, eq, sql } from 'drizzle-orm';
import type { PaymentResponse } from 'mercadopago/dist/clients/payment/commonTypes.js';
import { db } from '../db/client.js';
import { reservations } from '../db/schema.js';
import { checkAirbnbConflict } from './airbnb-sync.js';
import { derivePaymentMethod, refundPayment } from './mercado-pago-payments.js';
import { ADVISORY_LOCK_KEY, PG_EXCLUSION_VIOLATION } from '../constants.js';

const TERMINAL_STATUSES = ['confirmed', 'confirmed_conflict', 'refunded', 'cancelled'];

/**
 * Ponto único de verdade pra aplicar o resultado de um pagamento numa
 * reserva — chamado tanto pelo fast-path síncrono do cartão (a resposta da
 * criação já vem com status final) quanto pelo webhook (fonte de verdade
 * pro Pix, que é assíncrono). Idempotente: reprocessar o mesmo pagamento
 * (reentrega de webhook, ou webhook chegando depois do fast-path já ter
 * confirmado) não tem efeito colateral.
 */
export async function applyPaymentResult(payment: PaymentResponse): Promise<void> {
  const mpPaymentId = payment.id != null ? String(payment.id) : undefined;
  const reservationId = payment.external_reference;
  const status = payment.status;

  if (!mpPaymentId || !reservationId || !status) {
    console.error(
      `[payment-confirmation] pagamento com dados incompletos (id=${mpPaymentId}, external_reference=${reservationId}, status=${status}) — ignorado.`
    );
    return;
  }

  const [reservation] = await db.select().from(reservations).where(eq(reservations.id, reservationId)).limit(1);
  if (!reservation) {
    console.error(`[payment-confirmation] reserva ${reservationId} não encontrada pro pagamento ${mpPaymentId}.`);
    return;
  }

  if (TERMINAL_STATUSES.includes(reservation.status)) {
    console.log(
      `[payment-confirmation] reserva ${reservationId} já está em status terminal (${reservation.status}) — evento '${status}' do pagamento ${mpPaymentId} ignorado.`
    );
    return;
  }

  const paymentMethod = derivePaymentMethod(payment);

  if (status === 'approved') {
    await handleApproved(reservation, mpPaymentId, paymentMethod);
    return;
  }

  // rejected/cancelled/pending/in_process/authorized/etc — nunca mexe em
  // reservations.status aqui, só registra o status mais recente conhecido.
  // rejected/cancelled deixam a reserva 'pending' pra permitir nova
  // tentativa dentro do prazo; o worker de expiração é quem decide quando
  // desistir.
  await db
    .update(reservations)
    .set({ mpPaymentStatus: status, mpPaymentId, paymentMethod, updatedAt: new Date() })
    .where(eq(reservations.id, reservationId));
}

async function handleApproved(
  reservation: typeof reservations.$inferSelect,
  mpPaymentId: string,
  paymentMethod: 'pix' | 'credit_card' | null
): Promise<void> {
  const confirmed = await db
    .update(reservations)
    .set({ status: 'confirmed', mpPaymentStatus: 'approved', mpPaymentId, paymentMethod, updatedAt: new Date() })
    .where(and(eq(reservations.id, reservation.id), eq(reservations.status, 'pending')))
    .returning({ id: reservations.id });

  if (confirmed.length > 0) {
    console.log(`[payment-confirmation] reserva ${reservation.id} confirmada (pagamento ${mpPaymentId}).`);
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

      await tx
        .update(reservations)
        .set({ status: 'confirmed', mpPaymentStatus: 'approved', mpPaymentId, paymentMethod, updatedAt: new Date() })
        .where(eq(reservations.id, reservation.id));
    });

    console.log(
      `[payment-confirmation] reserva ${reservation.id} resgatada e confirmada (pagamento ${mpPaymentId} chegou atrasado, data ainda estava livre).`
    );
  } catch (err) {
    const anyErr = err as { conflictCode?: string; code?: string; cause?: { code?: string } };
    const isConflict =
      anyErr.conflictCode === 'AIRBNB' ||
      anyErr.code === PG_EXCLUSION_VIOLATION ||
      anyErr.cause?.code === PG_EXCLUSION_VIOLATION;

    if (!isConflict) throw err;

    await markConflictAndRefund(reservation.id, mpPaymentId);
  }
}

async function markConflictAndRefund(reservationId: string, mpPaymentId: string): Promise<void> {
  await db
    .update(reservations)
    .set({ status: 'confirmed_conflict', mpPaymentStatus: 'approved', mpPaymentId, updatedAt: new Date() })
    .where(eq(reservations.id, reservationId));

  try {
    await refundPayment(mpPaymentId);
    await db
      .update(reservations)
      .set({ status: 'refunded', updatedAt: new Date() })
      .where(eq(reservations.id, reservationId));
    console.log(
      `[payment-confirmation] reserva ${reservationId}: conflito real detectado, pagamento ${mpPaymentId} estornado automaticamente.`
    );
  } catch (refundErr) {
    // Fica em confirmed_conflict (não 'refunded') — sinaliza que o dinheiro
    // ainda não voltou pro hóspede e precisa de ação manual. Sem painel
    // admin ainda (Fase 4), isso só aparece nos logs do Railway ou numa
    // query direta no banco.
    console.error(
      `[payment-confirmation] reserva ${reservationId}: conflito real detectado, mas o ESTORNO FALHOU pro pagamento ${mpPaymentId} — ação manual necessária.`,
      refundErr
    );
  }
}
