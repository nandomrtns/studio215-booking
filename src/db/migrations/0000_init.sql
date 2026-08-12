-- Fase 1 — schema inicial do booking-service.
--
-- Escrita à mão em vez de gerada pelo drizzle-kit porque as EXCLUDE constraints
-- (a trava real contra overbooking, no banco) não têm representação no DSL do
-- Drizzle. src/db/schema.ts continua sendo a fonte de tipos TypeScript pro app;
-- este arquivo é a fonte de verdade do DDL.

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "btree_gist"; -- exclusion constraint em daterange

create table if not exists reservations (
  id                    uuid primary key default gen_random_uuid(),
  status                text not null default 'pending'
                          check (status in ('pending','confirmed','cancelled','expired','confirmed_conflict','refunded')),
  check_in              date not null,
  check_out             date not null,

  guest_name            text not null,
  guest_email           text not null,
  guest_phone           text not null,
  guest_document        text,
  guest_count           int not null default 1,

  nightly_rate_cents    int not null,
  cleaning_fee_cents    int not null,
  total_cents           int not null,
  currency              text not null default 'BRL',

  payment_method        text check (payment_method is null or payment_method in ('pix','credit_card')),
  mp_preference_id      text,
  mp_payment_id         text,
  mp_payment_status     text,

  cancellation_policy_snapshot jsonb not null,

  expires_at            timestamptz,
  admin_notes           text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint reservations_check_in_before_check_out check (check_in < check_out),

  exclude using gist (
    daterange(check_in, check_out, '[)') with &&
  ) where (status in ('pending', 'confirmed'))
);

create index if not exists reservations_status_idx on reservations (status);

create table if not exists manual_blocks (
  id           uuid primary key default gen_random_uuid(),
  start_date   date not null,
  end_date     date not null,
  reason       text not null,
  created_by   text not null default 'nando',
  created_at   timestamptz not null default now(),

  constraint manual_blocks_start_before_end check (start_date < end_date),

  exclude using gist (daterange(start_date, end_date, '[)') with &&)
);

create table if not exists airbnb_sync_state (
  id              int primary key default 1,
  last_fetched_at timestamptz,
  raw_ranges      jsonb not null default '[]'::jsonb,
  fetch_status    text not null default 'ok',
  last_error      text,

  constraint airbnb_sync_state_singleton check (id = 1)
);

-- Garante que a linha singleton já existe, pra services/airbnb-sync.ts (Fase 2)
-- poder sempre fazer UPDATE em vez de precisar de um upsert condicional.
insert into airbnb_sync_state (id) values (1) on conflict (id) do nothing;

create table if not exists pricing_rules (
  id                  uuid primary key default gen_random_uuid(),
  start_date          date,
  end_date            date,
  nightly_rate_cents  int not null,
  cleaning_fee_cents  int not null,
  min_nights          int not null default 2,
  created_at          timestamptz not null default now()
);

create table if not exists webhook_events (
  id             uuid primary key default gen_random_uuid(),
  mp_payment_id  text not null,
  event_type     text,
  payload        jsonb not null,
  received_at    timestamptz not null default now(),
  processed      boolean not null default false
);

create index if not exists webhook_events_mp_payment_id_idx on webhook_events (mp_payment_id);
