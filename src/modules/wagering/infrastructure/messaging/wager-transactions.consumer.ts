import { createHash } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { DuplicateMessageError, InvalidPayloadError } from '../../../../shared/application/errors';
import type { CatalogCode } from '../../../../shared/application/failure-catalog';
import { classifyError } from '../../../../shared/infrastructure/error-classification';
import { parseWith } from '../../../../shared/presentation/validation';
import type { ProcessWagerMessageUseCase, WagerMessage } from '../../application/process-wager-message.use-case';
import type { RecordFailedTransactionUseCase } from '../../application/record-failed-transaction.use-case';
import { toSubmitCommand, WagerTransactionRequestedSchema } from '../../presentation/wager-transaction.schema';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

export interface WagerConsumerOptions {
  readonly queueName: string;
  readonly dlqName: string;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly visibilityTimeoutSeconds: number;
  readonly waitTimeSeconds: number;
  readonly batchSize: number;
  readonly shutdownGraceMs: number;
}

export type MessageOutcome = 'acked' | 'dead-lettered' | 'retrying' | 'released';

const RECEIVE_ERROR_DELAY_MS = 1_000;

export class WagerTransactionsConsumer {
  private readonly logger = new Logger(WagerTransactionsConsumer.name);
  private queueUrl: string | undefined;
  private dlqUrl: string | undefined;
  private loop: Promise<void> | undefined;
  private abort = new AbortController();
  private stopping = false;

  constructor(
    private readonly sqs: SQSClient,
    private readonly processMessage: ProcessWagerMessageUseCase,
    private readonly recordFailed: RecordFailedTransactionUseCase,
    private readonly options: WagerConsumerOptions,
  ) {}

  start(): void {
    this.stopping = false;
    this.abort = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (!this.loop) return;
    await Promise.race([this.loop, Bun.sleep(this.options.shutdownGraceMs)]);
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.resolveQueues();
        const { Messages = [] } = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: this.options.batchSize,
            WaitTimeSeconds: this.options.waitTimeSeconds,
            VisibilityTimeout: this.options.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        await this.processBatch(Messages);
      } catch (error) {
        if (this.stopping) return;
        this.logger.warn(`receive failed: ${error instanceof Error ? error.message : String(error)}`);
        await Bun.sleep(RECEIVE_ERROR_DELAY_MS);
      }
    }
  }

  async processBatch(messages: readonly Message[]): Promise<MessageOutcome[]> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    const outcomes = await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
    return outcomes.flat();
  }

  // Mensagens do mesmo grupo seguem em ordem; se uma fica para retry, as seguintes voltam para a fila.
  private async processGroup(messages: readonly Message[]): Promise<MessageOutcome[]> {
    const outcomes: MessageOutcome[] = [];
    for (const [index, message] of messages.entries()) {
      if (this.stopping) {
        outcomes.push(...(await this.release(messages.slice(index))));
        break;
      }
      const outcome = await this.handle(message);
      outcomes.push(outcome);
      if (outcome === 'retrying') {
        outcomes.push(...(await this.release(messages.slice(index + 1))));
        break;
      }
    }
    return outcomes;
  }

  private async handle(message: Message): Promise<MessageOutcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let parsed: WagerMessage;
    try {
      parsed = this.parse(message);
    } catch (error) {
      return this.deadLetter(message, classifyError(error).code, receiveCount);
    }

    try {
      await this.processMessage.execute(parsed);
      return this.ack(message);
    } catch (error) {
      if (error instanceof DuplicateMessageError) return this.ack(message);
      const { code, definition } = classifyError(error);

      switch (definition.category) {
        case 'BUSINESS_REJECTION':
        case 'CONFLICT':
        case 'NOT_FOUND':
          this.logger.log(`message ${parsed.messageId} rejected: ${code}`);
          return this.ack(message);
        case 'VALIDATION':
          return this.deadLetter(message, code, receiveCount);
        default:
          if (receiveCount < this.options.maxAttempts) return this.retryLater(message, receiveCount, code);
          await this.recordFailure(parsed);
          return this.deadLetter(message, 'PERMANENT_FAILURE', receiveCount);
      }
    }
  }

  private parse(message: Message): WagerMessage {
    let body: unknown;
    try {
      body = JSON.parse(message.Body ?? '');
    } catch {
      throw new InvalidPayloadError([{ path: '', message: 'Message body is not valid JSON' }]);
    }
    const envelope = parseWith(WagerTransactionRequestedSchema, body);
    const { idempotencyKey, ...payload } = envelope.data;
    return {
      consumerName: WAGER_CONSUMER_NAME,
      messageId: envelope.messageId,
      payloadHash: createHash('sha256').update(message.Body ?? '').digest('hex'),
      command: toSubmitCommand(payload, idempotencyKey),
    };
  }

  private async recordFailure(message: WagerMessage): Promise<void> {
    try {
      const result = await this.recordFailed.execute(message);
      this.logger.warn(`message ${message.messageId} exhausted retries; FAILED ${result}`);
    } catch (error) {
      this.logger.error(`could not record FAILED for ${message.messageId}: ${String(error)}`);
    }
  }

  backoffSeconds(receiveCount: number): number {
    const delayMs = Math.min(this.options.backoffBaseMs * 2 ** (receiveCount - 1), this.options.backoffMaxMs);
    return Math.max(1, Math.ceil(delayMs / 1000));
  }

  private async retryLater(message: Message, receiveCount: number, code: CatalogCode): Promise<MessageOutcome> {
    const seconds = this.backoffSeconds(receiveCount);
    this.logger.warn(`message ${message.MessageId} failed with ${code}; attempt ${receiveCount}, retry in ${seconds}s`);
    await this.setVisibility(message, seconds);
    return 'retrying';
  }

  private async release(messages: readonly Message[]): Promise<MessageOutcome[]> {
    await Promise.all(messages.map((message) => this.setVisibility(message, 0)));
    return messages.map(() => 'released');
  }

  private async ack(message: Message): Promise<MessageOutcome> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    return 'acked';
  }

  private async deadLetter(message: Message, failureCode: CatalogCode, receiveCount: number): Promise<MessageOutcome> {
    this.logger.warn(`message ${message.MessageId} sent to DLQ: ${failureCode}`);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureCode: { DataType: 'String', StringValue: failureCode },
          receiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
        },
      }),
    );
    await this.ack(message);
    return 'dead-lettered';
  }

  private async setVisibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private async resolveQueues(): Promise<void> {
    if (this.queueUrl && this.dlqUrl) return;
    const [main, dlq] = await Promise.all([
      this.sqs.send(new GetQueueUrlCommand({ QueueName: this.options.queueName })),
      this.sqs.send(new GetQueueUrlCommand({ QueueName: this.options.dlqName })),
    ]);
    this.queueUrl = main.QueueUrl;
    this.dlqUrl = dlq.QueueUrl;
  }
}
