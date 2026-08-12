import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reservations } from '../db/schema.js';

/**
 * Marca como `expired` toda reserva `pending` cujo `expires_at` já passou. A
 * exclusion constraint do banco só protege status pending/confirmed, então
 * isso libera a data automaticamente pro próximo hóspede assim que roda.
 */
export async function sweepExpiredReservations(): Promise<number> {
  const expired = await db
    .update(reservations)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(eq(reservations.status, 'pending'), lt(reservations.expiresAt, new Date())))
    .returning({ id: reservations.id });

  if (expired.length > 0) {
    console.log(`[expiry] ${expired.length} reserva(s) pendente(s) expirada(s).`);
  }

  return expired.length;
}
