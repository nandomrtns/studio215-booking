import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pricingRules } from '../db/schema.js';

export interface PricingRule {
  nightlyRateCents: number;
  cleaningFeeCents: number;
  minNights: number;
}

export interface Quote extends PricingRule {
  nights: number;
  totalCents: number;
  currency: 'BRL';
}

/**
 * Pega a regra de preço que vale pro range pedido — prefere uma linha com
 * janela de data específica sobre a linha padrão (start_date/end_date nulos).
 * Hoje só existe a linha padrão (diária R$210, limpeza R$125, mínimo 2
 * noites), mas o schema já suporta sazonalidade futura sem migração nova.
 */
export async function findApplicableRule(checkIn: string, checkOut: string): Promise<PricingRule | null> {
  const rows = await db
    .select({
      nightlyRateCents: pricingRules.nightlyRateCents,
      cleaningFeeCents: pricingRules.cleaningFeeCents,
      minNights: pricingRules.minNights,
    })
    .from(pricingRules)
    .where(
      sql`(${pricingRules.startDate} is null or ${pricingRules.startDate} <= ${checkIn})
        and (${pricingRules.endDate} is null or ${pricingRules.endDate} >= ${checkOut})`
    )
    .orderBy(sql`(${pricingRules.startDate} is not null) desc`)
    .limit(1);

  return rows[0] ?? null;
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const inDate = new Date(`${checkIn}T00:00:00Z`);
  const outDate = new Date(`${checkOut}T00:00:00Z`);
  return Math.round((outDate.getTime() - inDate.getTime()) / 86_400_000);
}

export function computeQuote(rule: PricingRule, nights: number): Quote {
  return {
    ...rule,
    nights,
    totalCents: rule.nightlyRateCents * nights + rule.cleaningFeeCents,
    currency: 'BRL',
  };
}
