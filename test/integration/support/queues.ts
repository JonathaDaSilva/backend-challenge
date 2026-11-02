import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type AppConfig, loadConfig } from '../../../src/shared/infrastructure/config';
import { createSqsClient } from '../../../src/shared/infrastructure/sqs/sqs.client';
import type { TestWallet } from './wagering';

export interface TestQueues {
  readonly sqs: SQSClient;
  readonly queueName: string;
  readonly dlqName: string;
  readonly queueUrl: string;
  readonly dlqUrl: string;
  dispose(): Promise<void>;
}

export async function createTestQueues(maxReceiveCount = 8): Promise<TestQueues> {
  const sqs = createSqsClient(loadConfig().aws);
  const suffix = Bun.randomUUIDv7().slice(-12);
  const queueName = `test-${suffix}.fifo`;
  const dlqName = `test-${suffix}-dlq.fifo`;
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: fifo }));
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        ...fifo,
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes?.QueueArn, maxReceiveCount: String(maxReceiveCount) }),
      },
    }),
  );

  return {
    sqs,
    queueName,
    dlqName,
    queueUrl: main.QueueUrl ?? '',
    dlqUrl: dlq.QueueUrl ?? '',
    async dispose() {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: main.QueueUrl })).catch(() => undefined);
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlq.QueueUrl })).catch(() => undefined);
      sqs.destroy();
    },
  };
}

export function consumerConfig(queues: TestQueues, overrides: Partial<AppConfig['sqs']> = {}) {
  return (config: AppConfig): AppConfig => ({
    ...config,
    pendingReference: { ...config.pendingReference, workerEnabled: false },
    sqs: {
      ...config.sqs,
      wagerQueue: queues.queueName,
      wagerDlq: queues.dlqName,
      consumerEnabled: true,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 5,
      backoffBaseMs: 1000,
      shutdownGraceMs: 5000,
      ...overrides,
    },
  });
}

export interface SentMessage {
  readonly messageId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
}

export interface MessageOptions {
  readonly kind?: string;
  readonly amount?: string;
  readonly messageId?: string;
  readonly externalTransactionId?: string;
  readonly idempotencyKey?: string;
  readonly rawBody?: string;
  readonly data?: Record<string, unknown>;
}

export async function sendWagerMessage(
  queues: TestQueues,
  wallet: TestWallet,
  options: MessageOptions = {},
): Promise<SentMessage> {
  const externalTransactionId = options.externalTransactionId ?? `ext-${Bun.randomUUIDv7()}`;
  const idempotencyKey = options.idempotencyKey ?? `provider-a:${externalTransactionId}`;
  const messageId = options.messageId ?? `msg-${Bun.randomUUIDv7()}`;
  const body =
    options.rawBody ??
    JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: options.kind ?? 'BET',
        money: { amount: options.amount ?? '10.00', currency: 'BRL' },
        ...options.data,
      },
    });
  await queues.sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.queueUrl,
      MessageBody: body,
      MessageGroupId: wallet.walletId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
  return { messageId, externalTransactionId, idempotencyKey };
}

export async function queueDepth(queues: TestQueues, url = queues.queueUrl): Promise<{ visible: number; inFlight: number }> {
  const { Attributes } = await queues.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export async function drainDeadLetters(queues: TestQueues): Promise<Message[]> {
  const { Messages = [] } = await queues.sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queues.dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ['All'],
    }),
  );
  return Messages;
}

export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(100);
  }
}

export interface EventsQueue {
  readonly sqs: SQSClient;
  readonly queueName: string;
  readonly queueUrl: string;
  dispose(): Promise<void>;
}

export async function createEventsQueue(): Promise<EventsQueue> {
  const sqs = createSqsClient(loadConfig().aws);
  const queueName = `test-events-${Bun.randomUUIDv7().slice(-12)}.fifo`;
  const { QueueUrl = '' } = await sqs.send(
    new CreateQueueCommand({ QueueName: queueName, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }),
  );
  return {
    sqs,
    queueName,
    queueUrl: QueueUrl,
    async dispose() {
      await sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined);
      sqs.destroy();
    },
  };
}

export interface PublishedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly data: Record<string, unknown>;
}

export async function receiveEvents(queue: EventsQueue, expected: number, timeoutMs = 10_000): Promise<PublishedEvent[]> {
  const events: PublishedEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < expected && Date.now() < deadline) {
    const { Messages = [] } = await queue.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    for (const message of Messages) {
      events.push(JSON.parse(message.Body ?? '{}') as PublishedEvent);
      await queue.sqs.send(new DeleteMessageCommand({ QueueUrl: queue.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return events;
}
