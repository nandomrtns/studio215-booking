export const RESERVATION_HOLD_MINUTES = 30;

/**
 * Folga extra além do expires_at normal antes do worker expirar uma reserva
 * de vez — rede de segurança pra webhook do Mercado Pago atrasado, não o
 * mecanismo principal (esse é o date_of_expiration do Pix, igual ao
 * expires_at da reserva).
 */
export const PAYMENT_EXPIRY_GRACE_MINUTES = 10;

/** "Máximo de 3 hóspedes" — do anúncio real. */
export const MAX_GUESTS = 3;

/** Chave do lock consultivo global — uma propriedade só, um calendário só. */
export const ADVISORY_LOCK_KEY = 'studio215:reservation';

/** Código de erro do Postgres pra "exclusion_violation" (a trava de overbooking). */
export const PG_EXCLUSION_VIOLATION = '23P01';
