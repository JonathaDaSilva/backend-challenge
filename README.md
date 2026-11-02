# Distributed Wagering Processor

Serviço de carteira para apostas de cassino. Ele recebe transações de vários provedores de jogos (BET, WIN, LOSS, REFUND, ROLLBACK) por HTTP e por SQS e aplica cada uma exatamente uma vez sobre o saldo da wallet. Cada movimento fica num ledger imutável, e os eventos de integração saem por transactional outbox. O sistema é correto com várias instâncias em paralelo.

Bun · NestJS · TypeScript estrito · PostgreSQL 17 · MikroORM · SQS (MiniStack) · Docker Compose

- [`ARCHITECTURE.md`](./ARCHITECTURE.md): decisões, trade-offs e limitações.
- [`docs/CHALLENGE.md`](./docs/CHALLENGE.md): o enunciado original do desafio.

## Subir do zero

**Pré-requisitos:** [Bun 1.x](https://bun.sh) e Docker com Compose v2.

```bash
bun install
docker compose up -d --wait      # PostgreSQL 17 + SQS (MiniStack) com as filas FIFO, a DLQ e a fila de eventos
bun run db:migrate:up            # roda como o owner `wallet`
bun run start                    # http://localhost:3000, conecta como `wallet_app`
```

Sem `.env`, os padrões já apontam para os serviços do compose (veja `.env.example`).

**Sem instalar Bun:** `docker compose --profile app up -d --build --wait` sobe também um serviço de migrations e a API em container, na porta 3000.

**Ambiente de uma versão anterior:** o role `wallet_app` e as filas são criados quando o volume e o container nascem. Recrie com `docker compose down -v && docker compose up -d --wait`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | API com reload automático |
| `bun run start` | API |
| `bun test` | todos os testes (exige o compose no ar) |
| `bun run test` | só unitários |
| `bun run test:integration` | integração com PostgreSQL e SQS reais |
| `bun run test:concurrency` | concorrência e falha: 3 instâncias, crash antes do ack, publishers concorrentes, reinício |
| `bun run typecheck` / `bun run lint` | TypeScript estrito e regras de camadas |
| `bun run db:migrate:up` | aplica as migrations pendentes |
| `bun run db:migrate:down` | reverte a última (`--to <nome>` ou `--all`) |
| `bun run db:migrate:create <nome>` | cria uma migration vazia em `migrations/` |
| `bun run db:migrate:pending` | lista as pendentes |
| `bun run docs:failures` | regenera a tabela de `failureCode` do `ARCHITECTURE.md` a partir do catálogo |
| `docker compose down -v` | derruba tudo e apaga os dados |

## API

| Rota | O que faz | Status |
|---|---|---|
| `POST /wallets` | cria a wallet; saldo inicial > 0 gera OPENING + CREDIT no mesmo commit | 201 · 400 · 409 · 422 |
| `GET /wallets/:walletId` | saldo e versão | 200 · 400 · 404 |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | extrato paginado, do mais recente para o mais antigo; cursor opaco | 200 · 400 · 404 |
| `POST /wallets/:walletId/reconciliation` | saldo armazenado vs. ledger, num snapshot; divergência sinalizada, nunca corrigida | 200 · 400 · 404 |
| `POST /wagering/transactions` | submete BET/WIN/LOSS/REFUND/ROLLBACK; header `Idempotency-Key` obrigatório | 201 · 202 · 400 · 409 · 422 · 503 |
| `GET /wagering/transactions/:transactionId` | consulta por id interno | 200 · 400 · 404 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor | 200 · 404 |
| `GET /health/live`, `GET /health/ready` | processo vivo; PostgreSQL e SQS alcançáveis (503 durante o shutdown) | 200 · 503 |
| `GET /metrics` | métricas no formato Prometheus | 200 |

Todo erro responde `{ failureCode, message, retryable, … }`. O status diz ao provedor o que fazer:
- **400:** corrigir o payload;
- **409:** não reenviar;
- **422:** regra de negócio, desistir;
- **202:** aguardar;
- **503:** reenviar a mesma key;
- **500:** é seguro reenviar a mesma key.

A tabela completa está em [`ARCHITECTURE.md` → Taxonomia de falhas](./ARCHITECTURE.md#taxonomia-de-falhas). Envie `X-Correlation-Id` para correlacionar requisição, logs e eventos.

Mensagens SQS em `wager-transactions.fifo` seguem o envelope `WagerTransactionRequested` do desafio. Os eventos publicados vão para `wallet-events.fifo`.

## Configuração

| Variável | Padrão | Efeito |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |
| `DATABASE_URL` | `postgres://wallet_app:…@localhost:5432/wallet` | conexão da API e dos workers (role sem DELETE/TRUNCATE) |
| `MIGRATION_DATABASE_URL` | `postgres://wallet:…@localhost:5432/wallet` | conexão das migrations (owner) |
| `SUPPORTED_CURRENCIES` | `BRL` | moedas aceitas na abertura de wallet (lista separada por vírgula) |
| `DATABASE_POOL_MAX` | `10` | conexões por instância |
| `DATABASE_LOCK_TIMEOUT_MS` / `DATABASE_STATEMENT_TIMEOUT_MS` | `2000` / `5000` | limites por transação; o lock timeout responde 503 |
| `SQS_WAGER_QUEUE` / `SQS_WAGER_DLQ` | `wager-transactions.fifo` / `…-dlq.fifo` | filas de entrada |
| `SQS_CONSUMER_ENABLED` | `true` | liga o consumer na instância |
| `SQS_MAX_ATTEMPTS` | `7` | tentativas antes da DLQ (cerca de 120 s de backoff, ver ARCHITECTURE) |
| `SQS_BACKOFF_BASE_MS` / `SQS_BACKOFF_MAX_MS` | `2000` / `60000` | backoff exponencial do consumer |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` · `SQS_WAIT_TIME_SECONDS` · `SQS_BATCH_SIZE` | `30` · `20` · `10` | parâmetros do `ReceiveMessage` |
| `SQS_SHUTDOWN_GRACE_MS` | `10000` | prazo para terminar as mensagens em voo no SIGTERM |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga o worker de referências pendentes |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `8` | tentativas antes de `REFERENCE_NOT_FOUND` |
| `PENDING_REFERENCE_BASE_DELAY_MS` / `_MAX_DELAY_MS` / `_BATCH_SIZE` | `1000` / `60000` / `50` | backoff e lote do worker |
| `EVENTS_PUBLISHER_ENABLED` | `true` | liga o publisher da outbox |
| `EVENTS_QUEUE` | `wallet-events.fifo` | destino dos eventos |
| `EVENTS_BATCH_SIZE` · `EVENTS_BASE_DELAY_MS` · `EVENTS_MAX_DELAY_MS` | `10` · `1000` · `300000` | lote e backoff do publisher (sem limite de tentativas) |
| `AWS_REGION` · `AWS_ENDPOINT_URL` · `AWS_ACCESS_KEY_ID` · `AWS_SECRET_ACCESS_KEY` | `us-east-1` · `http://localhost:4566` · `test` · `test` | cliente SQS |

## Testes

Todos os testes de integração usam o PostgreSQL e a MiniStack reais do compose, sem mocks de banco ou de fila. Ao fim de cada execução, um hook global confere a invariante **saldo = ledger** em todas as wallets que os testes criaram. A tabela que liga cada exigência do §13 do desafio ao teste que a prova está em [`ARCHITECTURE.md` → Testes](./ARCHITECTURE.md#testes).

## Mapa do código

```
src/
  modules/
    wallet/      domain (Wallet, WalletLedgerEntry) · application (abrir, consultar, ledger, reconciliar)
                 infrastructure/persistence (records + mappers) · presentation (HTTP)
    wagering/    domain (WagerTransaction, failure codes) · application (submissão, processor, worker, eventos)
                 infrastructure (persistence, consumer SQS) · presentation (HTTP, schema zod)
    health/      live, ready e /metrics
  shared/
    domain/          Money, InboxMessage, OutboxMessage
    application/     ports (TransactionRunner, Clock, IdGenerator, outbox, métricas, log), catálogo de falhas
    infrastructure/  MikroORM, runner, scheduler LISTEN/NOTIFY, outbox, SQS, logger JSON, Prometheus
    presentation/    filtro de erros, middlewares (correlação, access log, JSON), auth
migrations/          SQL versionado e reversível
docker/              criação do role da aplicação e das filas
test/                unit · integration (schema, concurrency, messaging, outbox, …) · setup (invariante global)
```

`domain/` não importa NestJS, MikroORM nem camadas externas; uma regra do eslint barra esses imports.
