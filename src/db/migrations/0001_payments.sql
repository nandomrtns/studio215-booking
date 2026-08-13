-- Fase 3 — pagamento via Mercado Pago.
--
-- SQL manual, mesmo padrão do 0000_init.sql (ver comentário no topo daquele
-- arquivo pro porquê).

-- O webhook só recebe o mp_payment_id; precisa achar a reserva rápido.
create index if not exists reservations_mp_payment_id_idx
  on reservations (mp_payment_id) where mp_payment_id is not null;

-- Dedupe de notificação por id do EVENTO (não do pagamento — um mesmo
-- mp_payment_id recebe várias notificações legítimas ao longo da vida do
-- pagamento: created, depois updated quando aprova, talvez outra se
-- estornar). O id do evento é o campo `id` de topo do corpo JSON do webhook,
-- não `data.id` (que é o id do pagamento, esse sim guardado em mp_payment_id).
alter table webhook_events add column if not exists mp_notification_id text;

create unique index if not exists webhook_events_mp_notification_id_idx
  on webhook_events (mp_notification_id) where mp_notification_id is not null;
