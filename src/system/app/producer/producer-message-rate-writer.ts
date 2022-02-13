import { MessageRateWriter } from '../../common/message-rate-writer';
import { ICallback, IProducerMessageRateFields } from '../../../../types';
import { RedisClient } from '../../common/redis-client/redis-client';
import { QueuePublishedTimeSeries } from './producer-time-series/queue-published-time-series';
import { GlobalPublishedTimeSeries } from './producer-time-series/global-published-time-series';

export class ProducerMessageRateWriter extends MessageRateWriter<IProducerMessageRateFields> {
  protected redisClient: RedisClient;
  protected globalPublishedTimeSeries: ReturnType<
    typeof GlobalPublishedTimeSeries
  >;
  protected queuePublishedTimeSeries: Record<
    string,
    ReturnType<typeof QueuePublishedTimeSeries>
  > = {};

  constructor(redisClient: RedisClient) {
    super();
    this.redisClient = redisClient;
    this.globalPublishedTimeSeries = GlobalPublishedTimeSeries(redisClient);
  }

  onUpdate(
    ts: number,
    rates: IProducerMessageRateFields,
    cb: ICallback<void>,
  ): void {
    const { publishedRate, queuePublishedRate } = rates;
    if (Object.keys(queuePublishedRate).length) {
      if (publishedRate) {
        const multi = this.redisClient.multi();
        this.globalPublishedTimeSeries.add(ts, publishedRate, multi);
        for (const key in queuePublishedRate) {
          const value = queuePublishedRate[key];
          if (value) {
            if (!this.queuePublishedTimeSeries[key]) {
              const [ns, name] = key.split(':');
              this.queuePublishedTimeSeries[key] = QueuePublishedTimeSeries(
                this.redisClient,
                { ns, name },
              );
            }
            this.queuePublishedTimeSeries[key].add(ts, value, multi);
          }
        }
        this.redisClient.execMulti(multi, () => cb());
      } else cb();
    } else cb();
  }
}
