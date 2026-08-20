/**
 * Segundo ponto de entrada do mesmo serviço — roda como um processo separado no
 * Railway (mesmo código, start command diferente do server.ts): sync periódico
 * do calendário do Airbnb e expiração de reservas pendentes vencidas.
 */
import { sql } from 'drizzle-orm';
import { db } from './db/client.js';
import { config } from './config.js';
import { syncAirbnbCalendar } from './services/airbnb-sync.js';
import { cancelOrphanOrders, sweepExpiredReservations } from './services/reservation-expiry.js';

// 5 min é o piso útil: o próprio Airbnb leva alguns minutos pra refletir uma
// reserva nova no .ics dele, então puxar mais rápido que isso gasta requisição
// sem ganhar frescor. A janela que sobra é fechada pelo fetch just-in-time na
// criação da reserva (routes/reservations.ts).
const AIRBNB_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const EXPIRY_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

async function main() {
  await db.execute(sql`select 1`);
  console.log('[worker] conectado ao banco.');

  await syncAirbnbCalendar();
  setInterval(syncAirbnbCalendar, AIRBNB_SYNC_INTERVAL_MS);

  // O cancelamento só faz sentido com credencial do MP configurada — sem
  // ela, o serviço roda as Fases 1 e 2 normalmente e só não cancela ordens.
  const sweep = config.MP_ACCESS_TOKEN
    ? async () => {
        await sweepExpiredReservations();
        await cancelOrphanOrders();
      }
    : sweepExpiredReservations;

  await sweep();
  setInterval(sweep, EXPIRY_SWEEP_INTERVAL_MS);

  console.log(
    `[worker] cron ativo — sync Airbnb a cada ${AIRBNB_SYNC_INTERVAL_MS / 60_000}min, ` +
      `expiração a cada ${EXPIRY_SWEEP_INTERVAL_MS / 60_000}min.`
  );
}

main().catch((err) => {
  console.error('[worker] falha ao iniciar:', err);
  process.exit(1);
});
