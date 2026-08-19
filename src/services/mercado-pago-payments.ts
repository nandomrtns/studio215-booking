import { Order } from 'mercadopago';
import type {
  OrderResponse,
  PaymentResponse as OrderPaymentResponse,
} from 'mercadopago/dist/clients/order/commonTypes.js';
import { mpClient } from '../lib/mercado-pago.js';
import { config } from '../config.js';
import type { reservations } from '../db/schema.js';

export type ReservationRow = typeof reservations.$inferSelect;
export type { OrderResponse, OrderPaymentResponse };

/**
 * A Orders API usa valores como STRING decimal ("210.00"), não número — e o
 * resto do schema guarda centavos inteiros.
 */
export function centsToAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Trava de segurança pros testes em produção: com ela definida, nenhuma
 * cobrança acima do limite sai daqui. Não impede um teste de R$1 errado —
 * impede um de R$2.100, que é a diferença que importa.
 */
function assertAmountWithinLimit(totalCents: number): void {
  const limit = config.MP_MAX_AMOUNT_CENTS;
  if (limit !== undefined && totalCents > limit) {
    throw Object.assign(new Error('valor_acima_do_limite'), {
      amountBlocked: true,
      totalCents,
      limit,
    });
  }
}

function splitGuestName(guestName: string): { firstName: string; lastName: string } {
  const parts = guestName.trim().split(/\s+/);
  const firstName = parts[0] ?? guestName;
  const lastName = parts.slice(1).join(' ') || firstName;
  return { firstName, lastName };
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

function payerFor(reservation: ReservationRow) {
  const { firstName, lastName } = splitGuestName(reservation.guestName);
  const phone = splitPhone(reservation.guestPhone);
  return {
    email: reservation.guestEmail,
    first_name: firstName,
    last_name: lastName,
    ...(reservation.guestDocument
      ? { identification: { type: 'CPF', number: reservation.guestDocument.replace(/\D/g, '') } }
      : {}),
    ...(phone ? { phone } : {}),
  };
}

/** Datas ISO (YYYY-MM-DD), sem fuso — mesma conta do services/pricing.ts. */
function nightsBetweenDates(checkIn: string, checkOut: string): number {
  const inDate = new Date(`${checkIn}T00:00:00Z`);
  const outDate = new Date(`${checkOut}T00:00:00Z`);
  return Math.round((outDate.getTime() - inDate.getTime()) / 86_400_000);
}

/**
 * Detalhar item e comprador melhora a análise antifraude e é critério da
 * avaliação de qualidade da integração. `external_code` é o código do
 * PRODUTO (limite de 30 caracteres no MP) — quem identifica a reserva é o
 * `external_reference` no nível da ordem.
 */
function itemsFor(reservation: ReservationRow) {
  const nights = nightsBetweenDates(reservation.checkIn, reservation.checkOut);
  return [
    {
      external_code: 'STUDIO215-DIARIA',
      title: 'Studio 215 — Skyline Moinhos, Porto Alegre',
      description:
        `Hospedagem de ${nights} noite${nights > 1 ? 's' : ''} ` +
        `(${reservation.checkIn} a ${reservation.checkOut}), ` +
        `${reservation.guestCount} hóspede${reservation.guestCount > 1 ? 's' : ''}`,
      category_id: 'travels',
      quantity: 1,
      unit_price: centsToAmount(reservation.totalCents),
      event_date: `${reservation.checkIn}T15:00:00.000Z`,
    },
  ];
}

const CALLBACK_URL = `${config.PUBLIC_BASE_URL}/api/webhooks/mercadopago`;

/** Aparece na fatura do cartão do hóspede — reduz contestação por "não reconheço". */
const STATEMENT_DESCRIPTOR = 'STUDIO215';

function baseOrderBody(reservation: ReservationRow) {
  return {
    type: 'online',
    processing_mode: 'automatic',
    currency: 'BRL',
    total_amount: centsToAmount(reservation.totalCents),
    external_reference: reservation.id,
    description: `Studio 215 — ${reservation.checkIn} a ${reservation.checkOut}`,
    payer: payerFor(reservation),
    items: itemsFor(reservation),
    config: {
      statement_descriptor: STATEMENT_DESCRIPTOR,
      online: { callback_url: CALLBACK_URL },
    },
  };
}

export async function createPixOrder(
  reservation: ReservationRow,
  deviceId?: string
): Promise<OrderResponse> {
  assertAmountWithinLimit(reservation.totalCents);

  return new Order(mpClient).create({
    body: {
      ...baseOrderBody(reservation),
      transactions: {
        payments: [
          {
            amount: centsToAmount(reservation.totalCents),
            // Verificado empiricamente: a Orders API NÃO aceita
            // `date_of_expiration` aqui, e ignora `expiration_time` e
            // `config.default_payment_due_date` — o QR do Pix vem sempre
            // com 24h. Quem encurta isso pro prazo da reserva é o
            // cancelamento explícito da ordem no worker de expiração.
            payment_method: { id: 'pix', type: 'bank_transfer' },
          },
        ],
      },
    },
    requestOptions: {
      // Uma chave por reserva+método — reenvio da mesma requisição (retry de
      // rede, duplo clique) não cria uma segunda ordem no MP.
      idempotencyKey: `${reservation.id}:pix`,
      // Header X-Meli-Session-Id: identifica o dispositivo do comprador
      // pro antifraude do MP.
      ...(deviceId ? { meliSessionId: deviceId } : {}),
    },
  });
}

export interface CreateCardOrderInput {
  token: string;
  installments: number;
  paymentMethodId: string;
  deviceId?: string;
}

export async function createCardOrder(
  reservation: ReservationRow,
  input: CreateCardOrderInput
): Promise<OrderResponse> {
  assertAmountWithinLimit(reservation.totalCents);

  return new Order(mpClient).create({
    body: {
      ...baseOrderBody(reservation),
      // Só em cartão: `capture_mode` é conceito de cartão, e mandá-lo numa
      // ordem de Pix faz o MP validar o meio de pagamento contra o enum de
      // cartões e recusar `bank_transfer` (verificado na prática).
      // 'automatic' explícito porque 'automatic_async' abriria estado
      // intermediário de desafio (3DS) e quebraria o fast-path síncrono.
      capture_mode: 'automatic',
      transactions: {
        payments: [
          {
            amount: centsToAmount(reservation.totalCents),
            payment_method: {
              id: input.paymentMethodId,
              type: 'credit_card',
              token: input.token,
              installments: input.installments,
              statement_descriptor: STATEMENT_DESCRIPTOR,
            },
          },
        ],
      },
    },
    requestOptions: {
      // Inclui o token na chave — se o Brick gerar um token novo numa nova
      // tentativa, é uma cobrança genuinamente nova, não deve ser deduplicada.
      idempotencyKey: `${reservation.id}:card:${input.token}`,
      ...(input.deviceId ? { meliSessionId: input.deviceId } : {}),
    },
  });
}

export async function getOrder(mpOrderId: string): Promise<OrderResponse> {
  return new Order(mpClient).get({ id: mpOrderId });
}

/**
 * As três funções abaixo passam `requestOptions` sempre, mesmo quando não
 * precisariam: o SDK mescla as opções no objeto de config COMPARTILHADO
 * (`this.config.options = {...}`), então uma chamada sem opções herda a
 * idempotencyKey e o meliSessionId da chamada anterior — o que no estorno
 * automático significaria reusar a chave da criação do pagamento.
 */
export async function refundOrder(mpOrderId: string, reservationId: string): Promise<OrderResponse> {
  return new Order(mpClient).refund({
    id: mpOrderId,
    requestOptions: { idempotencyKey: `${reservationId}:refund` },
  });
}

export async function cancelOrder(mpOrderId: string, reservationId: string): Promise<OrderResponse> {
  return new Order(mpClient).cancel({
    id: mpOrderId,
    requestOptions: { idempotencyKey: `${reservationId}:cancel` },
  });
}

/**
 * `transactions.payments` é um array e pode acumular tentativas. Prefere a
 * que foi aprovada; senão, a última — nunca a primeira crua.
 */
export function relevantPayment(order: OrderResponse): OrderPaymentResponse | undefined {
  const payments = order.transactions?.payments ?? [];
  if (payments.length === 0) return undefined;
  return payments.find((p) => p.status === 'processed' || p.status === 'approved') ?? payments[payments.length - 1];
}

/** payment_method da ordem → nossa coluna payment_method (pix|credit_card). */
export function derivePaymentMethod(order: OrderResponse): 'pix' | 'credit_card' | null {
  const method = relevantPayment(order)?.payment_method;
  if (!method) return null;
  if (method.id === 'pix') return 'pix';
  if (method.type === 'credit_card') return 'credit_card';
  return null;
}
