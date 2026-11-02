# Architecture

Decisões, trade-offs e limitações. Atualizado conforme cada issue do roadmap é concluída.

## Stack e ambiente local

| Item | Escolha | Motivo |
|---|---|---|
| Runtime / testes | Bun 1.4 + `bun test` | exigido pelo desafio |
| Framework | NestJS 12 | exigido; roda direto no Bun (`bun src/main.ts`), sem o CLI do Nest |
| TypeScript | 6.x, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | o TS 7 (compilador nativo) não expõe a API JS de que o `typescript-eslint` depende |
| Banco | PostgreSQL 17 | — |
| SQS local | **MiniStack** 1.5.30 | as imagens atuais do LocalStack exigem `LOCALSTACK_AUTH_TOKEN` (licença paga). A MiniStack é MIT, compatível com a API do SQS e executa scripts `ready.d` no mesmo formato do LocalStack. Trocar de volta é só mudar a imagem no compose |
| ORM | MikroORM 7 | preferencial no desafio; Unit of Work, `em.transactional()` e `LockMode` explícitos |

## Filas

`docker/sqs/init/ready.d/01-create-queues.sh` cria `wager-transactions-dlq.fifo` e depois `wager-transactions.fifo`, com `RedrivePolicy` para a DLQ. O `maxReceiveCount=8` é a rede de segurança do consumer (ver [Consumer SQS](#consumer-sqs-e-inbox)). O healthcheck do container usa `/_ministack/ready`, que só responde "completed" depois que os scripts terminam, então `docker compose up --wait` retorna com as filas criadas.

A FIFO não é tratada como garantia de consistência: a deduplicação e a ordem por carteira são garantidas no banco (inbox, constraints e locks), como pede o desafio.

## Camadas

```
src/modules/<contexto>/
  domain/          entidades, value objects, regras: TypeScript puro
  application/     use cases e portas (interfaces de repositório, publisher)
  infrastructure/  MikroORM (EntitySchema), SQS, outbox
  presentation/    controllers HTTP e consumers
src/shared/        Money, erros base, config, clientes de infraestrutura
```

O domínio não depende de NestJS nem de MikroORM. Uma regra `no-restricted-imports` no `eslint.config.js` bloqueia esses imports e os de camadas externas dentro de `**/domain/**`.

## ORM: MikroORM

| Critério | MikroORM 7 | TypeORM |
|---|---|---|
| Propagação da transação | `em.transactional()` guarda o fork transacional num AsyncLocalStorage (`TransactionContext`); os repositórios usam o `em` injetado e entram na transação sozinhos | o `QueryRunner` ou o `EntityManager` da transação precisa ser passado a cada repositório, ou um ALS próprio precisa ser montado |
| Locks | `LockMode.PESSIMISTIC_WRITE` (`FOR UPDATE`), `OPTIMISTIC` com `version`, `isolationLevel` por transação | equivalentes, via `setLock` no QueryBuilder |
| Unit of Work / Identity Map | explícitos (`flush`, `fork`) | inexistentes: cada `save` é imediato |
| Erros do driver | convertidos em exceções tipadas (`DeadlockException`, `UniqueConstraintViolationException`…) preservando o SQLSTATE | `QueryFailedError` genérico |
| Domínio sem decorators | `EntitySchema` de primeira classe | `EntitySchema` existe, mas é pouco usado e pouco documentado |

O ponto decisivo é a propagação por contexto: inbox, saldo, ledger e outbox precisam estar no mesmo commit (§6.5), e com o MikroORM isso não exige mudar nenhuma assinatura de repositório.

## Domínio sem ORM: records + mappers

```
Wallet (domínio) ⇄ WalletMapper ⇄ WalletRecord ⇄ EntitySchema ⇄ tabela wallets
                    rehydrate()     classe simples   infrastructure/persistence/
                    toState()
```

- As classes de domínio **nunca** são mapeadas pelo ORM. Elas têm construtor privado, campos privados e a factory `rehydrate`, e o MikroORM hidrataria por `Object.create` e atribuição direta, passando por cima de tudo isso.
- Cada módulo tem, em `infrastructure/persistence/`, um record (classe só com campos), o `EntitySchema` desse record e um mapper. `toDomain(record)` chama `Wallet.rehydrate(...)`; `toRecord(wallet.toState())` faz o caminho inverso. O domínio só expõe um snapshot readonly (`toState()`).
- **Trade-off aceito:** os agregados perdem o dirty-checking automático do Unit of Work. Não faz falta aqui: o update de saldo vai ser SQL explícito e controlado por concorrência (#06), e o ledger é append-only (só INSERT).

## Money

`src/shared/domain/money.ts`: value object imutável (construtor privado e `Object.freeze`), sem dependência de framework ou ORM.

**Representação: big.js.** As operações que o domínio usa (`plus`, `minus`, comparações) são sempre exatas no big.js. As opções de precisão e arredondamento (`DP`/`RM`) só afetam divisão, raiz e potência, que o sistema não usa, então não existe ponto de arredondamento silencioso. O decimal.js foi descartado porque arredonda até soma e subtração quando o resultado passa de `precision` dígitos significativos, e o padrão (20) coincide exatamente com o tamanho máximo de `numeric(20,2)`. O `Money` usa um construtor local (`Big()`) com `strict = true`, que rejeita `number` em qualquer argumento, sem alterar a configuração global da biblioteca. O esqueleto do README tipa o campo como `Decimal`; a garantia é a mesma.

**Política de entrada (escala estrita):** só se aceita a forma canônica `^-?(0|[1-9]\d*)\.\d{2}$`, com até 18 dígitos inteiros.

| Entrada | Resultado (`InvalidMoneyError.reason`) |
|---|---|
| `"25.00"`, `"0.01"` | aceita |
| `25`, `25.5`, `null` (não string) | `NOT_A_STRING`: um `number` JSON pode já ter perdido precisão |
| `"25.001"` | `TOO_MANY_DECIMALS` |
| `"25"`, `"25.5"`, `""`, `" 25.00"`, `"NaN"`, `"Infinity"`, `"1e3"`, `"+25.00"`, `"025.00"`, `"-0.00"`, `"25,00"` | `INVALID_FORMAT` |
| 19 ou mais dígitos inteiros, inclusive como resultado de `add`/`subtract` | `OUT_OF_RANGE`: o mesmo limite do `numeric(20,2)`, para o erro surgir no domínio e não como falha de infraestrutura |
| moeda fora de `^[A-Z]{3}$` (inclui `"brl"`) | `INVALID_CURRENCY` |
| negativo em contrato de entrada | `NEGATIVE_NOT_ALLOWED` |

- **Por que estrita:** o README pede escala fixa de 2 casas. Além disso, uma única representação por valor deixa o hash do payload (#07) determinístico sem normalização: `"25.0"` e `"25.00"` nunca chegam a ser dois payloads distintos.
- **`from` vs `fromInput`:** `Money.from()` aceita sinal, porque o domínio precisa de negativos (`negate()`, cálculos intermediários) e é por ele que a persistência reidrata. `Money.fromInput()` é a porta dos contratos HTTP/SQS e rejeita negativos. Se `0.00` é permitido ou não depende do tipo de transação, e fica para as regras de negócio (#08).
- **Moedas:** operações e comparações de ordem entre moedas diferentes lançam `CurrencyMismatchError`; `equals` apenas devolve `false`. Quais moedas são suportadas é decisão da wallet, não do `Money`.
- **Serialização:** `toJSON()` devolve `MoneyProps` (`{ amount: "25.00", currency: "BRL" }`) e `toString()` usa sempre 2 casas. O zero negativo é normalizado para `"0.00"`.

## Money na persistência

- Duas colunas: `<campo>_amount numeric(20,2)` e `currency char(3)`. A escala de 2 casas é imposta pelo próprio tipo da coluna, e as `CHECK` de não-negatividade entram na #04.
- O driver `pg` devolve `numeric` como **string** (`"25.00"`). Nos records, a coluna usa `DecimalType('string')`, então o valor nunca passa por `number`. O mapper chama `Money.from({ amount, currency })`.
- Um teste de integração garante a exatidão: `0.10 + 0.20` somados no banco voltam como `"0.30"`.

## Estratégia transacional

**Port** (`src/shared/application/transaction-runner.ts`): `TransactionRunner.run(work)`, sem dependência de framework. A implementação, `MikroOrmTransactionRunner` (`src/shared/infrastructure/database/`), é injetada pelo token `TRANSACTION_RUNNER`.

- **Isolamento: READ COMMITTED**, o padrão do PostgreSQL. A proteção contra lost update não vem do nível de isolamento, e sim de lock de linha ou update condicional por wallet (#06). SERIALIZABLE causaria aborts frequentes em hot wallets sem ganho real, já que o conflito relevante é sempre na mesma linha.
- **Uma unidade de trabalho = um `run`.** Inbox (quando via SQS), mudança de status, saldo, ledger e outbox ficam todos dentro do mesmo `run`. Nada é publicado dentro dele: eventos só saem pela outbox depois do commit (restrição 4; ver [Transactional Outbox](#transactional-outbox)).
- **Retry limitado** de no máximo 3 tentativas, com backoff exponencial e jitter total, **só** para `40001` (serialization failure) e `40P01` (deadlock). Qualquer outro erro, inclusive violação de constraint, sobe na hora. Por isso `work` precisa ser re-executável: nada de efeito colateral fora do banco.
- **Aninhamento:** um `run` chamado dentro de outro entra na transação externa (`REQUIRED`) e não faz retry próprio. Depois que o PostgreSQL aborta uma transação, só o `run` mais externo consegue reiniciá-la.
- **Contexto:** o runner usa `em.getContext(false)` e funciona sem `RequestContext` HTTP, como no consumer SQS e nos workers agendados.

**Regra para os repositórios:** escrever sempre via `em.execute()`, QueryBuilder, `em.getKysely()` ou entidades do `em` injetado. `em.getConnection().execute()` **ignora a transação** e faz autocommit. Há um teste de integração que demonstra exatamente essa diferença.

**Provas** (`test/integration/transaction-runner.test.ts`): commit, rollback total, propagação por ALS no Bun, aninhamento, `FOR UPDATE` serializando dois débitos de 80.00 sobre 100.00 (um PROCESSED, um REJECTED, saldo final 20.00), limites do retry e recuperação de um **deadlock real** do PostgreSQL.

**Timeouts por transação:** cada `run` começa com `set_config('lock_timeout', …, true)` e `set_config('statement_timeout', …, true)`, ambos com escopo local à transação. Os valores vêm de `DATABASE_LOCK_TIMEOUT_MS` (padrão 2000) e `DATABASE_STATEMENT_TIMEOUT_MS` (padrão 5000). O controle de concorrência por wallet está na seção [Concorrência](#concorrência-por-wallet).

## Migrations

- MikroORM Migrator, executado por `scripts/migrate.ts` via API programática (sem depender do loader do CLI no Bun).
- SQL escrito à mão, com `snapshot: false`: constraints, índices parciais e triggers de imutabilidade fazem parte do design (restrição 9) e não devem nascer de diff automático.
- `transactional` e `allOrNothing`: um lote que falha não deixa o schema pela metade.
- Toda migration tem `down`; o ciclo up → down → up é verificado.
- Uma migration por agregado: `wallets`, `wager_transactions`, `wager_transaction_reversals`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`.

## Schema

```
wallets ──< wager_transactions ──< wallet_ledger_entries
                ▲        ▲
      reversal  │        │  reference
                wager_transaction_reversals

inbox_messages, outbox_messages: sem FK (registros de transporte)
```

- `wager_transactions → wallets`: FK `(wallet_id, player_id, currency)`.
- `wallet_ledger_entries → wager_transactions`: FK `(transaction_id, wallet_id, currency)`. Por transitividade, a moeda do lançamento também é a da wallet.
- `wager_transaction_reversals`: duas FKs simples para `wager_transactions`, uma da reversão e outra da referência.

Convenções:
- IDs `uuid` (UUIDv7) gerados pela aplicação;
- `kind`, `status` e `direction` como `text` + `CHECK`, não enum do PG, porque um enum não aceita remover valor e complica o `down`;
- valores monetários `numeric(20,2)` + `currency char(3)`;
- toda constraint tem nome explícito (`<tabela>_<regra>_<uq|ck|fk>`), para os repositórios mapearem o nome a um erro de domínio sem interpretar mensagem.

### Onde cada invariante é garantida

| Invariante (README) | Garantia no banco |
|---|---|
| Uma wallet por `playerId` + `currency` | `wallets_player_currency_uq` |
| Saldo nunca negativo | `wallets_balance_non_negative_ck`; no ledger, `wallet_ledger_balance_before_ck` e `_after_ck` |
| `version` começa em 1 | `wallets_version_ck` |
| Moeda da operação = moeda da wallet; wallet pertence ao player | FK composta `wager_tx_wallet_fk` → `wallets (id, player_id, currency)` |
| Idempotency key única (escopo **global**: o header é a fonte da verdade) | `wager_tx_idempotency_key_uq` |
| Transação única por provider | `wager_tx_provider_external_uq` |
| REFUND/ROLLBACK exigem referência (regra 1) | `wager_tx_reference_ck` |
| Só reversões podem ficar PENDING_REFERENCE | `wager_tx_pending_reference_ck` |
| OPENING é interno | `wager_tx_opening_ck` (OPENING ⇔ sem `provider_id`), `wager_tx_provider_fields_ck` (as demais exigem todos os campos do provedor) |
| Estado coerente | `wager_tx_processed_at_ck` (PROCESSED ⇔ `processed_at`), `wager_tx_failure_code_ck` (REJECTED/FAILED ⇔ `failure_code`) |
| Mesma referência, mesmo provider/player/wallet/moeda/rodada (regra 2) | trigger `assert_reversal_matches_reference` → `wager_tx_reversals_same_scope_ck` |
| REFUND só de BET; ROLLBACK de BET/WIN/REFUND (regra 3) | trigger → `wager_tx_reversals_reference_kind_ck` |
| Cada transação revertida no máximo uma vez, por qualquer tipo (regra 4, interpretação mais restrita; ver [Reversões](#reversões-refund-e-rollback)) | `wager_tx_reversals_reference_uq (reference_transaction_id)` |
| Valor da reversão = valor da referência (regra 5) | trigger → `wager_tx_reversals_amount_ck` |
| Só se reverte transação PROCESSED | trigger → `wager_tx_reversals_reference_processed_ck` |
| Lançamento: `balanceBefore ± money = balanceAfter` | `wallet_ledger_balance_math_ck` |
| No máximo um lançamento por transação e wallet | `wallet_ledger_one_per_transaction_uq` |
| Toda mudança de saldo tem exatamente um lançamento | `wallet_ledger_wallet_version_uq (wallet_id, wallet_version)`: como `version` só muda junto com o saldo, cada versão corresponde a um único lançamento, e dois débitos não conseguem ser aplicados sobre a mesma versão |
| Ledger imutável (restrição 5) | trigger `forbid_mutation` contra UPDATE/DELETE/TRUNCATE e grant só de `SELECT, INSERT` |
| Inbox deduplica `(consumerName, messageId)` | `inbox_messages_pk` |

A igualdade "saldo da wallet = soma do ledger" **não** é imposta por constraint: ela exigiria um trigger por mudança de saldo, que pesaria em toda escrita. Ela é verificada pela reconciliação (#13) e pelos testes de invariante (#15).

### Reversões: tabela de relacionamento em vez de FK composta

As regras 2 a 5 poderiam ser uma FK composta auto-referente em `wager_transactions` (id, provider, player, wallet, moeda, rodada, valor e kind), mas ela exigiria uma unique de 8 colunas e uma coluna `reference_kind` redundante. Em vez disso, `wager_transaction_reversals` registra o vínculo `reversal → reference` **quando a reversão é aplicada**, na mesma transação SQL:
- a regra 4 vira uma unique simples em `reference_transaction_id` (desde a #09; antes era por `(reference, kind)`), sem índice parcial;
- a PK em `reversal_transaction_id` garante que cada reversão reverte uma única transação;
- um trigger `BEFORE INSERT` valida as regras 2, 3 e 5 e a referência PROCESSED. Cada violação sai com SQLSTATE `23514` e um nome de constraint próprio;
- a tabela é append-only, como o ledger.

O `referenceTransactionId` do domínio é lido por join nessa tabela. Enquanto a reversão está PENDING_REFERENCE, só existe a `reference_external_transaction_id` na própria transação.

### Roles: owner e aplicação

O PostgreSQL controla permissões por role (usuário). São dois:

| Role | Uso | Permissões |
|---|---|---|
| `wallet` (owner) | só migrations (`MIGRATION_DATABASE_URL`) | dono das tabelas; pode tudo |
| `wallet_app` | API e workers (`DATABASE_URL`) | `wallets`, `wager_transactions`, `inbox_messages`, `outbox_messages`: `SELECT, INSERT, UPDATE`. `wallet_ledger_entries`, `wager_transaction_reversals`: só `SELECT, INSERT`. Nenhum `DELETE`, `TRUNCATE` ou DDL |

Por que as duas camadas: o trigger protege contra qualquer um, inclusive o owner. Mas o owner pode desabilitar o trigger (`ALTER TABLE … DISABLE TRIGGER`), e o `wallet_app` não pode, porque não é dono da tabela. Para ele, apagar ou alterar o ledger falha com `42501` antes mesmo do trigger. Assim, nem um bug nem uma injeção de SQL na aplicação consegue reescrever histórico.

O `wallet_app` é criado por `docker/postgres/init/01-app-role.sql`, que roda só na criação do volume. Cada migration concede os grants das suas tabelas.

### Índices

| Consumidor | Índice |
|---|---|
| Ledger com cursor (#13) | `wallet_ledger_cursor_idx (wallet_id, seq)`; `seq` é uma identity, ordem estável |
| Worker de PENDING_REFERENCE (#09) | parcial `wager_tx_pending_reference_due_idx (next_attempt_at) WHERE status = 'PENDING_REFERENCE'` |
| Destravar pendentes quando a referência chega | parcial `wager_tx_pending_reference_lookup_idx (provider_id, reference_external_transaction_id) WHERE status = 'PENDING_REFERENCE'` |
| Publisher da outbox (#12) | parcial `outbox_messages_pending_idx (next_attempt_at, seq) WHERE published_at IS NULL`: contém só o que falta publicar |
| Consulta por provider/external id | a própria `wager_tx_provider_external_uq` |

Os testes em `test/integration/schema/` provam cada linha da tabela de invariantes, verificando o SQLSTATE e o nome da constraint.

## Wallet

`src/modules/wallet/domain/wallet.ts` (aggregate root) e `wallet-ledger-entry.ts`.

- **`credit` e `debit` devolvem o `WalletLedgerEntry`** já com `balanceBefore`, `balanceAfter` e `walletVersion` calculados. Não existe caminho que mude o saldo sem produzir o lançamento correspondente, e o repositório só persiste os dois.
- **Saldo insuficiente** lança `InsufficientFundsError`, e o estado não muda. O agregado não sabe qual operação o chamou: é o use case que traduz o erro para o `failureCode`, que é diferente para um BET e para uma reversão (regra 9, #08/#09).
- **`version`** começa em 1 e só incrementa em `credit` ou `debit`. Cada versão acima de 1 tem exatamente um lançamento, o que a `wallet_ledger_wallet_version_uq` do banco reforça.
- **`Wallet.open`** devolve `{ wallet, openingEntry }`:
  - com saldo inicial maior que zero, aplica um `credit` interno (OPENING: `0.00 → inicial`, versão 1);
  - com saldo zero, não cria lançamento e a versão já é 1.
- **Ids e datas chegam de fora**, pelos ports `IdGenerator` (UUIDv7) e `Clock` da aplicação. O domínio não gera UUID nem lê o relógio.
- **`WalletLedgerEntry.create`** valida a conta, valor positivo, saldos não negativos e versão ≥ 1. `rehydrate` não revalida nada (§6.0).

### `POST /wallets`

Wallet, transação `OPENING` (PROCESSED, sem campos de provedor) e lançamento `CREDIT` entram num único `TransactionRunner.run`. Um teste força falha na escrita do ledger e confere que não sobra wallet nem OPENING.

- **Conflito:** quem detecta a duplicata é o banco, por `wallets_player_currency_uq`, que o repositório traduz para `WalletAlreadyExistsError`. Não há checagem prévia, que teria corrida. O id da wallet existente é buscado **depois** do rollback (a transação original já está abortada) e vai no corpo do 409: um cliente que reenviou por timeout segue sem uma consulta extra. Um teste com 8 criações simultâneas para o mesmo player confirma um único 201.
- **Moedas:** `SUPPORTED_CURRENCIES` (lista separada por vírgula, padrão `BRL`). O modelo continua multi-moeda; só a abertura de wallet é restrita.

### Validação de entrada

O formato do payload é validado com **zod** em `presentation/`. O schema é um valor comum, então os mesmos schemas validam a mensagem SQS (#11). O `amount` e a `currency` passam pelo zod como `unknown` e são validados por `Money.fromInput`, para que o erro carregue o `reason` do `Money` (`NOT_A_STRING`, `INVALID_FORMAT`…) em vez de uma mensagem genérica.

### Erros HTTP

A taxonomia completa e as regras de status estão em [Taxonomia de falhas](#taxonomia-de-falhas).

## Concorrência por wallet

**A unidade de concorrência é a `walletId`, e a estratégia é lock pessimista com um update condicional por cima.**

1. **Lock:** `findByIdForUpdate` faz `SELECT … FOR UPDATE` na linha da wallet, o primeiro passo dentro do `run`.
2. **Regra:** `wallet.debit()` ou `wallet.credit()` em memória. `balanceBefore` e `balanceAfter` vêm da linha lida sob lock, então ninguém consegue mudá-la entre a leitura e a escrita.
3. **Update condicional:** `saveBalance(wallet, expectedVersion)` executa `UPDATE … WHERE id = ? AND version = ?`. Zero linhas afetadas lança `ConcurrentModificationError`, que o `TransactionRunner` trata como retentável. Sob lock isso não deveria acontecer; é uma rede de segurança caso algum caminho futuro escreva sem lock.
4. **Banco:** `UNIQUE (wallet_id, wallet_version)` no ledger (#04).

**Por que pessimista:**
- **Otimista:** sob disputa (hot wallet), gera retry em cascata, e com retry limitado operações legítimas falhariam só por concorrência.
- **Update atômico (`UPDATE … WHERE balance >= x`):** tiraria a regra do agregado `Wallet` e a duplicaria em SQL.
- **Com o lock:** a segunda aposta de 80.00 espera o commit da primeira, lê 20.00 e é **rejeitada por regra de negócio**, de forma determinística, sem retry e sem chance de débito duplicado.

**Restrições atendidas:**
- **Sem lock global:** o lock é por linha, e wallets diferentes nunca esperam entre si.
- **Correto com N instâncias:** o lock vive no PostgreSQL, não no processo.
- **Sem deadlock:** cada transação trava uma única wallet, então não existe ordem de lock para errar. Uma operação futura entre duas wallets deve travá-las em ordem de id.

**Limites operacionais:**
- `lock_timeout` de 2 s: uma requisição presa atrás de um lock longo falha com `55P03`, respondida como 503 `TRANSIENT_FAILURE`, em vez de segurar a conexão indefinidamente.
- `DATABASE_POOL_MAX` (padrão 10): dimensiona quantas requisições podem esperar na fila do lock por instância.
- A ordenação por `MessageGroupId = walletId` na FIFO (#11) só reduz a disputa: a garantia continua no banco.

**Provas:**
- `test/integration/concurrency/wallet-locking.test.ts`: dentro de um processo, cobre o cenário obrigatório, a rajada, a ausência de lock global e o lock timeout.
- `test/integration/concurrency/multi-instance.test.ts`: **três processos `bun` independentes**, cada um com seu pool, contra o mesmo banco. Cobre o cenário obrigatório com cada aposta numa instância, 60 apostas distribuídas, replay entre instâncias e wallets em paralelo. Todos os cenários conferem que **saldo armazenado = saldo reconstruído pelo ledger** e que as versões do ledger são contíguas.

## Idempotência

- **Persistente:** a `Idempotency-Key` fica em `wager_transactions.idempotency_key` com `UNIQUE` global (#04). Nada fica em memória.
- **Hash do payload:** SHA-256 em hex do JSON canônico (chaves ordenadas recursivamente, sem espaços, campos `undefined` omitidos) de `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount, currency}` e, se existir, `referenceExternalTransactionId`. O header, `messageId` e metadados de transporte não entram. Como `Money` só aceita a forma canônica (#03), dois payloads equivalentes nunca geram hashes diferentes.
- **Replay vs conflito:** mesma key e mesmo hash devolvem **o resultado original** (status, saldo observado naquele momento, `failureCode`) com `idempotentReplay: true` e o mesmo status HTTP. O saldo vem de `result_balance_amount`, gravado no processamento, porque a regra 7 pede o saldo da época, não o atual. Mesma key com hash diferente resulta em 409 `IDEMPOTENCY_CONFLICT`.
- **Corrida:** a checagem da key acontece **depois** do lock da wallet. Duas requisições iguais na mesma wallet ficam em série: a segunda encontra a primeira já gravada e faz replay. Com a mesma key em wallets diferentes, os locks não se cruzam, e quem decide é a `wager_tx_idempotency_key_uq`: a perdedora sofre rollback e o use case relê a key fora da transação para responder replay ou conflito.
- **Provas:** 50 requisições idênticas em paralelo, e 30 distribuídas entre 3 instâncias, geram um único débito e um único `idempotentReplay: false`.

## Submissão de transações (BET, WIN, LOSS)

`SubmitWagerTransactionUseCase` é **o** use case: o controller HTTP o chama, e o consumer SQS (#11) vai chamar o mesmo.

```
run:
  1. lock da wallet                    (404 se não existe)
  2. idempotency key existente?        → replay | 409
  3. a wallet é do player? mesma moeda? (422; não é gravado: a FK composta não permite)
  4. WagerTransaction.create           (PENDING, só em memória)
  5. BET → debit | WIN → credit | LOSS → nada
       sem saldo → REJECTED INSUFFICIENT_FUNDS, gravada, sem ledger
  6. grava transação (+ saldo com version check + lançamento) + eventos na outbox   [+ inbox, quando via SQS]
```

**Máquina de estados** (`WagerTransaction`):

```
PENDING ──► PROCESSED                       (terminal)
   ├──────► REJECTED                        (terminal; regra de negócio, com failureCode)
   ├──────► FAILED                          (terminal; erro permanente de infra, gravado pelo consumer SQS, #11)
   └──────► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED    (só REFUND/ROLLBACK, #09)
```

Transição a partir de um estado terminal lança `InvalidTransactionStateError`, que é erro de programação e não caminho de negócio. No fluxo síncrono, PENDING nunca chega ao banco: a transação nasce e se resolve no mesmo commit.

**Regras por tipo:**
- **BET:** valor > 0, débito.
- **WIN:** valor > 0, crédito. Um prêmio de zero é um LOSS.
- **LOSS:** valor ≥ 0. PROCESSED sem mexer no saldo nem no ledger; `result_balance` grava o saldo do momento.
- **OPENING:** recusado na entrada (só nasce internamente).
- **REFUND/ROLLBACK:** ver [Reversões](#reversões-refund-e-rollback).

**Interpretação documentada:** "WIN pode referenciar a BET da mesma rodada" é tratado como **associação pelo `roundId`**. O WIN não carrega `referenceExternalTransactionId`, porque o schema só admite referência em REFUND/ROLLBACK (`wager_tx_reference_ck`).

**HTTP:** 201 para PROCESSED, 422 para REJECTED (o mesmo corpo do contrato, com `status` e `failureCode`), 202 para PENDING_REFERENCE. Consultas: `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.

## Reversões: REFUND e ROLLBACK

As reversões usam o mesmo use case e o mesmo `WagerProcessor` das demais transações. A diferença está no passo de decisão:

```
resolve a referência por (providerId, referenceExternalTransactionId)
  ├─ não existe, ou está ela mesma PENDING_REFERENCE  → PENDING_REFERENCE (202), agenda nova tentativa
  └─ existe → WagerTransaction.checkReversalOf(referência):
        provider/player/wallet/moeda/rodada diferentes  → REJECTED REFERENCE_MISMATCH
        REFUND de algo que não é BET;
        ROLLBACK de algo fora de BET/WIN/REFUND         → REJECTED INVALID_REFERENCE_KIND
        valor diferente                                 → REJECTED REFERENCE_AMOUNT_MISMATCH
        referência não PROCESSED                        → REJECTED REFERENCE_NOT_PROCESSED
        já revertida (por qualquer tipo)                → REJECTED ALREADY_REVERSED
     aplica: REFUND → crédito; ROLLBACK → direção inversa da referência
        débito sem saldo                                → REJECTED REVERSAL_INSUFFICIENT_FUNDS
     PROCESSED + lançamento + vínculo em wager_transaction_reversals
```

- **Onde ficam as regras:** as regras 2, 3 e 5 estão no domínio (`checkReversalOf`), cada uma com o seu `failureCode`. O trigger da #04 continua como segunda barreira: se a aplicação errar, o banco recusa.
- **Regra 9:** a reversão que deixaria o saldo negativo recebe `REVERSAL_INSUFFICIENT_FUNDS`, distinto do `INSUFFICIENT_FUNDS` de um BET. Para o provedor são situações diferentes: num caso o jogador não tem saldo para apostar, no outro o cassino não consegue estornar um prêmio já gasto. A transação fica gravada como REJECTED e auditável.
- **Interpretação mais restrita da regra 4:** o README diz "não pode ser revertida duas vezes **pelo mesmo tipo**". Ao pé da letra, um BET poderia receber um REFUND **e** um ROLLBACK e ser devolvido em dobro. Aqui, **cada transação é revertida no máximo uma vez, por qualquer tipo** (`wager_tx_reversals_reference_uq`), o que cumpre a regra e fecha esse vazamento. Desfazer um REFUND continua possível: o ROLLBACK do REFUND tem outra referência.
- **Replay de uma pendente:** devolve o **estado atual**. Se já foi resolvida, o provedor recebe o resultado final; se ainda espera, recebe 202 com o saldo observado na submissão.

### Referências fora de ordem

**Caso comum, resolvido no mesmo commit.** Uma reversão só referencia transações da mesma wallet, e tudo na wallet passa pelo lock dela. Quando uma BET, WIN ou REFUND é processada, o mesmo `run`, ainda com o lock, busca as pendentes que esperam por ela (`wager_tx_pending_reference_lookup_idx`) e as aplica, em cascata: `ROLLBACK(REFUND(BET))` chegando ao contrário resolve tudo quando a BET chega. Em qualquer ordem de chegada o lock serializa os eventos, então não há espera nem corrida. Pendentes de outra wallet não são tocadas nesse caminho, porque o lock delas não está com este `run`; o worker as resolve depois (como `REFERENCE_MISMATCH`).

**Worker agendado com backoff (§7.1).** `PendingReferenceWorker.processDue(now)` pega as vencidas (`wager_tx_pending_reference_due_idx`). Para cada uma, num `run` próprio: trava a wallet, relê a transação e a agenda, roda a mesma decisão e, se continuar sem referência, reagenda.
- **Backoff:** `min(1 s × 2ⁿ, 60 s)` com *equal jitter* (metade fixa, metade aleatória). São **8 tentativas**, cerca de **3 minutos** no pior caso.
- **Justificativa do limite:** referência fora de ordem é, na prática, reordenação de fila, e se resolve em segundos (e o caso comum nem passa pelo worker). Uma BET que não apareceu em 3 minutos dificilmente vai aparecer, e o provedor precisa de uma resposta definitiva.
- **Configuração:** `PENDING_REFERENCE_MAX_ATTEMPTS`, `_BASE_DELAY_MS`, `_MAX_DELAY_MS`, `_BATCH_SIZE`.
- **Esgotado:** REJECTED `REFERENCE_NOT_FOUND`, com `WagerTransactionRejected` na outbox no mesmo commit.
- **Agenda fora do agregado:** `attempts` e `next_attempt_at` são agenda, não regra de negócio. Ficam fora do agregado `WagerTransaction`, só na tabela e no repositório.

**Agendamento sem polling.** Cada instância mantém **um** `setTimeout` apontado para o `next_attempt_at` mais próximo; sem pendentes, não há timer.
- **Trigger:** `wager_tx_pending_reference_notify_trg` dispara `NOTIFY pending_reference` com o vencimento sempre que uma pendente é criada ou reagendada. O `NOTIFY` só é entregue no commit, então nunca acorda alguém por uma linha que sofreu rollback.
- **Escuta:** cada instância escuta numa conexão dedicada (`pg.Client`, fora do pool) e adianta o timer se o vencimento novo for anterior.
- **Disparo:** o timer roda o `processDue` e depois relê o próximo vencimento no banco.
- **Reconexão:** ao reconectar o listener (ou ao subir a instância), o próximo vencimento é relido do banco, então uma notificação perdida não trava nenhuma pendente.
- **Duplicidade:** várias instâncias podem acordar para a mesma linha. O lock da wallet e a releitura do status fazem a segunda pular (`skipped`). Pode haver trabalho repetido, mas nunca efeito duplicado; um teste com três workers simultâneos confirma um único crédito.
- `PENDING_REFERENCE_WORKER_ENABLED=false` desliga o scheduler de uma instância. Os testes usam isso para chamar `processDue` diretamente, com datas controladas.

## Taxonomia de falhas

**Objetivo:** o provedor decide pelo **status HTTP**, sem interpretar a mensagem de erro, se reenvia, corrige o payload ou desiste. O `failureCode` dá o detalhe, e o campo `retryable` responde a pergunta diretamente.

| Status | Categoria | O que o provedor faz |
|---|---|---|
| 201 / 200 | — | sucesso (criação / consulta) |
| 202 | — | aceito, aguardando referência: espere, consulte ou reenvie a mesma key |
| 400 / 413 / 415 | `VALIDATION` | corrija o payload; se ele mudar, use outra `Idempotency-Key` |
| 404 | `NOT_FOUND` | o recurso **da URL** não existe |
| 409 | `CONFLICT` | não reenvie esse payload com essa key |
| 422 | `BUSINESS_REJECTION` | regra de negócio; reenviar dá a mesma resposta |
| 503 | `TRANSIENT` | reenvie **a mesma key** com backoff (`Retry-After` no header) |
| 500 | `INTERNAL` | nada foi gravado (rollback); reenviar a mesma key é seguro |

**Formato.** Todo erro responde `{ failureCode, message, retryable, ...detalhes }`. Os detalhes, quando existem, são `issues` (zod), `reason` (`Money` / `WagerTransaction`), `walletId`, `transactionId` ou `supportedCurrencies`. Uma transação **gravada** como REJECTED responde 422 com o corpo do contrato (`transactionId`, `status`, `balance`, `idempotentReplay`), mais `failureCode` e `retryable`.

**Decisões:**
- **404 só para a URL.** `GET /wallets/:id` com id inexistente responde 404 `WALLET_NOT_FOUND`. Um `walletId` inexistente **no corpo** de uma transação responde 422 `UNKNOWN_WALLET`: a rota existe e o problema é semântico no payload. Com 404, o provedor poderia concluir que errou a URL.
- **500 é retentável:** o `TransactionRunner` desfaz tudo, e a idempotência protege o reenvio.
- **503 sempre leva `Retry-After: 1`.**
- **`FAILED`:** uma transação nesse status (erro permanente de infraestrutura, registrado pelo consumer SQS na #11) carrega `PERMANENT_FAILURE`.

### Catálogo (fonte única)

`src/shared/application/failure-catalog.ts` declara cada código com categoria, status, `retryable` e descrição:
- **Filtro HTTP:** o `ErrorFilter` deriva status e corpo do catálogo. Cada classe de erro mapeia para um `CatalogCode`, tipado, então um código fora do catálogo nem compila.
- **Consumer SQS:** decide pela mesma categoria. `BUSINESS_REJECTION`/`CONFLICT`/`NOT_FOUND` → ack; `VALIDATION` → DLQ; `TRANSIENT`/`INTERNAL` → retry com backoff, e FAILED + DLQ depois do limite. A classificação (`src/shared/infrastructure/error-classification.ts`) é a mesma usada pelo filtro HTTP.
- **Esta documentação:** a tabela abaixo é gerada por `bun run docs:failures`.

Testes (`test/unit/failure-catalog.test.ts`) garantem que:
- status e `retryable` são coerentes com a categoria;
- todo `FailureCode` de transação está no catálogo;
- **toda classe que estende `ApplicationError` ou `DomainError` em `src/` está mapeada ou listada explicitamente como interna** (as internas viram 500, porque indicam bug ou são capturadas antes da borda). Um erro novo esquecido quebra o teste;
- a tabela abaixo está igual ao catálogo.

Além disso, um teste de contrato (`test/integration/error-contract.test.ts`) provoca cada código alcançável pela API e confere status, `failureCode`, `retryable` e `Retry-After`.

<!-- failure-catalog:start -->
| `failureCode` | Categoria | HTTP | `retryable` | Significado |
|---|---|---|---|---|
| `INVALID_PAYLOAD` | VALIDATION | 400 | não | Payload, header ou parâmetro da URL malformado; corrija antes de reenviar |
| `PAYLOAD_TOO_LARGE` | VALIDATION | 413 | não | Corpo da requisição maior que o limite aceito |
| `UNSUPPORTED_MEDIA_TYPE` | VALIDATION | 415 | não | O corpo precisa ser application/json |
| `NOT_FOUND` | NOT_FOUND | 404 | não | A rota não existe |
| `WALLET_NOT_FOUND` | NOT_FOUND | 404 | não | A wallet da URL não existe |
| `TRANSACTION_NOT_FOUND` | NOT_FOUND | 404 | não | A transação da URL não existe |
| `WALLET_ALREADY_EXISTS` | CONFLICT | 409 | não | O player já tem wallet nessa moeda; o corpo traz o walletId dela |
| `IDEMPOTENCY_CONFLICT` | CONFLICT | 409 | não | Idempotency-Key já usada com outro payload |
| `DUPLICATE_EXTERNAL_TRANSACTION` | CONFLICT | 409 | não | Transação do provedor já enviada com outra Idempotency-Key |
| `UNSUPPORTED_CURRENCY` | BUSINESS_REJECTION | 422 | não | Moeda não habilitada para novas wallets |
| `UNKNOWN_WALLET` | BUSINESS_REJECTION | 422 | não | O walletId do corpo não existe |
| `WALLET_PLAYER_MISMATCH` | BUSINESS_REJECTION | 422 | não | A wallet não pertence ao playerId do corpo |
| `CURRENCY_MISMATCH` | BUSINESS_REJECTION | 422 | não | Moeda da transação diferente da moeda da wallet |
| `INSUFFICIENT_FUNDS` | BUSINESS_REJECTION | 422 | não | Saldo menor que o valor do BET |
| `REVERSAL_INSUFFICIENT_FUNDS` | BUSINESS_REJECTION | 422 | não | A reversão deixaria o saldo negativo |
| `REFERENCE_NOT_FOUND` | BUSINESS_REJECTION | 422 | não | A transação referenciada não chegou dentro da janela de tentativas |
| `REFERENCE_MISMATCH` | BUSINESS_REJECTION | 422 | não | A referência é de outro provider, player, wallet, moeda ou rodada |
| `REFERENCE_AMOUNT_MISMATCH` | BUSINESS_REJECTION | 422 | não | Valor da reversão diferente do valor da referência |
| `INVALID_REFERENCE_KIND` | BUSINESS_REJECTION | 422 | não | REFUND só reverte BET; ROLLBACK só reverte BET, WIN ou REFUND |
| `REFERENCE_NOT_PROCESSED` | BUSINESS_REJECTION | 422 | não | A referência foi rejeitada ou falhou; não há o que reverter |
| `ALREADY_REVERSED` | BUSINESS_REJECTION | 422 | não | A referência já foi revertida |
| `TRANSIENT_FAILURE` | TRANSIENT | 503 | sim | Falha temporária de infraestrutura; reenvie com a mesma Idempotency-Key |
| `SERVICE_UNAVAILABLE` | TRANSIENT | 503 | sim | Uma dependência está inacessível |
| `INTERNAL_ERROR` | INTERNAL | 500 | sim | Erro inesperado; nada foi gravado e reenviar a mesma key é seguro |
| `PERMANENT_FAILURE` | PERMANENT | 500 | não | Falha permanente de infraestrutura, gravada como FAILED (consumer SQS) |
<!-- failure-catalog:end -->

## Consumer SQS e inbox

`src/modules/wagering/infrastructure/messaging/wager-transactions.consumer.ts` lê `wager-transactions.fifo` e entrega cada mensagem ao **mesmo** `SubmitWagerTransactionUseCase` do HTTP.

**Consumo:** `ReceiveMessage` com long polling (`WaitTimeSeconds` 20, até 10 mensagens). É o único modo de consumir SQS fora de Lambda: a chamada fica parada no servidor até chegar mensagem, e não há laço de consulta em intervalos. No shutdown, o long poll em curso é abortado por `AbortController`.

```
mensagem
 └─ envelope + data validados (o mesmo schema zod do HTTP, wager-transaction.schema.ts)
      ├─ inválida                 → DLQ imediata (INVALID_PAYLOAD): repetir nunca adianta
      └─ run:
           INSERT inbox (consumerName, messageId)    → 23505: já processada → ack
           SubmitWagerTransactionUseCase              (o run interno junta na mesma transação)
         commit
         └─ DeleteMessage (ack) só depois do commit
```

**Duas barreiras contra efeito duplicado:**
- **Mesmo `messageId`** (redelivery do SQS, ou consumer morto antes do ack): barrado pela PK da inbox.
- **`messageId` novo com a mesma `idempotencyKey`** (o provedor reenviou): replay no use case.

O INSERT da inbox vem **antes** do lock da wallet. Duas entregas simultâneas da mesma mensagem ficam em série na unique da inbox, e a segunda faz ack sem tocar na wallet. A inbox usa o `messageId` do envelope (§10), não o id interno do SQS.

**Classificação dos erros** (pelo catálogo de falhas):

| Resultado | Ação |
|---|---|
| PROCESSED, REJECTED gravada ou PENDING_REFERENCE | inbox + commit → ack |
| `BUSINESS_REJECTION` / `CONFLICT` não gravados (ex.: `UNKNOWN_WALLET`, `IDEMPOTENCY_CONFLICT`) | log + ack: repetir dá a mesma resposta |
| `VALIDATION` | DLQ imediata |
| `TRANSIENT` / `INTERNAL` | `ChangeMessageVisibility` com backoff; não faz ack |
| `TRANSIENT` / `INTERNAL` na última tentativa | grava a transação como **FAILED** (`PERMANENT_FAILURE`), depois DLQ |

**Por que 7 tentativas.** O retry precisa atravessar a falha transitória mais longa que vale a pena absorver automaticamente:

| Fonte | Duração típica |
|---|---|
| disputa de lock (`lock_timeout` 2 s) | segundos |
| pool esgotado | segundos |
| **failover de PostgreSQL gerenciado** (ex.: RDS Multi-AZ, documentado em 60–120 s) | até ~120 s |

Com `min(2 s × 2ⁿ⁻¹, 60 s)`, as esperas acumuladas são 2, 6, 14, 30, 62 e 122 s. **Sete tentativas** são o menor número que cobre um failover de 120 s. Uma oitava estenderia para quase 3 minutos o travamento do grupo FIFO (as mensagens seguintes da mesma wallet esperam) sem cobrir nenhuma falha real a mais. Passado esse ponto, a falha é uma indisponibilidade: a mensagem vai para a DLQ, para alerta e reprocessamento manual. O `maxReceiveCount` da fila é **8**, um acima do limite do consumer. Ele só age se o processo morrer sempre antes de classificar a mensagem (por exemplo, um crash ao ler aquele payload). Configurável em `SQS_MAX_ATTEMPTS`, `SQS_BACKOFF_BASE_MS` e `SQS_BACKOFF_MAX_MS`; um teste unitário fixa a janela em 122 s.

**FAILED auditável.** Ao esgotar as tentativas, `RecordFailedTransactionUseCase` grava a transação como FAILED (`PERMANENT_FAILURE`) com a inbox, para que o provedor, ao consultar ou reenviar a key, veja o desfecho. É melhor esforço: se o banco continua fora (a causa mais comum), o registro também falha. A mensagem vai para a DLQ do mesmo jeito, com `failureCode` e `receiveCount` como atributos.

**Ordem e paralelismo.** Num lote, mensagens do mesmo `MessageGroupId` são processadas em sequência, e grupos diferentes em paralelo. Se uma mensagem do grupo entra em retry, as seguintes do lote voltam para a fila (visibilidade 0), para não passarem à frente dela. Recomenda-se que os produtores usem `MessageGroupId = walletId`: ordem por wallet, o mesmo eixo do lock. Ainda assim, a garantia continua no banco.

**Shutdown (SIGTERM).** O consumer para no `beforeApplicationShutdown`, que roda antes do `onApplicationShutdown`, em que o cliente SQS é destruído:
1. o long poll é abortado;
2. as mensagens **em processamento** terminam, dentro de `SQS_SHUTDOWN_GRACE_MS` (padrão 10 s);
3. as recebidas e **ainda não iniciadas** ganham visibilidade 0 e voltam para a fila na hora, em vez de esperar o visibility timeout.

**Provas** (`test/integration/messaging/`, MiniStack real, filas próprias por teste):
- caminho feliz com inbox e ack, `messageId` duplicado e key reenviada;
- rejeição gravada e `UNKNOWN_WALLET`, ambos com ack;
- mensagens malformadas direto para a DLQ;
- falha transitória aplicada uma vez depois do backoff, e esgotamento resultando em FAILED + DLQ;
- shutdown com uma mensagem em voo e duas devolvidas na hora;
- **um processo `bun` separado morre exatamente no `DeleteMessage`, depois do commit.** Outro consumer recebe a redelivery, a inbox a reconhece e o débito continua sendo um só.

## Transactional Outbox

**Regra:** nenhum código publica direto no broker. Os eventos são **linhas em `outbox_messages`**, gravadas pelo `EventRecorder` dentro do mesmo `TransactionRunner.run` da mudança financeira. Se o commit falha, não há evento; se o commit passa, o evento existe e será publicado. Isso fecha o *dual write problem* e a restrição 4. Com isso, transação, saldo, ledger, inbox e outbox ficam todos no mesmo commit, o que também conclui a atomicidade pedida na #08.

### Eventos

| Evento | Quando | `aggregateId` | `causationId` |
|---|---|---|---|
| `WagerTransactionProcessed` | toda transação aplicada, inclusive LOSS (submissão, cascata, worker) | transação | a referência, quando aplicada em cascata |
| `WagerTransactionRejected` | toda REJECTED gravada, inclusive `REFERENCE_NOT_FOUND` | transação | — |
| `WalletBalanceChanged` | **só** quando há lançamento no ledger, inclusive o OPENING | wallet | a transação que moveu o saldo |
| `WagerTransactionPendingReference` | na **primeira** vez que fica pendente, não a cada reagendamento | transação | — |

**Bordas documentadas:**
- **OPENING:** gera só `WalletBalanceChanged`, porque é interno e não tem provedor a notificar.
- **FAILED:** não gera evento, porque não está na lista do §11.
- **Rejeições não gravadas** (`UNKNOWN_WALLET`, conflitos): não geram evento, porque não há commit onde escrevê-lo.

**Envelope.** A classe abstrata `IntegrationEvent<T>` (`src/shared/application/integration-event.ts`) tem uma subclasse por evento (`src/modules/wagering/application/events.ts`), cada uma com `eventType` e `version` **no tipo**. O `data` carrega só `MoneyProps` (string decimal) e fica congelado. O `toJSON()` produz o envelope do §11, e é ele que vai para a coluna `payload`.

**`correlationId`.** No HTTP, vem do header `X-Correlation-Id` (validado; se ausente, gerado) e é devolvido na resposta. No SQS, vem do `messageId` do envelope. Nos workers agendados, um por execução. É propagado por AsyncLocalStorage (`async-correlation-context.ts`), sem passar parâmetro pelos use cases. O mesmo contexto será usado pelos logs (#14).

### Publisher

`OutboxPublisher.processDue(now)` roda em lotes de 10, cada lote num `run`:

```
SELECT … FROM outbox_messages
 WHERE published_at IS NULL AND next_attempt_at <= now
 ORDER BY next_attempt_at, seq LIMIT 10
 FOR UPDATE SKIP LOCKED                      ← outra instância pula estas linhas
SendMessageBatch → wallet-events.fifo
UPDATE: published_at (aceitos) | attempts + 1, next_attempt_at = backoff (recusados)
COMMIT
```

- **Coordenação sem coluna de lease:** o lock da linha é o lease. Duas instâncias nunca pegam a mesma linha. Se o processo morre no meio, a conexão cai, o Postgres solta os locks e outra instância republica. O custo é manter a transação aberta durante uma chamada ao SQS, de milissegundos e sob o `statement_timeout`.
- **Retry sem limite:** `min(1 s × 2ⁿ⁻¹, 5 min)` com jitter. O §11 pede "sem perder", então nenhum evento é descartado. Um evento que insiste em falhar aparece como lag da outbox (métrica da #14), e não some.
- **Sem polling:** um trigger (`outbox_messages_notify_trg`) dispara `NOTIFY outbox` no commit. O `DeadlineScheduler`, extraído do worker da #09 e compartilhado com ele, mantém um timer no próximo `next_attempt_at` e relê o banco ao subir ou reconectar. `EVENTS_PUBLISHER_ENABLED=false` desliga o publisher de uma instância.

### Destino e entrega

- **Fila:** `wallet-events.fifo`, com `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId`. Em produção, o natural seria um tópico SNS com fan-out para as filas de cada consumidor; para isso basta trocar o `EventPublisher`, sem mexer na outbox.
- **At-least-once:** um processo que morre depois do `SendMessageBatch` e antes do commit faz o lote ser reenviado. A deduplicação da FIFO por `eventId` descarta repetições dentro de 5 minutos, mas isso é otimização. **O consumidor deve deduplicar pelo `eventId`**, que é estável entre republicações.
- **Ordem:** com vários publishers, dois eventos da mesma wallet podem sair fora de ordem. O consumidor ordena os `WalletBalanceChanged` pelo `walletVersion`; os eventos de transação são independentes entre si.

### Provas

- **`test/integration/outbox/outbox-events.test.ts`:**
  - os eventos certos em cada caso (OPENING, BET, LOSS, rejeição, referência tardia liquidada junto com a BET, expiração);
  - um rollback não deixa nenhuma linha.
- **`test/integration/outbox/outbox-publisher.test.ts`:**
  - uma linha numa transação aberta **não** é publicada até o commit;
  - **um processo gravou, fez commit e morreu antes de publicar, e outra instância publicou**;
  - dois publishers sobre 200 linhas enviam cada uma exatamente uma vez;
  - um destino fora do ar reagenda com backoff e publica depois;
  - a republicação do mesmo `eventId` é colapsada.

## Pendente (próximas issues)

Autenticação (#17).
