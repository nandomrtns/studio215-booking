import type { FastifyInstance } from 'fastify';
import { eq, isNotNull } from 'drizzle-orm';
import { WebhookSignatureValidator, InvalidWebhookSignatureError } from 'mercadopago';
import { db } from '../db/client.js';
import { webhookEvents } from '../db/schema.js';
import { config } from '../config.js';
import { getPayment } from '../services/mercado-pago-payments.js';
import { applyPaymentResult } from '../services/payment-confirmation.js';

interface MpNotificationBody {
  id?: number | string;
  type?: string;
  action?: string;
  data?: { id?: string };
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post(
    '/api/webhooks/mercadopago',
    // Autenticado por assinatura HMAC, não por volume/IP — sem rate limit.
    { config: { rateLimit: false } },
    async (req, reply) => {
      if (!config.MP_WEBHOOK_SECRET) {
        req.log.error('MP_WEBHOOK_SECRET não configurado — não é possível verificar webhooks.');
        return reply.status(500).send();
      }

      // Fastify usa fast-querystring por padrão (chave plana "data.id", sem
      // aninhar em objeto) — vale confirmar contra uma notificação real de
      // sandbox antes de confiar cegamente nisso.
      const dataId = (req.query as Record<string, string | undefined>)['data.id'];

      try {
        WebhookSignatureValidator.validate({
          xSignature: req.headers['x-signature'],
          xRequestId: req.headers['x-request-id'],
          dataId,
          secret: config.MP_WEBHOOK_SECRET,
        });
      } catch (err) {
        if (err instanceof InvalidWebhookSignatureError) {
          req.log.warn(
            { reason: err.reason, requestId: err.requestId },
            'webhook do Mercado Pago com assinatura inválida'
          );
          return reply.status(401).send();
        }
        throw err;
      }

      const body = req.body as MpNotificationBody;
      const notificationId = body.id != null ? String(body.id) : undefined;
      const mpPaymentId = body.data?.id ?? dataId;

      if (!notificationId || !mpPaymentId) {
        req.log.warn({ body }, 'webhook do Mercado Pago sem id de notificação ou de pagamento');
        return reply.status(200).send();
      }

      const inserted = await db
        .insert(webhookEvents)
        .values({
          mpPaymentId,
          mpNotificationId: notificationId,
          eventType: body.action ?? body.type,
          payload: body,
        })
        // O target precisa repetir o predicado da partial unique index
        // (migration 0001) pra Postgres conseguir usá-la como arbiter.
        .onConflictDoNothing({
          target: webhookEvents.mpNotificationId,
          where: isNotNull(webhookEvents.mpNotificationId),
        })
        .returning({ id: webhookEvents.id, processed: webhookEvents.processed });

      // Notificação já vista antes (reentrega do MP) — busca a linha
      // existente em vez de assumir que já foi processada: se a tentativa
      // anterior falhou depois do insert (ex.: timeout chamando o MP), a
      // linha fica com processed=false e o reenvio precisa reprocessar, não
      // só confirmar 200 e sumir.
      const [event] =
        inserted.length > 0
          ? inserted
          : await db
              .select({ id: webhookEvents.id, processed: webhookEvents.processed })
              .from(webhookEvents)
              .where(eq(webhookEvents.mpNotificationId, notificationId))
              .limit(1);

      if (!event || event.processed) {
        return reply.status(200).send();
      }

      if (body.type !== 'payment') {
        await db.update(webhookEvents).set({ processed: true }).where(eq(webhookEvents.id, event.id));
        return reply.status(200).send();
      }

      // Nunca confia no status que vem no corpo do webhook — busca o
      // pagamento de verdade na API, que é a fonte de autoridade.
      const payment = await getPayment(mpPaymentId);
      await applyPaymentResult(payment);

      await db.update(webhookEvents).set({ processed: true }).where(eq(webhookEvents.id, event.id));
      return reply.status(200).send();
    }
  );
}
