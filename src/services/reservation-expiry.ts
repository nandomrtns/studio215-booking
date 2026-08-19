import { and, eq, isNull, lt, notInArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reservations } from '../db/schema.js';
import { PAYMENT_EXPIRY_GRACE_MINUTES } from '../constants.js';

/** Ordem ainda em voo no Mercado Pago — pagamento sem desfecho. */
const OPEN_ORDER_STATUSES = ['created', 'processing', 'action_required'];

/**
 * Marca como `expired` toda reserva `pending` cujo `expires_at` já passou. A
 * exclusion constraint do banco só protege status pending/confirmed, então
 * isso libera a data automaticamente pro próximo hóspede assim que roda.
 *
 * Reserva com ordem ainda em voo ganha uma folga extra
 * (PAYMENT_EXPIRY_GRACE_MINUTES) além do expires_at normal — rede de
 * segurança pro webhook de aprovação chegar atrasado. Passado esse corte
 * duro, expira de qualquer jeito.
 *
 * Depois de expirar, cancela a ordem no MP (ver cancelOrphanOrders): o QR do
 * Pix vem sempre com 24h de validade e o MP ignora os campos de expiração,
 * então o cancelamento explícito é o único jeito de impedir que o hóspede
 * pague uma reserva que já foi liberada.
 */
export async function sweepExpiredReservations(): Promise<number> {
  const now = new Date();
  const hardCutoff = new Date(now.getTime() - PAYMENT_EXPIRY_GRACE_MINUTES * 60_000);

  const noPaymentInFlight = or(
    isNull(reservations.mpPaymentStatus),
    notInArray(reservations.mpPaymentStatus, OPEN_ORDER_STATUSES)
  );

  const expired = await db
    .update(reservations)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(reservations.status, 'pending'),
        or(lt(reservations.expiresAt, hardCutoff), and(lt(reservations.expiresAt, now), noPaymentInFlight))
      )
    )
    .returning({ id: reservations.id, mpOrderId: reservations.mpOrderId });

  if (expired.length > 0) {
    console.log(`[expiry] ${expired.length} reserva(s) pendente(s) expirada(s).`);
  }

  return expired.length;
}

/**
 * Cancela no Mercado Pago as ordens de reservas que já expiraram, pra
 * invalidar o QR do Pix. Separado do sweep e tolerante a falha: se o MP
 * estiver fora do ar, a reserva já está expirada no nosso lado (a data já
 * foi liberada) e a próxima rodada tenta de novo.
 *
 * O caso de o hóspede pagar mesmo assim, entre a expiração e o cancelamento,
 * continua coberto pela lógica de resgate/conflito em payment-confirmation.
 */
export async function cancelOrphanOrders(): Promise<number> {
  const { cancelOrder } = await import('./mercado-pago-payments.js');

  const orphans = await db
    .select({ id: reservations.id, mpOrderId: reservations.mpOrderId })
    .from(reservations)
    .where(
      and(
        eq(reservations.status, 'expired'),
        notInArray(reservations.mpPaymentStatus, ['canceled', 'processed', 'refunded'])
      )
    )
    .limit(20);

  let cancelled = 0;
  for (const row of orphans) {
    if (!row.mpOrderId) continue;
    try {
      await cancelOrder(row.mpOrderId, row.id);
      await db
        .update(reservations)
        .set({ mpPaymentStatus: 'canceled', updatedAt: new Date() })
        .where(eq(reservations.id, row.id));
      cancelled += 1;
    } catch (err) {
      console.error(`[expiry] falha ao cancelar a ordem ${row.mpOrderId} da reserva ${row.id}:`, err);
    }
  }

  if (cancelled > 0) {
    console.log(`[expiry] ${cancelled} ordem(ns) cancelada(s) no Mercado Pago.`);
  }

  return cancelled;
}
