/**
 * Estrutura da política de cancelamento — placeholder até o Nando confirmar o
 * texto exato que já está configurado no Airbnb pra este anúncio (decisão de
 * negócio: "espelhar a mesma lógica do Airbnb").
 *
 * O formato abaixo cobre os três perfis que o Airbnb usa (flexível/moderada/
 * rígida) pra já sair compatível assim que soubermos qual dos três — ou uma
 * variação customizada — está ativo. Cada reserva grava uma cópia deste objeto
 * em `cancellation_policy_snapshot` no momento da criação, então mudanças aqui
 * nunca afetam retroativamente reservas já feitas.
 */

export type CancellationTier = 'flexivel' | 'moderada' | 'rigida';

export interface CancellationPolicy {
  tier: CancellationTier;
  /** Descrição curta, em português, pra mostrar no checkout antes do pagamento. */
  summary: string;
  /** Regras em ordem — a primeira que bater com o momento do cancelamento vale. */
  rules: {
    /** Cancelar até N dias antes do check-in. */
    daysBeforeCheckIn: number;
    refundPercent: number;
  }[];
}

// TODO(Fase 1): substituir por print/texto exato do Airbnb assim que o Nando mandar.
// Placeholder atual segue a política "Moderada" padrão do Airbnb, só como exemplo
// de formato — os números abaixo NÃO estão confirmados.
export const CANCELLATION_POLICY: CancellationPolicy = {
  tier: 'moderada',
  summary:
    'Reembolso integral se cancelar até 5 dias antes do check-in. Depois disso, ' +
    'reembolso de 50% até 24h antes. Sem reembolso após o check-in.',
  rules: [
    { daysBeforeCheckIn: 5, refundPercent: 100 },
    { daysBeforeCheckIn: 1, refundPercent: 50 },
    { daysBeforeCheckIn: 0, refundPercent: 0 },
  ],
};
