# studio215-booking

Backend de reserva direta do Studio 215 — Fastify + Drizzle + Postgres, deployado
no Railway. Serviço separado do site (`studio215-site`, que continua estático no
GitHub Pages sem nenhuma mudança).

Contexto completo, arquitetura e o roadmap das próximas fases: peça pro Claude
Code recapitular a conversa do projeto `studio215poa` — este README cobre só
"como rodar", não "por quê".

**Estado atual (Fase 1):** só o esqueleto — `/api/health` e o schema do banco.
Nenhuma reserva, pagamento ou sincronização com Airbnb ainda funciona. Isso
chega na Fase 2 em diante.

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

Ver `.env.example` — comentado, com o que já é usado na Fase 1 e o que só entra
a partir da Fase 2 (Mercado Pago, token do calendário de saída, login do admin).

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
