import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { availabilityRoutes } from './routes/availability.js';
import { pricingRoutes } from './routes/pricing.js';
import { reservationRoutes } from './routes/reservations.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  await app.register(cors, {
    origin: [config.ALLOWED_ORIGIN, 'https://nandomrtns.github.io'],
  });

  // Global generoso — a rota que realmente precisa de proteção (criar reserva,
  // que trava uma data de verdade) tem um limite mais apertado no próprio
  // registro da rota, via `config.rateLimit` no fastify-plugin.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  await app.register(healthRoutes);
  await app.register(availabilityRoutes);
  await app.register(pricingRoutes);
  await app.register(reservationRoutes);

  // Pagamento, webhook, .ics de saída e admin chegam na Fase 3/4.

  return app;
}
