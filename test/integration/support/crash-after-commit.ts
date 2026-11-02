import { DeleteMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../../src/shared/infrastructure/config';
import { createSqsClient } from '../../../src/shared/infrastructure/sqs/sqs.client';
import { SQS_CLIENT } from '../../../src/shared/infrastructure/tokens';
import { startApp } from './app';
import { CRASH_EXIT_CODE } from './crash-exit-code';

// Processo de teste: consome normalmente, mas morre no instante do ack, com o commit já feito.
const real = createSqsClient(loadConfig().aws);
const crashing = new Proxy(real, {
  get(target, property, receiver) {
    if (property !== 'send') return Reflect.get(target, property, receiver);
    return (command: Parameters<SQSClient['send']>[0], options?: Parameters<SQSClient['send']>[1]) => {
      if (command instanceof DeleteMessageCommand) process.exit(CRASH_EXIT_CODE);
      return target.send(command as never, options);
    };
  },
});

await startApp((builder) => builder.overrideProvider(SQS_CLIENT).useValue(crashing));
