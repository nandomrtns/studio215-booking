/**
 * Segundo ponto de entrada do mesmo serviço — roda como um processo separado no
 * Railway (mesmo código, start command diferente do server.ts), fazendo o polling
 * periódico do Airbnb e a expiração de reservas pendentes.
 *
 * Fase 1: só prova que o processo sobe e conecta no banco. Os cron jobs de
 * verdade (sync do Airbnb a cada 15-30min, expiração de pending a cada 1-5min)
 * entram na Fase 2, junto com o motor de reserva que eles servem.
 */
import { sql } from 'drizzle-orm';
import { db } from './db/client.js';

async function main() {
  await db.execute(sql`select 1`);
  console.log('[worker] conectado ao banco — nenhum cron job ativo ainda (Fase 1).');

  // Mantém o processo vivo (Railway espera um processo de longa duração).
  setInterval(() => {
    console.log(`[worker] alive — ${new Date().toISOString()}`);
  }, 5 * 60 * 1000);
}

main().catch((err) => {
  console.error('[worker] falha ao iniciar:', err);
  process.exit(1);
});
