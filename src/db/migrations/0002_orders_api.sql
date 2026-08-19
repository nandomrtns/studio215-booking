-- Migração da integração de pagamento para a Orders API do Mercado Pago.
--
-- SQL manual, mesmo padrão do 0000_init.sql (ver comentário no topo daquele
-- arquivo pro porquê).
--
-- Motivo da migração: no Brasil (MLB), aplicações novas não têm permissão de
-- criar pagamento pela rota clássica POST /v1/payments — retorna
-- 403 PA_UNAUTHORIZED_RESULT_FROM_POLICIES. A rota suportada é POST /v1/orders.
--
-- Consequência para o schema: agora existem DOIS identificadores por
-- cobrança — o da ordem (ORD...) e o do pagamento dentro dela (PAY...).
-- O webhook entrega o da ordem; o estorno também é pela ordem. Mas o id do
-- pagamento é o que aparece no extrato e o que o suporte do MP pede, então
-- vale guardar os dois. Tudo aditivo: nada é removido ou renomeado, pra que
-- reverter o deploy não quebre o serviço.

alter table reservations add column if not exists mp_order_id text;

-- Não há caminho quente que busque reserva por esse id (o applyOrderResult
-- acha a reserva pelo external_reference da ordem). O índice existe para
-- conciliação, suporte e o painel admin da Fase 4.
create index if not exists reservations_mp_order_id_idx
  on reservations (mp_order_id) where mp_order_id is not null;

alter table webhook_events add column if not exists mp_order_id text;

create index if not exists webhook_events_mp_order_id_idx
  on webhook_events (mp_order_id);

-- A notificação da Orders API traz o id da ordem, não o do pagamento, então
-- mp_payment_id passa a poder ficar vazio no registro do evento.
alter table webhook_events alter column mp_payment_id drop not null;

-- Normaliza o vocabulário de status gravado em reservations. A Orders API usa
-- outros valores que os da API antiga, e o código passa a gravar o status cru
-- da ordem. As linhas existentes são todas de teste em sandbox, mas alinhar
-- evita que o worker de expiração leia um vocabulário e o resto do sistema
-- outro.
update reservations set mp_payment_status = 'action_required'
  where mp_payment_status in ('pending', 'in_process');
update reservations set mp_payment_status = 'processed'
  where mp_payment_status = 'approved';
update reservations set mp_payment_status = 'failed'
  where mp_payment_status in ('rejected', 'cancelled');
