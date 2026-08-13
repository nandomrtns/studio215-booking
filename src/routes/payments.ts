import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { MercadoPagoError } from 'mercadopago';
import type { PaymentResponse } from 'mercadopago/dist/clients/payment/commonTypes.js';
import { db } from '../db/client.js';
import { reservations } from '../db/schema.js';
import { createPaymentSchema } from '../schemas/payment.js';
import {
  createCardPayment,
  createPixPayment,
  derivePaymentMethod,
  getPayment,
} from '../services/mercado-pago-payments.js';
import { applyPaymentResult } from '../services/payment-confirmation.js';

function paymentResponse(payment: PaymentResponse) {
  return {
    mpPaymentId: payment.id != null ? String(payment.id) : null,
    method: derivePaymentMethod(payment),
    status: payment.status,
    statusDetail: payment.status_detail,
    qrCode: payment.point_of_interaction?.transaction_data?.qr_code,
    qrCodeBase64: payment.point_of_interaction?.transaction_data?.qr_code_base64,
    expiresAt: payment.date_of_expiration,
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
          // Idempotência: Pix ainda pendente de pagamento → devolve o mesmo
          // QR em vez de gerar um pagamento novo (cobre reload de página).
          const hasOpenPix =
            reservation.paymentMethod === 'pix' &&
            reservation.mpPaymentId &&
            (reservation.mpPaymentStatus === 'pending' || reservation.mpPaymentStatus === 'in_process');

          const payment = hasOpenPix
            ? await getPayment(reservation.mpPaymentId as string)
            : await createPixPayment(reservation);

          // Sempre reaplica o resultado, mesmo no caminho de reload: se o
          // Pix aprovou entre a última checagem e agora, confirma na hora
          // em vez de esperar o webhook chegar.
          await applyPaymentResult(payment);
          return reply.status(201).send(paymentResponse(payment));
        }

        const payment = await createCardPayment(reservation, {
          token: input.token,
          installments: input.installments,
          paymentMethodId: input.paymentMethodId,
          issuerId: input.issuerId,
        });
        // Fast-path síncrono: cartão aprova/rejeita na hora, não precisa
        // esperar o webhook pra confirmar a reserva.
        await applyPaymentResult(payment);
        return reply.status(201).send(paymentResponse(payment));
      } catch (err) {
        if (err instanceof MercadoPagoError) {
          req.log.error({ err }, 'falha na API do Mercado Pago ao criar pagamento');
          return reply.status(502).send({ error: 'falha_mercado_pago' });
        }
        req.log.error(err, 'falha ao criar pagamento');
        return reply.status(500).send({ error: 'erro_interno' });
      }
    }
  );
}
