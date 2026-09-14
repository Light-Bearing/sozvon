import {describe, expect, it} from 'vitest';
import {createSpeakingTracker, levelFrom, SPEAKING} from '../src/speaking.js';

const fakeClock = () => {
  let t = 0;
  return {now: () => t, advance: ms => (t += ms)};
};

describe('громкость', () => {
  it('тишина — это ноль', () => {
    expect(levelFrom(new Float32Array(128))).toBe(0);
  });

  it('громче звук — больше число', () => {
    const quiet = levelFrom(Float32Array.from({length: 128}, () => 0.05));
    const loud = levelFrom(Float32Array.from({length: 128}, () => 0.8));
    expect(loud).toBeGreaterThan(quiet);
  });

  it('знак не важен — считается размах, а не направление', () => {
    const up = levelFrom(Float32Array.from({length: 64}, () => 0.5));
    const down = levelFrom(Float32Array.from({length: 64}, () => -0.5));
    expect(up).toBeCloseTo(down);
  });

  it('пустой набор не ломает счёт', () => {
    expect(levelFrom(new Float32Array(0))).toBe(0);
  });
});

describe('кто говорит', () => {
  it('в тишине говорящего нет', () => {
    const t = createSpeakingTracker({now: fakeClock().now});
    t.report('петя', 0);
    expect(t.speaker()).toBeNull();
  });

  it('говорящий — самый громкий из тех, кто выше порога', () => {
    const t = createSpeakingTracker({now: fakeClock().now});
    t.report('петя', SPEAKING.threshold + 0.1);
    t.report('маша', SPEAKING.threshold + 0.3);
    expect(t.speaker()).toBe('маша');
  });

  it('шёпот ниже порога говорящим не делает', () => {
    const t = createSpeakingTracker({now: fakeClock().now});
    t.report('петя', SPEAKING.threshold - 0.01);
    expect(t.speaker()).toBeNull();
  });

  it('говорящий держится в паузах между словами', () => {
    const clock = fakeClock();
    const t = createSpeakingTracker({now: clock.now});
    t.report('петя', SPEAKING.threshold + 0.2);
    clock.advance(SPEAKING.holdMs - 100);
    t.report('петя', 0);
    expect(t.speaker()).toBe('петя');
  });

  it('замолчавший надолго перестаёт быть говорящим', () => {
    const clock = fakeClock();
    const t = createSpeakingTracker({now: clock.now});
    t.report('петя', SPEAKING.threshold + 0.2);
    clock.advance(SPEAKING.holdMs + 100);
    t.report('петя', 0);
    expect(t.speaker()).toBeNull();
  });

  it('перебивший громче забирает слово', () => {
    const clock = fakeClock();
    const t = createSpeakingTracker({now: clock.now});
    t.report('петя', SPEAKING.threshold + 0.1);
    clock.advance(100);
    t.report('маша', SPEAKING.threshold + 0.5);
    expect(t.speaker()).toBe('маша');
  });
});
