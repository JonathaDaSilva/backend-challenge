import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/outbox';
import type { OutboxMessage } from '../../domain/outbox-message';

export class SqsEventPublisher implements EventPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
    private readonly timeoutMs: number,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const abortSignal = AbortSignal.timeout(this.timeoutMs);
    this.queueUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), { abortSignal })).QueueUrl;
    const { Failed = [] } = await this.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries: messages.map((message, index) => ({
          Id: `m${index}`,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
          MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
        })),
      }),
      { abortSignal },
    );
    const failed = new Set(Failed.map((failure) => messages[Number(failure.Id?.slice(1))]?.id ?? ''));
    return { failed };
  }
}
