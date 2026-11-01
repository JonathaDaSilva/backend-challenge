#!/usr/bin/env bash
# Creates the wager queues. The DLQ comes first because the main queue's
# RedrivePolicy needs its ARN.
set -euo pipefail

MAIN_QUEUE="wager-transactions.fifo"
DLQ="wager-transactions-dlq.fifo"
# Provisional: the definitive retry limit is decided in issue #11.
MAX_RECEIVE_COUNT=5

awslocal sqs create-queue --queue-name "$DLQ" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null

DLQ_URL=$(awslocal sqs get-queue-url --queue-name "$DLQ" --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

cat > /tmp/main-queue-attributes.json <<JSON
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"${MAX_RECEIVE_COUNT}\"}"
}
JSON

awslocal sqs create-queue --queue-name "$MAIN_QUEUE" \
  --attributes file:///tmp/main-queue-attributes.json >/dev/null

echo "Queues ready: $MAIN_QUEUE -> $DLQ (maxReceiveCount=$MAX_RECEIVE_COUNT)"
