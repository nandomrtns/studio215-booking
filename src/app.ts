import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { availabilityRoutes } from './routes/availability.js';
import { pricingRoutes } from './routes/pricing.js';
import { reservationRoutes } from './routes/reservations.js';
import { calendarRoutes } from './routes/calendar.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  await app.register(cors, {
    // API é pública e sem cookie/sessão (capability via UUID + rate limit),
    // então liberar localhost em qualquer porta pra desenvolvimento não muda
    // a postura de segurança real.
    origin: (origin, cb) => {
      const allowed =
        !origin ||
        origin === config.ALLOWED_ORIGIN ||
        origin === 'https://nandomrtns.github.io' ||
        /^http:\/\/localhost(:\d+)?$/.test(origin);
      cb(null, allowed);
    },
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

  // Import dinâmico: lib/mercado-pago.ts lança na hora de importar se
  // MP_ACCESS_TOKEN não estiver setado — isso mantém o boot da Fase 1/2
  // funcionando em qualquer ambiente sem credenciais MP configuradas (ex.:
  // dev local sem pagamento), em vez de derrubar o servidor inteiro.
  if (config.MP_ACCESS_TOKEN) {
    const { paymentRoutes } = await import('./routes/payments.js');
    const { webhookRoutes } = await import('./routes/webhooks.js');
    await app.register(paymentRoutes);
    await app.register(webhookRoutes);
  } else {
    app.log.warn('MP_ACCESS_TOKEN não definido — rotas de pagamento desativadas.');
  }

  // Feed .ics de saída (Airbnb importa daqui). A própria rota se cala quando
  // CALENDAR_FEED_TOKEN não está definido — sem token não existe feed.
  await app.register(calendarRoutes);

  // O painel admin chega na Fase 4.

  return app;
}
