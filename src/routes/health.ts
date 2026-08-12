import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return reply.send({ status: 'ok', db: 'ok', time: new Date().toISOString() });
    } catch (err) {
      app.log.error(err, 'health check: banco indisponível');
      return reply.status(503).send({ status: 'degraded', db: 'unreachable' });
    }
  });
}
