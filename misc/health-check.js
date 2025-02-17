'use strict';
const { events } = require('../dist/src/system/common/events');
const { Consumer, Producer, Message } = require('..');
const { waterfall } = require('../dist/src/system/lib/async');

const queue = 'test_queue';
const producer = new Producer();

const produceForever = () => {
  if (producer.isGoingUp() || producer.isRunning()) {
    const message = new Message().setBody('some data').setQueue(queue); // using the default namespace
    producer.produce(message, (err) => {
      if (err) console.log(err);
      // else console.log(`Message ${message.getId()} published`);
      produceForever();
    });
  }
};

const consumer = new Consumer();

consumer.consume(
  queue, // using the default namespace
  false,
  (message, cb) => {
    console.log(`Message ${message.getRequiredId()} consumed`);
    cb();
  },
  () => void 0,
);

consumer.on(events.UP, () => {
  console.log('UP');
});

consumer.on(events.DOWN, () => {
  console.log('DOWN');
});

const serialOnOff = (cb) =>
  waterfall(
    [
      (cb) => consumer.run(() => cb()), // not return the status to the next
      (cb) => consumer.shutdown(() => cb()),
      (cb) => consumer.run(() => cb()),
      (cb) => consumer.shutdown(() => cb()),
      (cb) => consumer.run(() => cb()),
      (cb) => consumer.shutdown(() => cb()),
      (cb) => consumer.run(() => cb()),
      (cb) => consumer.shutdown(() => cb()),
      (cb) => consumer.run(() => cb()),
      (cb) => consumer.shutdown(() => cb()),
    ],
    cb,
  );

waterfall(
  [
    (cb) => {
      produceForever();
      cb();
    },
    serialOnOff,
  ],
  (err) => {
    if (err) console.log(err);
    else {
      producer.shutdown();
      consumer.shutdown(() => console.log('Done!'));
    }
  },
);
