import { Payment, PaymentRefund } from 'mercadopago';
import type { PaymentResponse } from 'mercadopago/dist/clients/payment/commonTypes.js';
import { mpClient } from '../lib/mercado-pago.js';
import { config } from '../config.js';
import type { reservations } from '../db/schema.js';

export type ReservationRow = typeof reservations.$inferSelect;

/** MP espera reais decimais ("210.00"), não centavos como o resto do schema usa. */
export function centsToAmount(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function splitGuestName(guestName: string): { firstName: string; lastName: string } {
  const parts = guestName.trim().split(/\s+/);
  const firstName = parts[0] ?? guestName;
  const lastName = parts.slice(1).join(' ') || firstName;
  return { firstName, lastName };
}

function payerFor(reservation: ReservationRow) {
  const { firstName, lastName } = splitGuestName(reservation.guestName);
  return {
    email: reservation.guestEmail,
    first_name: firstName,
    last_name: lastName,
    identification: reservation.guestDocument
      ? { type: 'CPF', number: reservation.guestDocument.replace(/\D/g, '') }
      : undefined,
  };
}

const NOTIFICATION_URL = `${config.PUBLIC_BASE_URL}/api/webhooks/mercadopago`;

export async function createPixPayment(reservation: ReservationRow): Promise<PaymentResponse> {
  const payment = new Payment(mpClient);
  return payment.create({
    body: {
      transaction_amount: centsToAmount(reservation.totalCents),
      payment_method_id: 'pix',
      description: `Studio 215 — ${reservation.checkIn} a ${reservation.checkOut}`,
      external_reference: reservation.id,
      notification_url: NOTIFICATION_URL,
      date_of_expiration: reservation.expiresAt?.toISOString(),
      payer: payerFor(reservation),
    },
    // Uma chave por reserva+método — reenvio da mesma requisição (retry de
    // rede, duplo clique) não cria um segundo pagamento no MP.
    requestOptions: { idempotencyKey: `${reservation.id}:pix` },
  });
}

export interface CreateCardPaymentInput {
  token: string;
  installments: number;
  paymentMethodId: string;
  issuerId: string;
}

export async function createCardPayment(
  reservation: ReservationRow,
  input: CreateCardPaymentInput
): Promise<PaymentResponse> {
  const payment = new Payment(mpClient);
  return payment.create({
    body: {
      transaction_amount: centsToAmount(reservation.totalCents),
      token: input.token,
      installments: input.installments,
      payment_method_id: input.paymentMethodId,
      issuer_id: Number(input.issuerId),
      description: `Studio 215 — ${reservation.checkIn} a ${reservation.checkOut}`,
      external_reference: reservation.id,
      notification_url: NOTIFICATION_URL,
      payer: payerFor(reservation),
    },
    // Inclui o token na chave — se o Brick gerar um token novo numa nova
    // tentativa, é uma cobrança genuinamente nova, não deve ser deduplicada.
    requestOptions: { idempotencyKey: `${reservation.id}:card:${input.token}` },
  });
}

export async function getPayment(mpPaymentId: string): Promise<PaymentResponse> {
  return new Payment(mpClient).get({ id: mpPaymentId });
}

export async function refundPayment(mpPaymentId: string) {
  return new PaymentRefund(mpClient).total({ payment_id: mpPaymentId });
}

/** payment_method_id/payment_type_id → nossa coluna payment_method (pix|credit_card). */
export function derivePaymentMethod(payment: PaymentResponse): 'pix' | 'credit_card' | null {
  if (payment.payment_method_id === 'pix') return 'pix';
  if (payment.payment_type_id === 'credit_card') return 'credit_card';
  return null;
}
