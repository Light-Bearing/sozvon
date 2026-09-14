import {describe, expect, it} from 'vitest';
import {createLadder, HEALTH, stepForPeers, STEPS} from '../src/ladder.js';

const fakeClock = () => {
  let t = 0;
  return {now: () => t, advance: ms => (t += ms)};
};

describe('ступень по числу участников', () => {
  it('вдвоём — полное качество', () => {
    expect(stepForPeers(2).name).toBe('full');
    expect(stepForPeers(2).videoFor).toBe('all');
  });

  it('вчетвером — мельче, но видео у всех', () => {
    expect(stepForPeers(4).name).toBe('small');
    expect(stepForPeers(4).videoFor).toBe('all');
  });

  it('вшестером — видео только у говорящего', () => {
    expect(stepForPeers(6).videoFor).toBe('speaker');
  });

  it('вдесятером — голосовой режим', () => {
    expect(stepForPeers(10).videoFor).toBe('none');
  });

  it('для любого числа ступень находится', () => {
    for (const n of [1, 2, 3, 7, 9, 40, 500]) expect(stepForPeers(n)).toBeDefined();
  });
});

describe('спуск и подъём по связи', () => {
  it('держится на своей ступени, пока связь в порядке', () => {
    const clock = fakeClock();
    const ladder = createLadder({now: clock.now});
    for (let i = 0; i < 20; i++) {
      clock.advance(1000);
      expect(ladder.update({peerCount: 2, loss: 0, queueSeconds: 0}).name).toBe('full');
    }
  });

  it('не спускается от короткого всплеска потерь', () => {
    const clock = fakeClock();
    const ladder = createLadder({now: clock.now});
    ladder.update({peerCount: 2, loss: 0.2, queueSeconds: 0});
    clock.advance(HEALTH.badForMs - 1000);
    expect(ladder.update({peerCount: 2, loss: 0.2, queueSeconds: 0}).name).toBe('full');
  });

  it('спускается, когда потери держатся положенное время', () => {
    const clock = fakeClock();
    const ladder = createLadder({now: clock.now});
    ladder.update({peerCount: 2, loss: 0.2, queueSeconds: 0});
    clock.advance(HEALTH.badForMs);
    expect(ladder.update({peerCount: 2, loss: 0.2, queueSeconds: 0}).name).toBe('small');
  });

  it('длинная очередь отправки тоже считается бедой', () => {
    const clock = fakeClock();
    const ladder = createLadder({now: clock.now});
    ladder.update({peerCount: 2, loss: 0, queueSeconds: 2});
    clock.advance(HEALTH.badForMs);
    expect(ladder.update({peerCount: 2, loss: 0, queueSeconds: 2}).name).toBe('small');
  });

  it('поднимается обратно только после долгого спокойствия', () => {
    const clock = fakeClock();
    const ladder = createLadder({now: clock.now});
    ladder.update({peerCount: 2, loss: 0.2, queueSeconds: 0});
    clock.advance(HEALTH.badForMs);
    ladder.update({peerCount: 2, loss: 0.2, queueSeconds: 0});

    ladder.update({peerCount: 2, loss: 0, queueSeconds: 0});
    clock.advance(HEALTH.goodForMs - 1000);
    expect(ladder.update({peerCount: 2, loss: 0, queueSeconds: 0}).name).toBe('small');

    clock.advance(1000);
    expect(ladder.update({peerCount: 2, loss: 0, queueSeconds: 0}).name).toBe('full');
  });

  it('ниже последней ступени не падает', () => {
    const clock = fakeClock();
    const ladder = createLadder({now: clock.now});
    for (let i = 0; i < STEPS.length + 3; i++) {
      ladder.update({peerCount: 20, loss: 0.5, queueSeconds: 5});
      clock.advance(HEALTH.badForMs);
    }
    expect(ladder.update({peerCount: 20, loss: 0.5, queueSeconds: 5}).name)
      .toBe(STEPS.at(-1).name);
  });
});
