import { handleWork } from '../../../packages/shared/src/services/processing';
import { RetryWork, type ServiceBindings } from '../../../packages/shared/src/services/types';
import { run } from '../../../packages/shared/src/db/client';
import type { WorkMessage, R2Event } from '../../../packages/shared/src/contracts';

export default {
  async queue(batch: MessageBatch<WorkMessage | R2Event>, env: ServiceBindings) {
    await Promise.all(
      batch.messages.map(async (message) => {
        console.log(
          JSON.stringify({
            event: 'queue_received',
            messageId: message.id,
            bodyType: typeof message.body,
            keys: message.body && typeof message.body === 'object' ? Object.keys(message.body) : [],
            ...('action' in message.body
              ? { action: message.body.action, bucket: message.body.bucket }
              : {}),
          }),
        );
        try {
          await handleWork(env, message.body);
          message.ack();
        } catch (error) {
          const fileId =
            'fileId' in message.body
              ? message.body.fileId
              : message.body.object?.key?.split('/')[2];
          if (fileId && !(error instanceof RetryWork))
            await run(
              env.DB,
              'UPDATE files SET last_error=?,updated_at=? WHERE id=?',
              String(error).slice(0, 1000),
              Date.now(),
              fileId,
            );
          console.error(
            JSON.stringify({
              event: 'queue_retry',
              messageId: message.id,
              fileId,
              attempt: message.attempts,
              error: String(error),
            }),
          );
          message.retry({
            delaySeconds:
              error instanceof RetryWork
                ? error.delay
                : Math.min(1000, 10 * 2 ** (message.attempts - 1)),
          });
        }
      }),
    );
  },
} satisfies ExportedHandler<ServiceBindings, WorkMessage | R2Event>;
