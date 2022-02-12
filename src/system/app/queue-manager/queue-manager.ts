import { RedisClient } from '../../common/redis-client/redis-client';
import {
  ICallback,
  IQueueMetrics,
  TQueueParams,
  TRedisClientMulti,
} from '../../../../types';
import { redisKeys } from '../../common/redis-keys/redis-keys';
import { EmptyCallbackReplyError } from '../../common/errors/empty-callback-reply.error';
import { GenericError } from '../../common/errors/generic.error';
import { ConsumerMessageHandler } from '../consumer/consumer-message-handler';
import { validateMessageQueueDeletion } from './common';
import { eachOf, waterfall } from '../../lib/async';
import { NamespaceNotFoundError } from './errors/namespace-not-found.error';

export const queueManager = {
  queueExists(
    redisClient: RedisClient,
    queue: TQueueParams,
    cb: ICallback<void>,
  ): void {
    const { keyQueues } = redisKeys.getMainKeys();
    redisClient.sismember(keyQueues, JSON.stringify(queue), (err, reply) => {
      if (err) cb(err);
      else if (!reply) cb(new GenericError(`Queue does not exist`));
      else cb();
    });
  },

  deleteQueueTransaction(
    redisClient: RedisClient,
    queue: TQueueParams,
    multi: TRedisClientMulti | undefined,
    cb: ICallback<TRedisClientMulti>,
  ): void {
    const {
      keyQueuePending,
      keyQueueDL,
      keyQueueProcessingQueues,
      keyQueuePendingPriorityMessageIds,
      keyQueueAcknowledged,
      keyQueuePendingPriorityMessages,
      keyRateQueueDeadLettered,
      keyRateQueueAcknowledged,
      keyRateQueuePublished,
      keyRateQueueDeadLetteredIndex,
      keyRateQueueAcknowledgedIndex,
      keyRateQueuePublishedIndex,
      keyLockRateQueuePublished,
      keyLockRateQueueAcknowledged,
      keyLockRateQueueDeadLettered,
      keyQueueConsumers,
      keyProcessingQueues,
      keyQueues,
      keyNsQueues,
    } = redisKeys.getQueueKeys(queue);
    const keys: string[] = [
      keyQueuePending,
      keyQueueDL,
      keyQueueProcessingQueues,
      keyQueuePendingPriorityMessageIds,
      keyQueueAcknowledged,
      keyQueuePendingPriorityMessages,
      keyRateQueueDeadLettered,
      keyRateQueueAcknowledged,
      keyRateQueuePublished,
      keyRateQueueDeadLetteredIndex,
      keyRateQueueAcknowledgedIndex,
      keyRateQueuePublishedIndex,
      keyLockRateQueuePublished,
      keyLockRateQueueAcknowledged,
      keyLockRateQueueDeadLettered,
      keyQueueConsumers,
    ];
    redisClient.watch([keyQueueConsumers, keyQueueProcessingQueues], (err) => {
      if (err) cb(err);
      else {
        waterfall(
          [
            (cb: ICallback<void>): void =>
              this.queueExists(redisClient, queue, cb),
            (cb: ICallback<void>): void =>
              validateMessageQueueDeletion(redisClient, queue, cb),
            (cb: ICallback<string[]>) => {
              this.getQueueProcessingQueues(
                redisClient,
                queue,
                (err, reply) => {
                  if (err) cb(err);
                  else {
                    const pQueues = Object.keys(reply ?? {});
                    cb(null, pQueues);
                  }
                },
              );
            },
          ],
          (err?: Error | null, processingQueues?: string[] | null) => {
            if (err) redisClient.unwatch(() => cb(err));
            else {
              const tx = multi || redisClient.multi();
              const str = JSON.stringify(queue);
              tx.srem(keyQueues, str);
              tx.srem(keyNsQueues, str);
              const pQueues = processingQueues ?? [];
              if (pQueues.length) {
                keys.push(...pQueues);
                tx.srem(keyProcessingQueues, ...pQueues);
              }
              tx.del(...keys);
              cb(null, tx);
            }
          },
        );
      }
    });
  },

  deleteNamespace(
    redisClient: RedisClient,
    ns: string,
    cb: ICallback<void>,
  ): void {
    const { keyNamespaces } = redisKeys.getMainKeys();
    waterfall(
      [
        (cb: ICallback<void>) => {
          redisClient.sismember(keyNamespaces, ns, (err, isMember) => {
            if (err) cb(err);
            else if (!isMember) cb(new NamespaceNotFoundError(ns));
            else cb();
          });
        },
      ],
      (err) => {
        if (err) cb(err);
        else {
          this.getNamespaceQueues(redisClient, ns, (err, reply) => {
            if (err) cb(err);
            else {
              const queues = reply ?? [];
              const multi = redisClient.multi();
              multi.srem(keyNamespaces, ns);
              eachOf(
                queues,
                (queue, _, done) => {
                  this.deleteQueueTransaction(
                    redisClient,
                    queue,
                    multi,
                    (err) => done(err),
                  );
                },
                (err) => {
                  if (err) cb(err);
                  else redisClient.execMulti(multi, (err) => cb(err));
                },
              );
            }
          });
        }
      },
    );
  },

  /**
   * When deleting a message queue, all queue's related queues and data will be deleted from the system. If the given
   * queue has an online consumer, an error will be returned. To make sure that a consumer is online,
   * an additional heartbeat check is performed, so that crushed consumers would not block queue deletion for a certain
   * time.
   */
  deleteQueue(
    redisClient: RedisClient,
    queue: TQueueParams,
    cb: ICallback<void>,
  ): void {
    this.deleteQueueTransaction(redisClient, queue, undefined, (err, multi) => {
      if (err) cb(err);
      else if (!multi) cb(new EmptyCallbackReplyError());
      else redisClient.execMulti(multi, (err) => cb(err));
    });
  },

  deleteProcessingQueue(
    multi: TRedisClientMulti,
    queue: TQueueParams,
    processingQueue: string,
  ): void {
    const { keyProcessingQueues, keyQueueProcessingQueues } =
      redisKeys.getQueueKeys(queue);
    multi.srem(keyProcessingQueues, processingQueue);
    multi.hdel(keyQueueProcessingQueues, processingQueue);
    multi.del(processingQueue);
  },

  ///

  getQueueProcessingQueues(
    redisClient: RedisClient,
    queue: TQueueParams,
    cb: ICallback<Record<string, string>>,
  ): void {
    const { keyQueueProcessingQueues } = redisKeys.getQueueKeys(queue);
    redisClient.hgetall(keyQueueProcessingQueues, cb);
  },

  getQueueMetrics(
    redisClient: RedisClient,
    queue: TQueueParams,
    cb: ICallback<IQueueMetrics>,
  ): void {
    const queueMetrics: IQueueMetrics = {
      acknowledged: 0,
      pendingWithPriority: 0,
      deadLettered: 0,
      pending: 0,
    };
    const {
      keyQueuePending,
      keyQueuePendingPriorityMessageIds,
      keyQueueDL,
      keyQueueAcknowledged,
    } = redisKeys.getQueueKeys(queue);
    waterfall(
      [
        (cb: ICallback<void>) => {
          redisClient.llen(keyQueuePending, (err, reply) => {
            if (err) cb(err);
            else {
              queueMetrics.pending = reply ?? 0;
              cb();
            }
          });
        },
        (cb: ICallback<void>) => {
          redisClient.llen(keyQueueDL, (err, reply) => {
            if (err) cb(err);
            else {
              queueMetrics.deadLettered = reply ?? 0;
              cb();
            }
          });
        },
        (cb: ICallback<void>) => {
          redisClient.llen(keyQueueAcknowledged, (err, reply) => {
            if (err) cb(err);
            else {
              queueMetrics.acknowledged = reply ?? 0;
              cb();
            }
          });
        },
        (cb: ICallback<void>) => {
          redisClient.zcard(keyQueuePendingPriorityMessageIds, (err, reply) => {
            if (err) cb(err);
            else {
              queueMetrics.pendingWithPriority = reply ?? 0;
              cb();
            }
          });
        },
      ],
      (err) => {
        if (err) cb(err);
        else cb(null, queueMetrics);
      },
    );
  },

  getNamespaces(redisClient: RedisClient, cb: ICallback<string[]>): void {
    const { keyNamespaces } = redisKeys.getMainKeys();
    redisClient.smembers(keyNamespaces, (err, reply) => {
      if (err) cb(err);
      else if (!reply) cb(new EmptyCallbackReplyError());
      else cb(null, reply);
    });
  },

  getNamespaceQueues(
    redisClient: RedisClient,
    namespace: string,
    cb: ICallback<TQueueParams[]>,
  ): void {
    const { keyNsQueues } = redisKeys.getNsKeys(namespace);
    redisClient.smembers(keyNsQueues, (err, reply) => {
      if (err) cb(err);
      else if (!reply) cb(new EmptyCallbackReplyError());
      else {
        const messageQueues: TQueueParams[] = reply.map((i) => JSON.parse(i));
        cb(null, messageQueues);
      }
    });
  },

  getQueues(redisClient: RedisClient, cb: ICallback<TQueueParams[]>): void {
    const { keyQueues } = redisKeys.getMainKeys();
    redisClient.smembers(keyQueues, (err, reply) => {
      if (err) cb(err);
      else if (!reply) cb(new EmptyCallbackReplyError());
      else {
        const messageQueues: TQueueParams[] = reply.map((i) => JSON.parse(i));
        cb(null, messageQueues);
      }
    });
  },

  getProcessingQueues(redisClient: RedisClient, cb: ICallback<string[]>): void {
    const { keyProcessingQueues } = redisKeys.getMainKeys();
    redisClient.smembers(keyProcessingQueues, cb);
  },

  setUpProcessingQueue(
    multi: TRedisClientMulti,
    consumerHandler: ConsumerMessageHandler,
  ): void {
    const {
      keyQueueProcessing,
      keyProcessingQueues,
      keyQueueProcessingQueues,
    } = consumerHandler.getRedisKeys();
    multi.hset(
      keyQueueProcessingQueues,
      keyQueueProcessing,
      consumerHandler.getConsumerId(),
    );
    multi.sadd(keyProcessingQueues, keyQueueProcessing);
  },

  setUpMessageQueue(multi: TRedisClientMulti, queue: TQueueParams): void {
    const { keyQueues, keyNsQueues, keyNamespaces } =
      redisKeys.getQueueKeys(queue);
    const str = JSON.stringify(queue);
    multi.sadd(keyQueues, str);
    multi.sadd(keyNsQueues, str);
    multi.sadd(keyNamespaces, queue.ns);
  },

  getQueueParams(queue: string | TQueueParams): TQueueParams {
    const queueParams: TQueueParams =
      typeof queue === 'string'
        ? {
            name: queue,
            ns: redisKeys.getNamespace(),
          }
        : queue;
    const name = redisKeys.validateRedisKey(queueParams.name);
    const ns = redisKeys.validateRedisKey(queueParams.ns);
    return {
      name,
      ns,
    };
  },
};
