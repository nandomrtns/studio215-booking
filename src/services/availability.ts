import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { airbnbSyncState, manualBlocks, reservations } from '../db/schema.js';

export interface BlockedRange {
  start: string;
  end: string;
  source: 'reservation' | 'manual_block' | 'airbnb';
}

interface AirbnbRawRange {
  start: string;
  end: string;
}

/**
 * Junta reservations (pending/confirmed) + manual_blocks + airbnb_sync_state
 * num único array de faixas bloqueadas, convenção [start, end) igual à usada
 * na constraint do banco e no parsing ICS. Usada tanto no GET /api/availability
 * quanto na checagem just-in-time dentro da criação de reserva — fonte única.
 */
export async function getMergedAvailability(from: string, to: string): Promise<BlockedRange[]> {
  const [activeReservations, blocks, syncRow] = await Promise.all([
    db
      .select({ checkIn: reservations.checkIn, checkOut: reservations.checkOut })
      .from(reservations)
      .where(
        and(
          inArray(reservations.status, ['pending', 'confirmed']),
          lt(reservations.checkIn, to),
          gt(reservations.checkOut, from)
        )
      ),
    db
      .select({ startDate: manualBlocks.startDate, endDate: manualBlocks.endDate })
      .from(manualBlocks)
      .where(and(lt(manualBlocks.startDate, to), gt(manualBlocks.endDate, from))),
    db
      .select({ rawRanges: airbnbSyncState.rawRanges })
      .from(airbnbSyncState)
      .where(eq(airbnbSyncState.id, 1))
      .limit(1),
  ]);

  const ranges: BlockedRange[] = [];

  for (const r of activeReservations) {
    ranges.push({ start: r.checkIn, end: r.checkOut, source: 'reservation' });
  }
  for (const b of blocks) {
    ranges.push({ start: b.startDate, end: b.endDate, source: 'manual_block' });
  }

  const airbnbRanges = (syncRow[0]?.rawRanges as AirbnbRawRange[] | undefined) ?? [];
  for (const r of airbnbRanges) {
    if (r.start < to && r.end > from) {
      ranges.push({ start: r.start, end: r.end, source: 'airbnb' });
    }
  }

  ranges.sort((a, b) => a.start.localeCompare(b.start));
  return ranges;
}

/** true se [checkIn, checkOut) esbarra em alguma faixa bloqueada da fonte dada. */
export function overlapsSource(
  ranges: BlockedRange[],
  checkIn: string,
  checkOut: string,
  source: BlockedRange['source']
): boolean {
  return ranges.some((r) => r.source === source && r.start < checkOut && r.end > checkIn);
}
