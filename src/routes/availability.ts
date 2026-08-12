import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { airbnbSyncState, pricingRules } from '../db/schema.js';
import { getMergedAvailability } from '../services/availability.js';

const DEFAULT_WINDOW_DAYS = 180;
const MAX_WINDOW_DAYS = 400;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function availabilityRoutes(app: FastifyInstance) {
  app.get('/api/availability', async (req, reply) => {
    const query = req.query as { from?: string; to?: string };

    const from = query.from ?? todayIso();
    let to = query.to ?? addDaysIso(from, DEFAULT_WINDOW_DAYS);

    const maxTo = addDaysIso(from, MAX_WINDOW_DAYS);
    if (to > maxTo) to = maxTo;

    const [blockedRanges, syncRow, defaultRule] = await Promise.all([
      getMergedAvailability(from, to),
      db
        .select({ lastFetchedAt: airbnbSyncState.lastFetchedAt })
        .from(airbnbSyncState)
        .where(eq(airbnbSyncState.id, 1))
        .limit(1),
      db
        .select({ minNights: pricingRules.minNights })
        .from(pricingRules)
        .limit(1),
    ]);

    return reply.send({
      from,
      to,
      blocked_ranges: blockedRanges,
      min_nights: defaultRule[0]?.minNights ?? 1,
      last_airbnb_sync: syncRow[0]?.lastFetchedAt ?? null,
    });
  });
}
