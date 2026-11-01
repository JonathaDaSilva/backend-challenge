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

`docker/sqs/init/ready.d/01-create-queues.sh` cria `wager-transactions-dlq.fifo` e depois `wager-transactions.fifo`, com `RedrivePolicy` para a DLQ. O `maxReceiveCount=5` é provisório até a política de retry da #11. O healthcheck do container usa `/_ministack/ready`, que só responde "completed" depois que os scripts terminam, então `docker compose up --wait` retorna com as filas criadas.

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
- **Uma unidade de trabalho = um `run`.** Inbox (quando via SQS), mudança de status, saldo, ledger e outbox ficam todos dentro do mesmo `run`. Nada é publicado dentro dele: eventos só saem pela outbox depois do commit (restrição 4, #12).
- **Retry limitado** de no máximo 3 tentativas, com backoff exponencial e jitter total, **só** para `40001` (serialization failure) e `40P01` (deadlock). Qualquer outro erro, inclusive violação de constraint, sobe na hora. Por isso `work` precisa ser re-executável: nada de efeito colateral fora do banco.
- **Aninhamento:** um `run` chamado dentro de outro entra na transação externa (`REQUIRED`) e não faz retry próprio. Depois que o PostgreSQL aborta uma transação, só o `run` mais externo consegue reiniciá-la.
- **Contexto:** o runner usa `em.getContext(false)` e funciona sem `RequestContext` HTTP, como no consumer SQS e nos workers agendados.

**Regra para os repositórios:** escrever sempre via `em.execute()`, QueryBuilder, `em.getKysely()` ou entidades do `em` injetado. `em.getConnection().execute()` **ignora a transação** e faz autocommit. Há um teste de integração que demonstra exatamente essa diferença.

**Provas** (`test/integration/transaction-runner.test.ts`): commit, rollback total, propagação por ALS no Bun, aninhamento, `FOR UPDATE` serializando dois débitos de 80.00 sobre 100.00 (um PROCESSED, um REJECTED, saldo final 20.00), limites do retry e recuperação de um **deadlock real** do PostgreSQL.

**Pendente para a #06:** a escolha final do controle por wallet, entre `SELECT … FOR UPDATE`, update condicional com `version` ou uma combinação dos dois. O runner já suporta qualquer uma dessas opções.

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
| Referência revertida no máximo uma vez por tipo (regra 4) | `wager_tx_reversals_single_uq (reference_transaction_id, kind)` |
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
- a regra 4 vira uma unique simples (`reference_transaction_id, kind`), sem índice parcial;
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

## Pendente (próximas issues)

Concorrência (#06), idempotência (#07), taxonomia de erros (#10), inbox/outbox (#11, #12), autenticação (#17).
