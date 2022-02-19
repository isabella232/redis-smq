import { ConsumerAcknowledgedTimeSeries } from './consumer-time-series/consumer-acknowledged-time-series';
import { ConsumerDeadLetteredTimeSeries } from './consumer-time-series/consumer-dead-lettered-time-series';
import { QueueAcknowledgedTimeSeries } from './consumer-time-series/queue-acknowledged-time-series';
import { QueueDeadLetteredTimeSeries } from './consumer-time-series/queue-dead-lettered-time-series';
import { GlobalAcknowledgedTimeSeries } from './consumer-time-series/global-acknowledged-time-series';
import { GlobalDeadLetteredTimeSeries } from './consumer-time-series/global-dead-lettered-time-series';
import { RedisClient } from '../../common/redis-client/redis-client';
import {
  ICallback,
  IConsumerMessageRateFields,
  TQueueParams,
  TRedisClientMulti,
} from '../../../../types';
import { MessageRateWriter } from '../../common/message-rate-writer';

export class ConsumerMessageRateWriter extends MessageRateWriter<IConsumerMessageRateFields> {
  protected redisClient: RedisClient;
  protected acknowledgedTimeSeries: ReturnType<
    typeof ConsumerAcknowledgedTimeSeries
  >;
  protected deadLetteredTimeSeries: ReturnType<
    typeof ConsumerDeadLetteredTimeSeries
  >;
  protected queueAcknowledgedRateTimeSeries: ReturnType<
    typeof QueueAcknowledgedTimeSeries
  >;
  protected queueDeadLetteredTimeSeries: ReturnType<
    typeof QueueDeadLetteredTimeSeries
  >;
  protected globalAcknowledgedRateTimeSeries: ReturnType<
    typeof GlobalAcknowledgedTimeSeries
  >;
  protected globalDeadLetteredTimeSeries: ReturnType<
    typeof GlobalDeadLetteredTimeSeries
  >;
  constructor(
    redisClient: RedisClient,
    queue: TQueueParams,
    consumerId: string,
  ) {
    super();
    this.redisClient = redisClient;
    this.globalAcknowledgedRateTimeSeries =
      GlobalAcknowledgedTimeSeries(redisClient);
    this.globalDeadLetteredTimeSeries =
      GlobalDeadLetteredTimeSeries(redisClient);
    this.acknowledgedTimeSeries = ConsumerAcknowledgedTimeSeries(
      redisClient,
      consumerId,
    );
    this.deadLetteredTimeSeries = ConsumerDeadLetteredTimeSeries(
      redisClient,
      consumerId,
    );
    this.queueAcknowledgedRateTimeSeries = QueueAcknowledgedTimeSeries(
      redisClient,
      queue,
    );
    this.queueDeadLetteredTimeSeries = QueueDeadLetteredTimeSeries(
      redisClient,
      queue,
    );
  }

  onUpdate(
    ts: number,
    rates: IConsumerMessageRateFields,
    cb: ICallback<void>,
  ): void {
    let multi: TRedisClientMulti | null = null;
    for (const field in rates) {
      multi = multi ?? this.redisClient.multi();
      const value: number = rates[field];
      if (value) {
        if (field === 'acknowledgedRate') {
          this.acknowledgedTimeSeries.add(ts, value, multi);
          this.queueAcknowledgedRateTimeSeries.add(ts, value, multi);
          this.globalAcknowledgedRateTimeSeries.add(ts, value, multi);
        } else {
          this.deadLetteredTimeSeries.add(ts, value, multi);
          this.queueDeadLetteredTimeSeries.add(ts, value, multi);
          this.globalDeadLetteredTimeSeries.add(ts, value, multi);
        }
      }
    }
    if (multi) this.redisClient.execMulti(multi, () => cb());
    else cb();
  }
}
