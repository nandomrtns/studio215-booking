import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { MercadoPagoError } from 'mercadopago';
import { db } from '../db/client.js';
import { reservations } from '../db/schema.js';
import { createPaymentSchema } from '../schemas/payment.js';
import { PAYMENT_REJECTED_STATUS } from '../constants.js';
import {
  createCardOrder,
  createPixOrder,
  derivePaymentMethod,
  getOrder,
  relevantPayment,
  type OrderResponse,
} from '../services/mercado-pago-payments.js';
import { applyOrderResult } from '../services/payment-confirmation.js';

/** Ordem ainda em voo — pagamento não chegou a um desfecho. */
const OPEN_ORDER_STATUSES = ['created', 'processing', 'action_required'];

/**
 * Traduz o vocabulário da Orders API pro que o site já entende. O frontend
 * foi escrito contra a API antiga e só distingue três desfechos; manter esse
 * contrato evita mexer no site numa migração que já é grande.
 */
function toLegacyStatus(orderStatus?: string): 'approved' | 'rejected' | 'pending' {
  if (orderStatus === 'processed') return 'approved';
  if (['failed', 'canceled', 'expired', 'refunded', 'charged_back'].includes(orderStatus ?? '')) {
    return 'rejected';
  }
  return 'pending';
}

function paymentResponse(order: OrderResponse) {
  const payment = relevantPayment(order);
  const method = payment?.payment_method;
  return {
    mpPaymentId: payment?.id ?? null,
    mpOrderId: order.id ?? null,
    method: derivePaymentMethod(order),
    status: toLegacyStatus(order.status),
    statusDetail: order.status_detail,
    orderStatus: order.status,
    qrCode: method?.qr_code,
    qrCodeBase64: method?.qr_code_base64,
    expiresAt: payment?.date_of_expiration,
  };
}

export async function paymentRoutes(app: FastifyInstance) {
  app.post(
    '/api/reservations/:id/payments',
    // Mesmo espírito do limite de criar reserva: essa rota move dinheiro de
    // verdade, limite bem mais apertado que o global.
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const parsed = createPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(422).send({ error: 'validacao', issues: parsed.error.flatten() });
      }
      const input = parsed.data;

      const [reservation] = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
      if (!reservation) {
        return reply.status(404).send({ error: 'nao_encontrada' });
      }
      if (reservation.status !== 'pending') {
        return reply.status(409).send({ error: 'reserva_nao_pendente' });
      }
      // Checagem direta do relógio, não só do status — o worker só varre a
      // cada 2min, então uma reserva pode estar tecnicamente vencida sem
      // ainda ter sido marcada 'expired' no banco.
      if (reservation.expiresAt && reservation.expiresAt.getTime() < Date.now()) {
        return reply.status(410).send({ error: 'reserva_expirada' });
      }

      try {
        if (input.method === 'pix') {
          // Idempotência: Pix ainda em voo → devolve o mesmo QR em vez de
          // gerar uma ordem nova (cobre reload de página). Mesmo se caísse
          // no ramo de criar, a idempotencyKey faria o MP devolver a mesma
          // ordem — essa checagem é otimização, não a garantia.
          const hasOpenPix =
            reservation.paymentMethod === 'pix' &&
            reservation.mpOrderId &&
            OPEN_ORDER_STATUSES.includes(reservation.mpPaymentStatus ?? '');

          const order = hasOpenPix
            ? await getOrder(reservation.mpOrderId as string)
            : await createPixOrder(reservation, input.deviceId);

          // Sempre reaplica o resultado, mesmo no caminho de reload: se o
          // Pix aprovou entre a última checagem e agora, confirma na hora
          // em vez de esperar o webhook chegar.
          await applyOrderResult(order);
          return reply.status(201).send(paymentResponse(order));
        }

        const order = await createCardOrder(reservation, {
          token: input.token,
          installments: input.installments,
          paymentMethodId: input.paymentMethodId,
          deviceId: input.deviceId,
        });
        // Fast-path síncrono: cartão aprova/rejeita na hora, não precisa
        // esperar o webhook pra confirmar a reserva.
        await applyOrderResult(order);
        return reply.status(201).send(paymentResponse(order));
      } catch (err) {
        if ((err as { amountBlocked?: boolean }).amountBlocked) {
          req.log.error({ err }, 'pagamento barrado pela trava MP_MAX_AMOUNT_CENTS');
          return reply.status(503).send({ error: 'pagamento_indisponivel' });
        }
        // Cartão recusado NÃO é falha de sistema, mas a Orders API responde
        // com erro HTTP 402 (a API antiga devolvia 201 com status
        // 'rejected'). O corpo do 402 traz a ordem completa em `data`, mas o
        // SDK descarta esse campo e preserva só o status — o que basta pra
        // classificar. Sem isso o hóspede veria "erro no sistema" no lugar de
        // "cartão recusado", e não tentaria outro cartão.
        if (err instanceof MercadoPagoError && err.status === PAYMENT_REJECTED_STATUS) {
          req.log.info({ reservationId: reservation.id }, 'pagamento recusado pelo emissor');
          await db
            .update(reservations)
            .set({ mpPaymentStatus: 'failed', paymentMethod: input.method, updatedAt: new Date() })
            .where(eq(reservations.id, reservation.id));
          // 201 de propósito: a requisição foi processada com sucesso, quem
          // recusou foi o emissor. O site distingue pelo campo `status`.
          return reply.status(201).send({
            mpOrderId: null,
            mpPaymentId: null,
            method: input.method,
            status: 'rejected',
            orderStatus: 'failed',
            statusDetail: 'rejected_by_issuer',
          });
        }
        if (err instanceof MercadoPagoError) {
          req.log.error({ err }, 'falha na API do Mercado Pago ao criar ordem');
          return reply.status(502).send({ error: 'falha_mercado_pago' });
        }
        req.log.error(err, 'falha ao criar pagamento');
        return reply.status(500).send({ error: 'erro_interno' });
      }
    }
  );
}
