import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, gt, inArray, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { manualBlocks, reservations } from '../db/schema.js';
import { config } from '../config.js';

/**
 * Feed .ics de saída — o outro sentido do sync. O Airbnb importa esta URL e
 * passa a bloquear as datas vendidas aqui, fechando o ciclo com o
 * AIRBNB_ICS_URL que já lemos.
 *
 * A janela é assimétrica de propósito: o passado não interessa a quem importa
 * (só o futuro bloqueia venda), mas alguns dias pra trás evitam sumir com uma
 * estadia em curso do calendário.
 */
const PAST_DAYS = 7;
const FUTURE_DAYS = 540;

/** Só o que realmente ocupa o apartamento — mesma noção de "ativa" da disponibilidade. */
const OCCUPYING_STATUSES = ['pending', 'confirmed'];

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD -> YYYYMMDD (formato de DATE do iCalendar). */
function toIcsDate(iso: string): string {
  return iso.replace(/-/g, '');
}

function icsTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/**
 * Comparação em tempo constante — o token é o único segredo que protege este
 * feed, então não vale vazar o prefixo certo pelo tempo de resposta.
 */
function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface FeedEvent {
  uid: string;
  start: string;
  end: string;
  summary: string;
}

function buildIcs(events: FeedEvent[], now: Date): string {
  const stamp = icsTimestamp(now);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Studio 215//Booking//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Studio 215 — reservas diretas',
  ];

  for (const ev of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${toIcsDate(ev.start)}`,
      `DTEND;VALUE=DATE:${toIcsDate(ev.end)}`,
      `SUMMARY:${ev.summary}`,
      'TRANSP:OPAQUE',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');

  // iCalendar exige CRLF, e alguns importadores (o do Airbnb entre eles) são
  // rigorosos quanto a isso.
  return `${lines.join('\r\n')}\r\n`;
}

export async function calendarRoutes(app: FastifyInstance) {
  const feedToken = config.CALENDAR_FEED_TOKEN;
  if (!feedToken) return;

  app.get('/api/ics/studio215.ics', async (req, reply) => {
    const { token } = req.query as { token?: string };

    // 404 em vez de 401: sem token válido, o feed nem existe — não confirma
    // pra ninguém que essa URL é um calendário real.
    if (!tokenMatches(token, feedToken)) {
      return reply.status(404).send({ error: 'nao_encontrado' });
    }

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const from = addDaysIso(today, -PAST_DAYS);
    const to = addDaysIso(today, FUTURE_DAYS);

    // Consulta direta (em vez de reusar getMergedAvailability) por dois
    // motivos: o feed precisa do id de cada linha pra montar um UID estável —
    // UID que muda a cada busca faz o importador duplicar evento — e as faixas
    // vindas do próprio Airbnb têm que ficar de fora, senão devolvemos pra ele
    // o calendário que ele mesmo nos deu.
    const [activeReservations, blocks] = await Promise.all([
      db
        .select({
          id: reservations.id,
          checkIn: reservations.checkIn,
          checkOut: reservations.checkOut,
        })
        .from(reservations)
        .where(
          and(
            inArray(reservations.status, OCCUPYING_STATUSES),
            lt(reservations.checkIn, to),
            gt(reservations.checkOut, from)
          )
        ),
      db
        .select({
          id: manualBlocks.id,
          startDate: manualBlocks.startDate,
          endDate: manualBlocks.endDate,
        })
        .from(manualBlocks)
        .where(and(lt(manualBlocks.startDate, to), gt(manualBlocks.endDate, from))),
    ]);

    const events: FeedEvent[] = [
      ...activeReservations.map((r) => ({
        uid: `reservation-${r.id}@studio215poa.com.br`,
        start: r.checkIn,
        end: r.checkOut,
        // Sem nome, e-mail ou telefone do hóspede: o Airbnb guarda este
        // calendário e ele só precisa saber que a data está ocupada.
        summary: 'Reservado (site)',
      })),
      ...blocks.map((b) => ({
        uid: `manual-block-${b.id}@studio215poa.com.br`,
        start: b.startDate,
        end: b.endDate,
        summary: 'Bloqueado',
      })),
    ];

    events.sort((a, b) => a.start.localeCompare(b.start));

    return reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="studio215.ics"')
      .header('Cache-Control', 'no-cache, max-age=0')
      .send(buildIcs(events, now));
  });
}
