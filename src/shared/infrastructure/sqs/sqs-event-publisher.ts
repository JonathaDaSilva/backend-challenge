import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/outbox';
import type { OutboxMessage } from '../../domain/outbox-message';

export class SqsEventPublisher implements EventPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    this.queueUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }))).QueueUrl;
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
    );
    const failed = new Set(Failed.map((failure) => messages[Number(failure.Id?.slice(1))]?.id ?? ''));
    return { failed };
  }
}
