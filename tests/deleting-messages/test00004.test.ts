import {
  getMessageManagerFrontend,
  getQueueManagerFrontend,
  produceAndDeadLetterMessage,
} from '../common';
import { Message } from '../../src/message';
import { promisifyAll } from 'bluebird';

test('Combined test: Delete a dead-letter message. Check pending, acknowledged, and dead-letter messages. Check queue metrics.', async () => {
  const { queue, message } = await produceAndDeadLetterMessage();

  const messageManager = promisifyAll(await getMessageManagerFrontend());
  const res1 = await messageManager.getPendingMessagesAsync(queue, 0, 100);
  expect(res1.total).toBe(0);
  expect(res1.items.length).toBe(0);

  const res2 = await messageManager.getAcknowledgedMessagesAsync(queue, 0, 100);
  expect(res2.total).toBe(0);
  expect(res2.items.length).toBe(0);

  const res3 = await messageManager.getDeadLetteredMessagesAsync(queue, 0, 100);
  expect(res3.total).toBe(1);
  expect(res3.items.length).toBe(1);
  const msg1 = Message.createFromMessage(message).setAttempts(2);
  expect(res3.items[0].message).toEqual(msg1);

  const queueManager = promisifyAll(await getQueueManagerFrontend());
  const queueMetrics = await queueManager.getQueueMetricsAsync(queue);
  expect(queueMetrics.pending).toBe(0);
  expect(queueMetrics.acknowledged).toBe(0);
  expect(queueMetrics.deadLettered).toBe(1);

  await messageManager.deleteDeadLetterMessageAsync(queue, 0, message.getId());

  const res4 = await messageManager.getDeadLetteredMessagesAsync(queue, 0, 100);

  expect(res4.total).toBe(0);
  expect(res4.items.length).toBe(0);

  const queueMetrics1 = await queueManager.getQueueMetricsAsync(queue);
  expect(queueMetrics1.deadLettered).toBe(0);

  await expect(async () => {
    await messageManager.deleteDeadLetterMessageAsync(
      queue,
      0,
      message.getId(),
    );
  }).rejects.toThrow(
    'Either message parameters are invalid or the message has been already deleted',
  );
});
