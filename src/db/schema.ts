import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  date,
  timestamp,
  jsonb,
  boolean,
  check,
} from 'drizzle-orm/pg-core';

/**
 * Reserva do hóspede. Dados de hóspede ficam embutidos aqui (sem tabela `guests`
 * separada) de propósito — minimiza o raio de uma exclusão de dados por LGPD: uma
 * linha é o blast radius inteiro.
 *
 * A constraint de exclusão (ver migration SQL) impede duas linhas com datas
 * sobrepostas em status pending/confirmed — trava no banco, não só na aplicação.
 */
export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    status: text('status').notNull().default('pending'),
    checkIn: date('check_in').notNull(),
    checkOut: date('check_out').notNull(),

    guestName: text('guest_name').notNull(),
    guestEmail: text('guest_email').notNull(),
    guestPhone: text('guest_phone').notNull(),
    guestDocument: text('guest_document'),
    guestCount: integer('guest_count').notNull().default(1),

    nightlyRateCents: integer('nightly_rate_cents').notNull(),
    cleaningFeeCents: integer('cleaning_fee_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    currency: text('currency').notNull().default('BRL'),

    paymentMethod: text('payment_method'),
    mpPreferenceId: text('mp_preference_id'),
    mpPaymentId: text('mp_payment_id'),
    mpPaymentStatus: text('mp_payment_status'),

    cancellationPolicySnapshot: jsonb('cancellation_policy_snapshot').notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true }),
    adminNotes: text('admin_notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'reservations_status_check',
      sql`${table.status} in ('pending','confirmed','cancelled','expired','confirmed_conflict','refunded')`
    ),
    check(
      'reservations_payment_method_check',
      sql`${table.paymentMethod} is null or ${table.paymentMethod} in ('pix','credit_card')`
    ),
  ]
);

/** Bloqueios manuais do Nando (uso pessoal, manutenção) — mesma trava de sobreposição. */
export const manualBlocks = pgTable('manual_blocks', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  reason: text('reason').notNull(),
  createdBy: text('created_by').notNull().default('nando'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Linha única (id sempre 1) com o snapshot mais recente do calendário do Airbnb.
 * Substitui o papel do assets/availability.json atual — a partir da Fase 2, o
 * booking-service passa a ser a fonte de verdade, não a GitHub Action do site.
 */
export const airbnbSyncState = pgTable(
  'airbnb_sync_state',
  {
    id: integer('id').primaryKey().default(1),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    rawRanges: jsonb('raw_ranges').notNull().default(sql`'[]'::jsonb`),
    fetchStatus: text('fetch_status').notNull().default('ok'),
    lastError: text('last_error'),
  },
  (table) => [check('airbnb_sync_state_singleton', sql`${table.id} = 1`)]
);

/** Diária/taxa de limpeza/estadia mínima. Janela de data nula = regra padrão. */
export const pricingRules = pgTable('pricing_rules', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  startDate: date('start_date'),
  endDate: date('end_date'),
  nightlyRateCents: integer('nightly_rate_cents').notNull(),
  cleaningFeeCents: integer('cleaning_fee_cents').notNull(),
  minNights: integer('min_nights').notNull().default(2),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Log de idempotência dos webhooks do Mercado Pago. `mpNotificationId` é o
 * `id` de topo do corpo do webhook (o id do EVENTO, não do pagamento — um
 * mesmo pagamento gera várias notificações ao longo da vida dele) com unique
 * index parcial pra dedupe de reentrega (ver migration 0001).
 */
export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  mpPaymentId: text('mp_payment_id').notNull(),
  mpNotificationId: text('mp_notification_id'),
  eventType: text('event_type'),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processed: boolean('processed').notNull().default(false),
});
