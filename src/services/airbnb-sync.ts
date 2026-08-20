import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { airbnbSyncState } from '../db/schema.js';
import { config } from '../config.js';

export interface IcsRange {
  start: string;
  end: string;
}

/** Aceita tanto `db` quanto um `tx` de transaction — só precisa de `.select`. */
type Queryable = Pick<typeof db, 'select'>;

/**
 * Checagem just-in-time contra o calendário do Airbnb — não tem trava no banco
 * (diferente de reservation-vs-reservation, que a EXCLUDE constraint cobre),
 * por isso precisa ser checado explicitamente em todo lugar que decide
 * confirmar uma data. Usado na criação de reserva (routes/reservations.ts) e
 * no resgate de pagamento atrasado (services/payment-confirmation.ts).
 *
 * `freshRanges` permite passar um calendário recém-baixado do Airbnb em vez de
 * ler o snapshot do banco — é o que a criação de reserva faz, pra fechar a
 * janela entre o último sync do worker e o clique do hóspede. Passando null
 * (ou nada), cai no snapshot, que é o comportamento seguro por padrão.
 */
export async function checkAirbnbConflict(
  executor: Queryable,
  checkIn: string,
  checkOut: string,
  freshRanges?: IcsRange[] | null
): Promise<boolean> {
  let ranges = freshRanges;

  if (!ranges) {
    const syncRow = await executor
      .select({ rawRanges: airbnbSyncState.rawRanges })
      .from(airbnbSyncState)
      .where(eq(airbnbSyncState.id, 1))
      .limit(1);
    ranges = (syncRow[0]?.rawRanges as IcsRange[] | undefined) ?? [];
  }

  return ranges.some((r) => r.start < checkOut && r.end > checkIn);
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
 * Atualiza airbnb_sync_state com o calendário mais recente do Airbnb e devolve
 * as faixas baixadas — `null` quando a busca falhou, pra quem chamou saber que
 * está sem dado fresco e decidir o que fazer. Em caso de erro, NUNCA zera
 * raw_ranges — mantém o último dado bom e só marca o erro, pra uma falha
 * transitória do Airbnb não fazer o calendário inteiro parecer livre.
 *
 * `timeoutMs` é menor no caminho do hóspede (criação de reserva, que espera a
 * resposta) do que no worker, onde ninguém está esperando.
 */
export async function syncAirbnbCalendar(timeoutMs = 20_000): Promise<IcsRange[] | null> {
  if (!config.AIRBNB_ICS_URL) {
    console.warn('[airbnb-sync] AIRBNB_ICS_URL não definido — pulando.');
    return null;
  }

  try {
    const res = await fetch(config.AIRBNB_ICS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(timeoutMs),
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
    return ranges;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[airbnb-sync] falha ao sincronizar:', message);

    await db
      .update(airbnbSyncState)
      .set({ fetchStatus: 'error', lastError: message })
      .where(eq(airbnbSyncState.id, 1));

    return null;
  }
}
