# studio215-booking

Backend de reserva direta do Studio 215 — Fastify + Drizzle + Postgres, deployado
no Railway. Serviço separado do site (`studio215-site`, que continua estático no
GitHub Pages sem nenhuma mudança).

**Estado atual: Fase 3 bloqueada no lado do Mercado Pago.** Fases 1 e 2
completas e em produção (motor de reservas, calendário sincronizado com o
Airbnb, expiração automática). Fase 3 (pagamento) testada e funcionando em
sandbox, e já configurada com credenciais de produção — mas o MP recusa
pagamentos reais com `PA_UNAUTHORIZED_RESULT_FROM_POLICIES`, uma trava de
conta/aplicação que não depende do código. Ver [Roadmap](#roadmap) abaixo,
item **D2**, pro diagnóstico completo e os caminhos de solução.

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
— escolha de método, QR do Pix, Card Payment Brick), publicado no GitHub.
**Testado ponta a ponta em sandbox em 2026-08-13** — Pix (QR real + idempotência
de reload), cartão aprovado (confirma a reserva na hora) e recusado (reserva
continua `pending`, permite nova tentativa), e o webhook (assinatura HMAC
verificada, dedupe, busca sempre o status real na API do MP) — os 3 juntos
cobrem os caminhos que importam.

**Decisões de negócio já tomadas e implementadas:**
- Pagamento aprovado que chega atrasado (reserva já expirou) e a data segue
  livre → resgata pra `confirmed` em vez de tratar como conflito.
- Conflito real de data → estorno automático via API do MP, sem esperar ação
  manual.
- `?preview=1` no site continua travando o botão de reservar pro público
  geral até o primeiro pagamento real supervisionado (ver Fase E abaixo).

**Nota pra quando migration nova entrar** (Fase 4 vai precisar): rodar
`node dist/db/migrate.js && node dist/server.js` como Start Command
temporário pra aplicar uma migration nova em produção **funciona pra aplicar
a migration, mas não deve ficar como Start Command permanente** — isso
derrubou o serviço inteiro (502) nos restarts seguintes em 2026-08-13, causa
raiz ainda não totalmente diagnosticada. Fluxo seguro: trocar o Start Command,
confirmar nos Deploy Logs que a migration aplicou (`✓ nome_do_arquivo.sql`),
reverter pra `node dist/server.js` imediatamente.

**O que falta, em ordem:**

- [x] **A — Credenciais de teste.** Aplicação criada no [painel de
      desenvolvedores do MP](https://www.mercadopago.com.br/developers/panel)
      (Checkout Transparente / API de Pagamentos), credenciais de teste e
      webhook configurados.
- [x] **B — Testar em sandbox.** Feito em 2026-08-13 — ver acima.
- [x] **C — Conta pronta pra receber de verdade.** Identidade verificada
      (incluindo reconhecimento facial) e chaves Pix cadastradas na conta MP
      do Nando.
- [x] **D — Produção configurada.** Credenciais de produção geradas
      (`APP_USR-...`), env vars trocadas no Railway e `MP_PUBLIC_KEY` de
      produção publicada no site. A assinatura secreta do webhook é a **mesma**
      em teste e produção nesta aplicação — não precisou mudar.
- [ ] **D2 — 🚫 BLOQUEADO: Mercado Pago recusa pagamentos reais.** Com
      credenciais de produção, `POST /v1/payments` retorna
      `403 PA_UNAUTHORIZED_RESULT_FROM_POLICIES` ("At least one policy returned
      UNAUTHORIZED"). **Não é bug do nosso código** — reproduzido chamando a API
      do MP direto, fora do backend, e falha até com R$1,00 sem CPF. O token é
      válido (leituras autenticadas funcionam) e o Pix está `active` na conta.
      **O que já foi descartado** (testado em 2026-08-19):
      - Não é o meio de pagamento: Pix **e** boleto falham igual → bloqueio
        vale pra conta inteira, não é específico do Pix.
      - Não é valor, CPF ou e-mail: falha com R$1,00, sem `identification`,
        com e-mail comum.
      - Não é credencial inválida: leituras autenticadas (`/users/me`,
        `/payment_methods`) funcionam com o mesmo token, e o Pix aparece
        `active` na conta.
      - **Não é a avaliação "Qualidade da integração".** Ela está em 0/100 e
        nunca rodou, mas exige "Payment Id de um pagamento das últimas 24h
        com credenciais produtivas" — que é justamente o que o PolicyAgent
        impede de criar. Como o MP não desenharia um ciclo impossível, a
        avaliação vem **depois** de a conta poder cobrar, não antes.
      **Causa provável restante:** a conta não está habilitada a processar
      pagamentos via API em produção. `GET /users/me` retorna
      `"mercadopago_account_type": "personal"`. Isso não é confirmado por
      documentação como requisito do Checkout Transparente, então o caminho
      é **abrir chamado no suporte do MP citando o código do erro** — bloqueios
      de PolicyAgent são opacos de propósito e só o suporte enxerga qual
      política disparou.
- [x] **D3 — Preparação para a avaliação de qualidade.** Feito em 2026-08-19,
      enquanto o bloqueio acima não é resolvido. A avaliação exige 73/100 e
      estamos em 0 (nunca rodou). Implementado o que pontua e depende de nós:
      `additional_info` com item da reserva e telefone do pagador,
      `statement_descriptor` (`STUDIO215`) no cartão, e device id do
      `security.js` do MP via header `X-Meli-Session-Id`. Já tínhamos
      `external_reference`, `notification_url`, webhooks, SDK oficial e
      tokenização client-side. Payloads validados direto na API do MP com
      credenciais de teste. Falta só poder rodar a medição — que depende do
      bloqueio D2 sair.
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
