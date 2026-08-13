import { and, eq, isNull, lt, notInArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reservations } from '../db/schema.js';
import { PAYMENT_EXPIRY_GRACE_MINUTES } from '../constants.js';

/**
 * Marca como `expired` toda reserva `pending` cujo `expires_at` já passou. A
 * exclusion constraint do banco só protege status pending/confirmed, então
 * isso libera a data automaticamente pro próximo hóspede assim que roda.
 *
 * Reserva com Pix ainda `pending`/`in_process` ganha uma folga extra
 * (PAYMENT_EXPIRY_GRACE_MINUTES) além do expires_at normal — rede de
 * segurança pro webhook de aprovação chegar atrasado. Passado esse corte
 * duro, expira de qualquer jeito (o mecanismo principal contra isso é o
 * date_of_expiration do Pix já ser igual ao expires_at da reserva).
 */
export async function sweepExpiredReservations(): Promise<number> {
  const now = new Date();
  const hardCutoff = new Date(now.getTime() - PAYMENT_EXPIRY_GRACE_MINUTES * 60_000);

  const noPixInFlight = or(
    isNull(reservations.mpPaymentStatus),
    notInArray(reservations.mpPaymentStatus, ['pending', 'in_process'])
  );

  const expired = await db
    .update(reservations)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(reservations.status, 'pending'),
        or(lt(reservations.expiresAt, hardCutoff), and(lt(reservations.expiresAt, now), noPixInFlight))
      )
    )
    .returning({ id: reservations.id });

  if (expired.length > 0) {
    console.log(`[expiry] ${expired.length} reserva(s) pendente(s) expirada(s).`);
  }

  return expired.length;
}
