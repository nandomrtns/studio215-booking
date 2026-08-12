export const RESERVATION_HOLD_MINUTES = 30;

/** "Máximo de 3 hóspedes" — do anúncio real. */
export const MAX_GUESTS = 3;

/** Chave do lock consultivo global — uma propriedade só, um calendário só. */
export const ADVISORY_LOCK_KEY = 'studio215:reservation';

/** Código de erro do Postgres pra "exclusion_violation" (a trava de overbooking). */
export const PG_EXCLUSION_VIOLATION = '23P01';
