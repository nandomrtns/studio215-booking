import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  await app.register(cors, {
    origin: [config.ALLOWED_ORIGIN, 'https://nandomrtns.github.io'],
  });

  await app.register(healthRoutes);

  // Rotas de reserva, pagamento, webhook, .ics de saída e admin chegam a partir
  // da Fase 2 — a Fase 1 só precisa provar que o serviço sobe e fala com o banco.

  return app;
}
