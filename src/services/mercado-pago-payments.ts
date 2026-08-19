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

/**
 * O telefone chega em formato livre ("+55 51 99999-9999"). O MP quer DDD e
 * número separados, sem o código do país.
 */
function splitPhone(rawPhone: string): { area_code: string; number: string } | undefined {
  let digits = rawPhone.replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length > 11) digits = digits.slice(2);
  if (digits.length < 10) return undefined;
  return { area_code: digits.slice(0, 2), number: digits.slice(2) };
}

/**
 * Quanto mais dados do comprador e do produto o MP recebe, melhor a análise
 * antifraude e maior a taxa de aprovação — é também um dos critérios da
 * avaliação de qualidade da integração.
 */
function additionalInfoFor(reservation: ReservationRow) {
  const { firstName, lastName } = splitGuestName(reservation.guestName);
  const nights = nightsBetweenDates(reservation.checkIn, reservation.checkOut);
  const phone = splitPhone(reservation.guestPhone);

  return {
    items: [
      {
        id: reservation.id,
        title: 'Studio 215 — Skyline Moinhos, Porto Alegre',
        description:
          `Hospedagem de ${nights} noite${nights > 1 ? 's' : ''} ` +
          `(${reservation.checkIn} a ${reservation.checkOut}), ` +
          `${reservation.guestCount} hóspede${reservation.guestCount > 1 ? 's' : ''}`,
        category_id: 'travels',
        quantity: 1,
        unit_price: centsToAmount(reservation.totalCents),
      },
    ],
    payer: {
      first_name: firstName,
      last_name: lastName,
      ...(phone ? { phone } : {}),
    },
  };
}

/** Datas ISO (YYYY-MM-DD), sem fuso — mesma conta do services/pricing.ts. */
function nightsBetweenDates(checkIn: string, checkOut: string): number {
  const inDate = new Date(`${checkIn}T00:00:00Z`);
  const outDate = new Date(`${checkOut}T00:00:00Z`);
  return Math.round((outDate.getTime() - inDate.getTime()) / 86_400_000);
}

const NOTIFICATION_URL = `${config.PUBLIC_BASE_URL}/api/webhooks/mercadopago`;

/** Aparece na fatura do cartão do hóspede — reduz contestação por "não reconheço". */
const STATEMENT_DESCRIPTOR = 'STUDIO215';

export async function createPixPayment(
  reservation: ReservationRow,
  deviceId?: string
): Promise<PaymentResponse> {
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
      additional_info: additionalInfoFor(reservation),
    },
    requestOptions: {
      // Uma chave por reserva+método — reenvio da mesma requisição (retry de
      // rede, duplo clique) não cria um segundo pagamento no MP.
      idempotencyKey: `${reservation.id}:pix`,
      // Vai como header X-Meli-Session-Id: identifica o dispositivo do
      // comprador pro antifraude do MP.
      ...(deviceId ? { meliSessionId: deviceId } : {}),
    },
  });
}

export interface CreateCardPaymentInput {
  token: string;
  installments: number;
  paymentMethodId: string;
  issuerId: string;
  deviceId?: string;
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
      statement_descriptor: STATEMENT_DESCRIPTOR,
      payer: payerFor(reservation),
      additional_info: additionalInfoFor(reservation),
    },
    requestOptions: {
      // Inclui o token na chave — se o Brick gerar um token novo numa nova
      // tentativa, é uma cobrança genuinamente nova, não deve ser deduplicada.
      idempotencyKey: `${reservation.id}:card:${input.token}`,
      ...(input.deviceId ? { meliSessionId: input.deviceId } : {}),
    },
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
