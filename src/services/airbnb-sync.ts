import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { airbnbSyncState } from '../db/schema.js';
import { config } from '../config.js';

interface IcsRange {
  start: string;
  end: string;
}

function parseIcsDate(value: string): string {
  // VALUE=DATE vem como YYYYMMDD
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/** Mesmo parsing que site/scripts/sync_calendar.py fazia, portado pra TS. */
export function extractIcsRanges(icsText: string): IcsRange[] {
  const ranges: IcsRange[] = [];

  for (const block of icsText.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const startMatch = body.match(/DTSTART(?:;VALUE=DATE)?:(\d{8})/);
    const endMatch = body.match(/DTEND(?:;VALUE=DATE)?:(\d{8})/);
    if (startMatch && endMatch) {
      ranges.push({ start: parseIcsDate(startMatch[1]), end: parseIcsDate(endMatch[1]) });
    }
  }

  ranges.sort((a, b) => a.start.localeCompare(b.start));
  return ranges;
}

/**
 * Atualiza airbnb_sync_state com o calendário mais recente do Airbnb. Em caso
 * de erro, NUNCA zera raw_ranges — mantém o último dado bom e só marca o
 * erro, pra uma falha transitória do Airbnb não fazer o calendário inteiro
 * parecer livre.
 */
export async function syncAirbnbCalendar(): Promise<void> {
  if (!config.AIRBNB_ICS_URL) {
    console.warn('[airbnb-sync] AIRBNB_ICS_URL não definido — pulando.');
    return;
  }

  try {
    const res = await fetch(config.AIRBNB_ICS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ao buscar iCal do Airbnb`);
    }

    const icsText = await res.text();
    const ranges = extractIcsRanges(icsText);

    await db
      .update(airbnbSyncState)
      .set({
        rawRanges: ranges,
        lastFetchedAt: new Date(),
        fetchStatus: 'ok',
        lastError: null,
      })
      .where(eq(airbnbSyncState.id, 1));

    console.log(`[airbnb-sync] ${ranges.length} períodos ocupados sincronizados.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[airbnb-sync] falha ao sincronizar:', message);

    await db
      .update(airbnbSyncState)
      .set({ fetchStatus: 'error', lastError: message })
      .where(eq(airbnbSyncState.id, 1));
  }
}
