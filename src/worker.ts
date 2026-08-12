/**
 * Segundo ponto de entrada do mesmo serviço — roda como um processo separado no
 * Railway (mesmo código, start command diferente do server.ts): sync periódico
 * do calendário do Airbnb e expiração de reservas pendentes vencidas.
 */
import { sql } from 'drizzle-orm';
import { db } from './db/client.js';
import { syncAirbnbCalendar } from './services/airbnb-sync.js';
import { sweepExpiredReservations } from './services/reservation-expiry.js';

const AIRBNB_SYNC_INTERVAL_MS = 20 * 60 * 1000;
const EXPIRY_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

async function main() {
  await db.execute(sql`select 1`);
  console.log('[worker] conectado ao banco.');

  await syncAirbnbCalendar();
  setInterval(syncAirbnbCalendar, AIRBNB_SYNC_INTERVAL_MS);

  await sweepExpiredReservations();
  setInterval(sweepExpiredReservations, EXPIRY_SWEEP_INTERVAL_MS);

  console.log(
    `[worker] cron ativo — sync Airbnb a cada ${AIRBNB_SYNC_INTERVAL_MS / 60_000}min, ` +
      `expiração a cada ${EXPIRY_SWEEP_INTERVAL_MS / 60_000}min.`
  );
}

main().catch((err) => {
  console.error('[worker] falha ao iniciar:', err);
  process.exit(1);
});
