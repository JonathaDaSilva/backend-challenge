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

## Pendente (próximas issues)

Money (#03), schema e constraints (#04), concorrência (#06), idempotência (#07), taxonomia de erros (#10), inbox/outbox (#11, #12), autenticação (#17).
