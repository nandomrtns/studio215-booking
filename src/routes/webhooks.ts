import type { FastifyInstance } from 'fastify';
import { eq, isNotNull } from 'drizzle-orm';
import { WebhookSignatureValidator, InvalidWebhookSignatureError } from 'mercadopago';
import { db } from '../db/client.js';
import { webhookEvents } from '../db/schema.js';
import { config } from '../config.js';
import { getOrder } from '../services/mercado-pago-payments.js';
import { applyOrderResult } from '../services/payment-confirmation.js';

interface MpNotificationBody {
  id?: number | string;
  type?: string;
  action?: string;
  data?: { id?: string };
}

/**
 * O MP normaliza ids alfanuméricos pra minúsculas antes de assinar, mas o
 * validador do SDK monta o manifest com o id verbatim. Com a API antiga isso
 * nunca importou (ids de pagamento eram numéricos); ids de ordem são
 * alfanuméricos e maiúsculos (`ORD01M0...`), então a assinatura falharia em
 * toda notificação. Tenta as duas formas e loga qual valeu, pra podermos
 * fixar uma só depois de ver notificações reais.
 */
function validateSignature(
  app: FastifyInstance,
  headers: { xSignature: unknown; xRequestId: unknown },
  dataId: string,
  secret: string
): void {
  const attempt = (id: string) =>
    WebhookSignatureValidator.validate({
      xSignature: headers.xSignature as string,
      xRequestId: headers.xRequestId as string,
      dataId: id,
      secret,
    });

  try {
    attempt(dataId);
  } catch (err) {
    if (!(err instanceof InvalidWebhookSignatureError)) throw err;
    const lowered = dataId.toLowerCase();
    if (lowered === dataId) throw err;
    attempt(lowered);
    app.log.info('assinatura do webhook validou com data.id em minúsculas');
  }
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
      // aninhar em objeto).
      const dataId = (req.query as Record<string, string | undefined>)['data.id'];

      const body = req.body as MpNotificationBody;
      // Na Orders API o data.id é o id da ORDEM (ORD...), não do pagamento.
      const mpOrderId = body.data?.id ?? dataId;

      if (!dataId || !mpOrderId) {
        req.log.warn({ body }, 'webhook do Mercado Pago sem id do recurso');
        return reply.status(200).send();
      }

      try {
        validateSignature(
          app,
          { xSignature: req.headers['x-signature'], xRequestId: req.headers['x-request-id'] },
          dataId,
          config.MP_WEBHOOK_SECRET
        );
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

      // Sem o `id` de topo não dá pra deduplicar; o x-request-id é único por
      // entrega e serve de substituto. Sem esse fallback, uma notificação
      // sem `id` sairia daqui com 200 sem nunca ser processada — o Pix
      // ficaria eternamente pendente e ninguém perceberia.
      const notificationId = body.id != null ? String(body.id) : (req.headers['x-request-id'] as string | undefined);
      if (!notificationId) {
        req.log.warn({ body }, 'webhook sem id de notificação e sem x-request-id — não é possível deduplicar');
        return reply.status(200).send();
      }

      const inserted = await db
        .insert(webhookEvents)
        .values({
          mpOrderId,
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

      // Só o tópico de ordens interessa. Processar também o de pagamentos
      // seria dupla escrita sobre a mesma reserva por caminhos diferentes.
      if (body.type !== 'order') {
        await db.update(webhookEvents).set({ processed: true }).where(eq(webhookEvents.id, event.id));
        return reply.status(200).send();
      }

      // Nunca confia no status que vem no corpo do webhook — busca a ordem
      // de verdade na API, que é a fonte de autoridade.
      const order = await getOrder(mpOrderId);
      await applyOrderResult(order);

      await db.update(webhookEvents).set({ processed: true }).where(eq(webhookEvents.id, event.id));
      return reply.status(200).send();
    }
  );
}
