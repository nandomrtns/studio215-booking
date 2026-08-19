export const RESERVATION_HOLD_MINUTES = 30;

/**
 * Folga extra além do expires_at normal antes do worker expirar uma reserva
 * de vez — rede de segurança pra webhook do Mercado Pago atrasado.
 *
 * A Orders API não deixa definir o vencimento do Pix: o QR vem sempre com
 * 24h e os campos de expiração (`date_of_expiration`, `expiration_time`,
 * `config.default_payment_due_date`) são recusados ou ignorados — verificado
 * na prática. Quem alinha o QR ao prazo da reserva é o cancelamento explícito
 * da ordem, em services/reservation-expiry.ts.
 */
export const PAYMENT_EXPIRY_GRACE_MINUTES = 10;

/** "Máximo de 3 hóspedes" — do anúncio real. */
export const MAX_GUESTS = 3;

/** Chave do lock consultivo global — uma propriedade só, um calendário só. */
export const ADVISORY_LOCK_KEY = 'studio215:reservation';

/** Código de erro do Postgres pra "exclusion_violation" (a trava de overbooking). */
export const PG_EXCLUSION_VIOLATION = '23P01';

/**
 * A Orders API responde 402 quando o emissor recusa o cartão — é recusa de
 * pagamento, não erro de sistema. (A API antiga devolvia 201 com status
 * 'rejected'.)
 */
export const PAYMENT_REJECTED_STATUS = 402;
