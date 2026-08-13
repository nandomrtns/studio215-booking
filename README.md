# studio215-booking

Backend de reserva direta do Studio 215 — Fastify + Drizzle + Postgres, deployado
no Railway. Serviço separado do site (`studio215-site`, que continua estático no
GitHub Pages sem nenhuma mudança).

**Estado atual: Fase 3 em andamento.** Fases 1 e 2 completas e em produção
(motor de reservas, calendário sincronizado com o Airbnb, expiração
automática). O código da Fase 3 (pagamento via Mercado Pago) já está pronto e
commitado, mas ainda não testado ponta a ponta — falta credencial de teste do
Mercado Pago. Ver [Roadmap](#roadmap) abaixo pro estado exato e os próximos
passos.

## Rodar localmente

Requisitos: Node 20+, um Postgres acessível (local, Docker, ou o do Railway).

```bash
npm install
cp .env.example .env
# edite .env — pelo menos DATABASE_URL precisa apontar pra um Postgres real

npm run db:migrate   # aplica src/db/migrations/*.sql
npm run dev           # sobe o servidor em http://localhost:3000

curl http://localhost:3000/api/health
# {"status":"ok","db":"ok","time":"..."}
```

Pra rodar o worker (ainda sem cron jobs reais nesta fase, só prova que sobe):

```bash
npm run dev:worker
```

## Deploy no Railway (passo a passo)

Isso precisa ser feito pela conta do Nando — o Claude Code não consegue criar
conta ou projeto no Railway por fora.

1. Crie uma conta em [railway.app](https://railway.app) (dá pra usar login com o
   GitHub `nandomrtns`, mesmo login já usado no `studio215-site`)
2. **New Project → Deploy from GitHub repo** → selecione
   `nandomrtns/studio215-booking`
3. No mesmo projeto, **+ New → Database → Add PostgreSQL** — o Railway já injeta
   `DATABASE_URL` automaticamente nos outros serviços do projeto
4. No serviço criado a partir do repo, configure duas coisas em **Settings**:
   - **Variables**: cole o valor de `AIRBNB_ICS_URL` (o mesmo secret que já existe
     hoje no repo `studio215-site`, em Settings → Secrets do GitHub) — ainda não é
     usado nesta fase, mas já deixa configurado
   - **Deploy → Start Command**: `node dist/server.js` (esse é o serviço `api`)
5. Duplique o serviço (ou crie um segundo apontando pro mesmo repo) só trocando o
   **Start Command** pra `node dist/worker.js` — esse é o serviço `worker`
6. Depois do primeiro deploy, rode a migração contra o banco do Railway uma vez
   (com `DATABASE_URL` do Railway copiado pro seu `.env` local):
   ```bash
   npm run db:migrate
   ```
7. Confirme: `curl https://<url-gerada-pelo-railway>/api/health` deve responder
   `200 {"status":"ok",...}` a partir da internet, não só do seu computador.

A partir daqui, todo `git push` no repo faz o Railway rebuildar e redeployar os
dois serviços automaticamente — mesmo modelo de "push pra publicar" que o site já
usa com o GitHub Pages.

## Variáveis de ambiente

Ver `.env.example` — comentado, com o que já é usado hoje e o que só entra na
Fase 4 (token do calendário de saída, login do admin).

## Roadmap

### Fase 1 — Esqueleto ✅

`/api/health`, schema do banco (6 tabelas), migration com as EXCLUDE
constraints que travam overbooking no próprio Postgres.

### Fase 2 — Motor de reservas ✅

Disponibilidade combinada (reservas + bloqueios manuais + calendário do
Airbnb sincronizado), cálculo de preço, criação de pré-reserva com lock
consultivo + trava de overbooking, expiração automática de reserva pendente
sem pagamento.

### Fase 3 — Pagamento via Mercado Pago 🚧 em andamento

Checkout Transparente (Pix e cartão, sem redirecionar o hóspede pro site do
MP). Código completo no backend (`routes/payments.ts`, `routes/webhooks.ts`,
`services/payment-confirmation.ts`) e no frontend (`site/assets/js/booking.js`
— escolha de método, QR do Pix, Card Payment Brick) — commits `5cc83a0`
(booking-service) e `76d3ff9` (site), já publicados no GitHub.

**Decisões de negócio já tomadas e implementadas:**
- Pagamento aprovado que chega atrasado (reserva já expirou) e a data segue
  livre → resgata pra `confirmed` em vez de tratar como conflito.
- Conflito real de data → estorno automático via API do MP, sem esperar ação
  manual.
- `?preview=1` no site continua travando o botão de reservar pro público
  geral até o primeiro pagamento real supervisionado (ver Fase E abaixo).

**O que falta, em ordem:**

- [ ] **A — Credenciais de teste.** Nando cria a Aplicação no [painel de
      desenvolvedores do MP](https://www.mercadopago.com.br/developers/panel),
      pega `MP_ACCESS_TOKEN`/`MP_PUBLIC_KEY` de teste (prefixo `TEST-`) e
      cadastra o webhook (`https://studio215-booking-production.up.railway.app/api/webhooks/mercadopago`,
      evento Pagamentos) pra gerar o `MP_WEBHOOK_SECRET`.
- [ ] **B — Testar em sandbox.** Com as 3 env vars de teste no Railway, testar
      Pix (QR real + aprovação simulada) e cartão (cartões de teste do MP:
      aprovado/recusado/pendente) ponta a ponta, confirmando que a reserva
      vira `confirmed` no banco pelos dois caminhos.
- [ ] **C — Conta pronta pra receber de verdade.** Fora do código: identidade
      verificada e conta bancária vinculada na conta MP do Nando (Configurações
      → Conta bancária/Saques no painel MP), pra o saque não ficar retido.
- [ ] **D — Produção.** Gerar credenciais de produção no painel MP, registrar
      o mesmo webhook em modo produção (assinatura secreta é diferente da de
      teste), trocar as 3 env vars no Railway e o `MP_PUBLIC_KEY` em
      `booking.js`, publicar o site.
- [ ] **E — Primeiro pagamento real supervisionado.** Nando faz uma reserva de
      verdade via `?preview=1` (Pix de valor baixo ou cartão próprio) pra
      confirmar que o dinheiro cai na conta MP. Só depois disso remove o gate
      `PREVIEW_MODE` e abre pro público geral.

### Fase 4 — Painel admin e .ics de saída — ainda não iniciada

Login único (senha, sem tabela de usuários — `ADMIN_PASSWORD_HASH`/
`ADMIN_JWT_SECRET` já reservados em `.env.example`), visão das reservas e
bloqueios manuais pelo Nando, e feed `.ics` (`CALENDAR_FEED_TOKEN`) pro Airbnb
importar o calendário do booking-service, fechando o sync nos dois sentidos.

## Estrutura

```
src/
  server.ts / worker.ts   # dois pontos de entrada, um código
  app.ts                  # monta o Fastify + plugins
  config.ts               # env vars validadas com zod
  routes/health.ts
  db/
    schema.ts             # tipos TypeScript (Drizzle) das 6 tabelas
    migrations/0000_init.sql  # DDL de verdade — schema.ts não gera isso sozinho
                               # porque as EXCLUDE constraints (a trava contra
                               # overbooking) não têm representação no DSL do Drizzle
    migrate.ts             # runner simples que aplica os .sql em ordem
  config/cancellation-policy.ts  # placeholder, pendente do texto real do Airbnb
```
