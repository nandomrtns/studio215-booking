/**
 * Política de cancelamento — espelha o que está configurado no anúncio real do
 * Airbnb, confirmado direto no painel do anúncio em 12/08/2026 (texto exato,
 * não estimativa): "Limitada" pra estadias curtas (menos de 28 noites — a
 * grande maioria das reservas diretas), "Rigorosa" pra estadias longas (28+
 * noites — o perfil tipo Carlos, do DNA da marca).
 *
 * As duas políticas têm FORMATOS DE REGRA DIFERENTES, não só números
 * diferentes — por isso são dois tipos distintos abaixo, não uma tabela genérica:
 *   - Limitada: reembolso varia por faixa de "dias antes do check-in".
 *   - Rigorosa: reembolso integral só numa janela de carência (48h da reserva
 *     E 28+ dias antes do check-in); fora dela, os primeiros 30 dias da
 *     estadia não são reembolsáveis — não é uma faixa de percentual.
 *
 * Cada reserva grava uma cópia do objeto retornado por `getCancellationPolicy()`
 * em `cancellation_policy_snapshot` no momento da criação, então mudanças aqui
 * nunca afetam retroativamente reservas já feitas.
 */

const LONG_STAY_THRESHOLD_NIGHTS = 28;

export interface LimitedPolicy {
  tier: 'limitada_curta';
  summary: string;
  /** Regras em ordem — a primeira que bater com o momento do cancelamento vale. */
  rules: { daysBeforeCheckIn: number; refundPercent: number }[];
}

export interface LongStayPolicy {
  tier: 'rigorosa_longa';
  summary: string;
  /** Reembolso integral só se as duas condições abaixo forem verdadeiras. */
  graceWindow: {
    hoursAfterBooking: number;
    minDaysBeforeCheckIn: number;
  };
  /** Fora da janela de carência: quantas noites do INÍCIO da estadia não são reembolsáveis. */
  nonRefundableNightsAfterGrace: number;
}

export type CancellationPolicy = LimitedPolicy | LongStayPolicy;

/** Política "Limitada" — confirmada no painel do Airbnb. Estadias de menos de 28 noites. */
export const LIMITED_POLICY: LimitedPolicy = {
  tier: 'limitada_curta',
  summary:
    'Reembolso integral se cancelar até 14 dias antes do check-in. Reembolso de ' +
    '50% se cancelar entre 7 e 14 dias antes. Sem reembolso se cancelar com ' +
    'menos de 7 dias de antecedência.',
  rules: [
    { daysBeforeCheckIn: 14, refundPercent: 100 },
    { daysBeforeCheckIn: 7, refundPercent: 50 },
    { daysBeforeCheckIn: 0, refundPercent: 0 },
  ],
};

/** Política "Rigorosa" — confirmada no painel do Airbnb. Estadias de 28+ noites. */
export const LONG_STAY_POLICY: LongStayPolicy = {
  tier: 'rigorosa_longa',
  summary:
    'Estadias de 28 noites ou mais: reembolso integral só se cancelar em até ' +
    '48h da confirmação da reserva E com pelo menos 28 dias de antecedência do ' +
    'check-in. Fora dessa janela, os primeiros 30 dias da estadia não são ' +
    'reembolsáveis.',
  graceWindow: {
    hoursAfterBooking: 48,
    minDaysBeforeCheckIn: 28,
  },
  nonRefundableNightsAfterGrace: 30,
};

export function getCancellationPolicy(nights: number): CancellationPolicy {
  return nights >= LONG_STAY_THRESHOLD_NIGHTS ? LONG_STAY_POLICY : LIMITED_POLICY;
}

/**
 * Airbnb oferece "Opção não reembolsável" (10% de desconto, sem reembolso em
 * qualquer cancelamento) pra estadias curtas — confirmado ativado no anúncio
 * real. Ainda não implementado no checkout desta fase; fica documentado aqui
 * pra a Fase 2/3 decidir se replica essa opção como escolha do hóspede.
 */
export const NON_REFUNDABLE_DISCOUNT_PERCENT = 10;
