import * as async from 'async';
import {
  ICallback,
  IConfig,
  TGetScheduledMessagesReply,
  TRedisClientMulti,
  TUnaryFunction,
} from '../types';
import { Message } from './message';
import { parseExpression } from 'cron-parser';
import { RedisClient } from './redis-client';
import { redisKeys } from './redis-keys';
import { EventEmitter } from 'events';
import { events } from './events';
import { Broker } from './broker';
import { Metadata } from './metadata';

export class Scheduler extends EventEmitter {
  protected queueName: string;
  protected redisClientInstance: RedisClient | null;
  protected keys: ReturnType<typeof redisKeys['getKeys']>;
  protected metadata: Metadata;

  constructor(queueName: string, client: RedisClient) {
    super();
    this.queueName = queueName;
    this.keys = redisKeys.getKeys(queueName);
    this.redisClientInstance = client;
    this.metadata = new Metadata(this);
  }

  protected scheduleAtTimestamp(
    message: Message,
    timestamp: number,
    mixed: TRedisClientMulti | ICallback<boolean>,
  ): void {
    const { keyQueueScheduledMessages, keyIndexScheduledMessages } = this.keys;
    const schedule = (m: TRedisClientMulti) => {
      const msgStr = message.toString();
      m.zadd(keyQueueScheduledMessages, timestamp, msgStr);
      m.hset(keyIndexScheduledMessages, message.getId(), msgStr);
      this.emit(events.PRE_MESSAGE_SCHEDULED, message, this.queueName, m);
      return m;
    };
    if (typeof mixed === 'object') schedule(mixed);
    else if (typeof mixed === 'function') {
      if (!this.redisClientInstance)
        mixed(new Error('Expected an instance of RedisClient'));
      else {
        const m = this.redisClientInstance.multi();
        schedule(m).exec((err) => {
          if (err) mixed(err);
          else mixed(null, true);
        });
      }
    } else {
      throw new Error(
        'Invalid function argument [mixed]. Expected a callback or an instance of Multi.',
      );
    }
  }

  protected scheduleAtNextTimestamp(
    msg: Message,
    multi: TRedisClientMulti,
  ): void {
    if (this.isPeriodic(msg)) {
      const timestamp = this.getNextScheduledTimestamp(msg) ?? 0;
      if (timestamp > 0) {
        this.scheduleAtTimestamp(msg, timestamp, multi);
      }
    }
  }

  protected enqueueScheduledMessage(
    broker: Broker,
    msg: Message,
    multi: TRedisClientMulti,
  ): void {
    const { keyQueueScheduledMessages } = this.keys;
    multi.zrem(keyQueueScheduledMessages, msg.toString());
    const message = this.isPeriodic(msg)
      ? Message.createFromMessage(msg, true)
      : msg;
    this.emit(
      events.PRE_MESSAGE_SCHEDULED_ENQUEUE,
      message,
      this.queueName,
      multi,
    );
    broker.enqueueMessage(message, multi);
  }

  //@todo Modify message from outside this function
  //@todo and make getNextScheduledTimestamp() return just values
  protected getNextScheduledTimestamp(message: Message): number | null {
    if (this.isSchedulable(message)) {
      // Delay
      const msgScheduledDelay = message.getMessageScheduledDelay();
      if (msgScheduledDelay && !message.isDelayed()) {
        message.setMessageDelayed(true);
        return Date.now() + msgScheduledDelay;
      }

      // CRON
      const msgScheduledCron = message.getMessageScheduledCRON();
      const cronTimestamp = msgScheduledCron
        ? parseExpression(msgScheduledCron).next().getTime()
        : 0;

      // Repeat
      const msgScheduledRepeat = message.getMessageScheduledRepeat();
      let repeatTimestamp = 0;
      if (msgScheduledRepeat) {
        const newCount = message.getMessageScheduledRepeatCount() + 1;
        if (newCount <= msgScheduledRepeat) {
          const msgScheduledPeriod = message.getMessageScheduledPeriod();
          const now = Date.now();
          if (msgScheduledPeriod) {
            repeatTimestamp = now + msgScheduledPeriod;
          } else {
            repeatTimestamp = now;
          }
        }
      }

      if (repeatTimestamp && cronTimestamp) {
        if (
          repeatTimestamp < cronTimestamp &&
          message.hasScheduledCronFired()
        ) {
          message.incrMessageScheduledRepeatCount();
          return repeatTimestamp;
        }
      }

      if (cronTimestamp) {
        // reset repeat count on each cron tick
        message.resetMessageScheduledRepeatCount();

        // if the message has also a repeat scheduling then the first time it will fires only
        // after CRON scheduling has been fired
        message.setMessageScheduledCronFired(true);

        return cronTimestamp;
      }

      if (repeatTimestamp) {
        message.incrMessageScheduledRepeatCount();
        return repeatTimestamp;
      }
    }
    return 0;
  }

  isSchedulable(message: Message): boolean {
    return (
      message.getMessageScheduledCRON() !== null ||
      message.getMessageScheduledDelay() !== null ||
      message.getMessageScheduledRepeat() > 0
    );
  }

  isPeriodic(message: Message): boolean {
    return (
      message.getMessageScheduledCRON() !== null ||
      message.getMessageScheduledRepeat() > 0
    );
  }

  schedule(
    message: Message,
    mixed: TRedisClientMulti | ICallback<boolean>,
  ): void {
    const timestamp = this.getNextScheduledTimestamp(message) ?? 0;
    if (timestamp > 0) {
      this.scheduleAtTimestamp(message, timestamp, mixed);
    } else if (typeof mixed === 'function') mixed(null, false);
  }

  deleteScheduledMessage(messageId: string, cb: ICallback<boolean>): void {
    const { keyQueueScheduledMessages, keyIndexScheduledMessages } = this.keys;
    const getMessage = (cb: ICallback<string>) => {
      if (!this.redisClientInstance)
        cb(new Error('Expected an instance of RedisClient'));
      else
        this.redisClientInstance.hget(keyIndexScheduledMessages, messageId, cb);
    };
    const deleteMessage = (msg: string | null, cb: ICallback<boolean>) => {
      if (msg) {
        if (!this.redisClientInstance)
          cb(new Error('Expected an instance of RedisClient'));
        else {
          const multi = this.redisClientInstance.multi();
          multi.zrem(keyQueueScheduledMessages, msg);
          multi.hdel(keyIndexScheduledMessages, messageId);
          this.emit(
            events.PRE_MESSAGE_SCHEDULED_DELETE,
            Message.createFromMessage(msg),
            this.queueName,
            multi,
          );
          this.redisClientInstance.execMulti(
            multi,
            (err?: Error | null, reply?: number[] | null) => {
              if (err) cb(err);
              else cb(null, reply && reply[0] === 1 && reply[1] === 1);
            },
          );
        }
      } else cb(null, false);
    };
    async.waterfall([getMessage, deleteMessage], cb);
  }

  getScheduledMessages(
    skip: number,
    take: number,
    cb: ICallback<TGetScheduledMessagesReply>,
  ): void {
    const { keyQueueScheduledMessages } = this.keys;
    if (skip < 0 || take <= 0) {
      cb(
        new Error(
          `Parameter [skip] should be >= 0. Parameter [take] should be >= 1.`,
        ),
      );
    } else {
      const getTotal = (cb: ICallback<number>) => {
        if (!this.redisClientInstance)
          cb(new Error('Expected an instance of RedisClient'));
        else this.redisClientInstance.zcard(keyQueueScheduledMessages, cb);
      };
      const getItems = (
        total: number,
        cb: ICallback<TGetScheduledMessagesReply>,
      ) => {
        if (!total) {
          cb(null, {
            total,
            items: [],
          });
        } else {
          if (!this.redisClientInstance)
            cb(new Error('Expected an instance of RedisClient'));
          else {
            this.redisClientInstance.zrange(
              keyQueueScheduledMessages,
              skip,
              skip + take - 1,
              (err, result) => {
                if (err) cb(err);
                else {
                  const items = (result ?? []).map((msg) =>
                    Message.createFromMessage(msg),
                  );
                  cb(null, { total, items });
                }
              },
            );
          }
        }
      };
      async.waterfall(
        [getTotal, getItems],
        (err?: Error | null, result?: TGetScheduledMessagesReply) => {
          if (err) cb(err);
          else cb(null, result);
        },
      );
    }
  }

  enqueueScheduledMessages(broker: Broker, cb: ICallback<void>): void {
    const now = Date.now();
    const { keyQueueScheduledMessages } = this.keys;
    const process = (messages: string[], cb: ICallback<void>) => {
      if (messages.length) {
        async.each<string, Error>(
          messages,
          (msg, done) => {
            if (!this.redisClientInstance)
              done(new Error('Expected an instance of RedisClient'));
            else {
              const message = Message.createFromMessage(msg);
              const multi = this.redisClientInstance.multi();
              this.enqueueScheduledMessage(broker, message, multi);
              this.scheduleAtNextTimestamp(message, multi);
              multi.exec(done);
            }
          },
          cb,
        );
      } else cb();
    };
    const fetch = (cb: ICallback<string[]>) => {
      if (!this.redisClientInstance)
        cb(new Error('Expected an instance of RedisClient'));
      else
        this.redisClientInstance.zrangebyscore(
          keyQueueScheduledMessages,
          0,
          now,
          cb,
        );
    };
    async.waterfall([fetch, process], cb);
  }

  static getInstance(
    queueName: string,
    config: IConfig,
    cb: TUnaryFunction<Scheduler>,
  ): void {
    RedisClient.getInstance(config, (client) =>
      cb(new Scheduler(queueName, client)),
    );
  }

  quit(): void {
    if (this.redisClientInstance) {
      this.redisClientInstance.end(true);
      this.redisClientInstance = null;
      this.emit(events.SCHEDULER_QUIT);
    }
  }
}
