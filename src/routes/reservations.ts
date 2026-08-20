import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reservations } from '../db/schema.js';
import { createReservationSchema } from '../schemas/reservation.js';
import { computeQuote, findApplicableRule, nightsBetween } from '../services/pricing.js';
import { checkAirbnbConflict, syncAirbnbCalendar } from '../services/airbnb-sync.js';
import { getCancellationPolicy } from '../config/cancellation-policy.js';
import { ADVISORY_LOCK_KEY, PG_EXCLUSION_VIOLATION, RESERVATION_HOLD_MINUTES } from '../constants.js';

/**
 * Timeout curto: aqui tem um hóspede esperando a resposta. Se o Airbnb não
 * responder nesse prazo, a checagem cai no snapshot do worker (<= 5 min) em
 * vez de fazer o hóspede esperar.
 */
const AIRBNB_FETCH_TIMEOUT_MS = 6_000;

function reservationResponse(row: typeof reservations.$inferSelect) {
  return {
    id: row.id,
    status: row.status,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    guestCount: row.guestCount,
    nightlyRateCents: row.nightlyRateCents,
    cleaningFeeCents: row.cleaningFeeCents,
    totalCents: row.totalCents,
    currency: row.currency,
    paymentMethod: row.paymentMethod,
    mpPaymentStatus: row.mpPaymentStatus,
    cancellationPolicy: row.cancellationPolicySnapshot,
    expiresAt: row.expiresAt,
  };
}

export async function reservationRoutes(app: FastifyInstance) {
  app.post(
    '/api/reservations',
    {
      // Única rota que trava uma data de verdade — limite bem mais apertado
      // que o global (300/min) definido em app.ts.
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    },
    async (req, reply) => {
      const parsed = createReservationSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(422).send({ error: 'validacao', issues: parsed.error.flatten() });
      }

      const input = parsed.data;
      const nights = nightsBetween(input.checkIn, input.checkOut);

      // Calendário do Airbnb buscado na hora, e não o snapshot do worker (até
      // 5 min velho): esse intervalo é exatamente onde uma reserva feita no
      // Airbnb viraria dupla reserva aqui. Fora da transaction de propósito —
      // não segurar o lock consultivo durante I/O de rede. Devolve null se
      // falhar, e aí a checagem abaixo usa o snapshot.
      const freshAirbnbRanges = await syncAirbnbCalendar(AIRBNB_FETCH_TIMEOUT_MS);

      try {
        const row = await db.transaction(async (tx) => {
          // Serializa qualquer criação de reserva concorrente — uma
          // propriedade só, um calendário só, um lock global é suficiente.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK_KEY}))`);

          const rule = await findApplicableRule(input.checkIn, input.checkOut);
          if (!rule) {
            throw Object.assign(new Error('sem_regra_de_preco'), { statusCode: 500 });
          }
          if (nights < rule.minNights) {
            throw Object.assign(new Error('estadia_minima'), {
              statusCode: 422,
              payload: { error: 'estadia_minima', minNights: rule.minNights },
            });
          }

          // Checagem just-in-time só contra o Airbnb: conflito com reservas
          // ou bloqueios manuais já é pego com certeza pela exclusion
          // constraint no insert abaixo. O Airbnb não tem trava no banco, por
          // isso a checagem explícita aqui — precisa acontecer DENTRO do
          // lock pra valer algo.
          const airbnbConflict = await checkAirbnbConflict(
            tx,
            input.checkIn,
            input.checkOut,
            freshAirbnbRanges
          );
          if (airbnbConflict) {
            throw Object.assign(new Error('indisponivel'), {
              statusCode: 409,
              payload: { error: 'indisponivel', conflictSource: 'airbnb' },
            });
          }

          const quote = computeQuote(rule, nights);
          const policy = getCancellationPolicy(nights);
          const expiresAt = new Date(Date.now() + RESERVATION_HOLD_MINUTES * 60_000);

          const [inserted] = await tx
            .insert(reservations)
            .values({
              checkIn: input.checkIn,
              checkOut: input.checkOut,
              guestName: input.guestName,
              guestEmail: input.guestEmail,
              guestPhone: input.guestPhone,
              guestDocument: input.guestDocument,
              guestCount: input.guestCount,
              nightlyRateCents: quote.nightlyRateCents,
              cleaningFeeCents: quote.cleaningFeeCents,
              totalCents: quote.totalCents,
              cancellationPolicySnapshot: policy,
              expiresAt,
            })
            .returning();

          return inserted;
        });

        return reply.status(201).send(reservationResponse(row));
      } catch (err) {
        const anyErr = err as {
          statusCode?: number;
          payload?: unknown;
          code?: string;
          cause?: { code?: string };
          message?: string;
        };

        if (anyErr.statusCode && anyErr.payload) {
          return reply.status(anyErr.statusCode).send(anyErr.payload);
        }
        // Drizzle envolve o erro do driver num DrizzleQueryError — o código
        // real do Postgres (23P01 = exclusion_violation) vem em `.cause`, não
        // na raiz do erro.
        if (anyErr.code === PG_EXCLUSION_VIOLATION || anyErr.cause?.code === PG_EXCLUSION_VIOLATION) {
          return reply.status(409).send({ error: 'indisponivel', conflictSource: 'reservation' });
        }

        req.log.error(err, 'falha ao criar reserva');
        return reply.status(500).send({ error: 'erro_interno' });
      }
    }
  );

  app.get('/api/reservations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const rows = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!rows[0]) {
      return reply.status(404).send({ error: 'nao_encontrada' });
    }

    return reply.send(reservationResponse(rows[0]));
  });
}
