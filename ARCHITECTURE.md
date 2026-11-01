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

## ORM e mapeamento

As entidades são mapeadas com `EntitySchema` na camada de infraestrutura, e não com decorators nas classes de domínio. Isso mantém o domínio livre do ORM e, de quebra, dispensa a reflection de metadata no mapeamento. Os decorators ficam só onde o Nest precisa (controllers e DI).

## Migrations

- MikroORM Migrator, executado por `scripts/migrate.ts` via API programática (sem depender do loader do CLI no Bun).
- SQL escrito à mão, com `snapshot: false`: constraints, índices parciais e triggers de imutabilidade fazem parte do design (restrição 9) e não devem nascer de diff automático.
- `transactional` e `allOrNothing`: um lote que falha não deixa o schema pela metade.
- Toda migration tem `down`; o ciclo up → down → up é verificado.

## Pendente (próximas issues)

ORM/estratégia transacional detalhada (#02), Money (#03), schema e constraints (#04), concorrência (#06), idempotência (#07), taxonomia de erros (#10), inbox/outbox (#11, #12), autenticação (#17).
