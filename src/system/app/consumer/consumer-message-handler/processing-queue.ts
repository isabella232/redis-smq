import { RedisClient } from '../../../common/redis-client/redis-client';
import {
  EMessageUnacknowledgedCause,
  ICallback,
  TQueueParams,
  TRedisClientMulti,
} from '../../../../../types';
import { Message } from '../../message/message';
import { waterfall } from '../../../lib/async';
import { broker } from '../../../common/broker/broker';
import { TimeSeries } from '../../../common/time-series/time-series';
import { GlobalDeadLetteredTimeSeries } from '../consumer-time-series/global-dead-lettered-time-series';
import { QueueDeadLetteredTimeSeries } from '../consumer-time-series/queue-dead-lettered-time-series';
import { redisKeys } from '../../../common/redis-keys/redis-keys';

function fetchProcessingQueueMessage(
  redisClient: RedisClient,
  consumerId: string,
  keyQueueProcessing: string,
  cb: ICallback<Message>,
): void {
  redisClient.lrange(
    keyQueueProcessing,
    0,
    0,
    (err?: Error | null, range?: string[] | null) => {
      if (err) cb(err);
      else if (range && range.length) {
        const msg = Message.createFromMessage(range[0]);
        cb(null, msg);
      } else cb();
    },
  );
}

function deleteProcessingQueue(
  multi: TRedisClientMulti,
  queue: TQueueParams,
  processingQueue: string,
): void {
  const { keyProcessingQueues, keyQueueProcessingQueues } =
    redisKeys.getQueueKeys(queue);
  multi.srem(keyProcessingQueues, processingQueue);
  multi.hdel(keyQueueProcessingQueues, processingQueue);
  multi.del(processingQueue);
}

export const processingQueue = {
  cleanUpProcessingQueue(
    redisClient: RedisClient,
    consumerId: string,
    queue: TQueueParams,
    multi: TRedisClientMulti,
    cb: ICallback<void>,
  ): void {
    const { keyQueueProcessing } = redisKeys.getQueueConsumerKeys(
      queue,
      consumerId,
    );
    waterfall(
      [
        (cb: ICallback<void>) => {
          fetchProcessingQueueMessage(
            redisClient,
            consumerId,
            keyQueueProcessing,
            (err, msg) => {
              if (err) cb(err);
              else if (msg) {
                const deadLettered = broker.retry(
                  multi,
                  keyQueueProcessing,
                  msg,
                  EMessageUnacknowledgedCause.RECOVERY,
                );
                if (typeof deadLettered === 'string') {
                  const timestamp = TimeSeries.getCurrentTimestamp();
                  GlobalDeadLetteredTimeSeries(redisClient).add(
                    timestamp,
                    1,
                    multi,
                  );
                  QueueDeadLetteredTimeSeries(redisClient, queue).add(
                    timestamp,
                    1,
                    multi,
                  );
                }
                cb();
              } else cb();
            },
          );
        },
        (cb: ICallback<void>) => {
          deleteProcessingQueue(multi, queue, keyQueueProcessing);
          cb();
        },
      ],
      cb,
    );
  },

  setUpProcessingQueue(
    multi: TRedisClientMulti,
    queue: TQueueParams,
    consumerId: string,
  ): void {
    const {
      keyQueueProcessing,
      keyProcessingQueues,
      keyQueueProcessingQueues,
    } = redisKeys.getQueueConsumerKeys(queue, consumerId);
    multi.hset(keyQueueProcessingQueues, keyQueueProcessing, consumerId);
    multi.sadd(keyProcessingQueues, keyQueueProcessing);
  },
};
