import {afterEach, describe, expect, it, vi} from 'vitest';
import {keepRelaysTrying} from '../src/signal/keep-trying.js';

// Та же механика блокировки, что у библиотеки (core/utils.mjs): «возобновить»
// снимает блокировку следующим микрошагом, ждавшие каналы стартуют после.
const library = () => {
  let lock = null;
  let resolver = null;
  const starts = [];
  return {
    starts,
    paused: () => Boolean(lock),
    pause: () => {
      if (!lock) {
        lock = new Promise(r => (resolver = r)).finally(() => {
          resolver = null;
          lock = null;
        });
      }
    },
    resume: () => resolver?.(),
    // Канал закрылся: при блокировке — ждёт её, иначе ушёл бы на
    // наращивание паузы (и в конце концов сдался бы).
    close: name => (lock ? lock.then(() => starts.push(name)) : starts.push(`${name}: наращивание`)),
  };
};

afterEach(() => vi.useRealTimers());

describe('каналы не сдаются', () => {
  it('сразу приостанавливает переподключение', () => {
    const lib = library();
    const stop = keepRelaysTrying(lib);

    expect(lib.paused()).toBe(true);
    stop();
  });

  it('раз в несколько секунд отпускает ждущие каналы и снова приостанавливает', async () => {
    vi.useFakeTimers();
    const lib = library();
    const stop = keepRelaysTrying({...lib, every: 4000});
    lib.close('nostr-1');

    await vi.advanceTimersByTimeAsync(4000);

    expect(lib.starts).toEqual(['nostr-1']);
    // Снова приостановлено: следующий закрывшийся снова ждёт, а не уходит
    // на наращивание паузы.
    expect(lib.paused()).toBe(true);
    lib.close('nostr-2');
    await vi.advanceTimersByTimeAsync(4000);
    expect(lib.starts).toEqual(['nostr-1', 'nostr-2']);
    stop();
  });

  it('и так сколько угодно долго — ни разу не на наращивание', async () => {
    vi.useFakeTimers();
    const lib = library();
    const stop = keepRelaysTrying({...lib, every: 4000});
    for (let i = 0; i < 30; i++) {
      lib.close(`попытка-${i}`);
      await vi.advanceTimersByTimeAsync(4000);
    }

    expect(lib.starts.some(s => s.includes('наращивание'))).toBe(false);
    expect(lib.starts).toHaveLength(30);
    stop();
  });

  it('остановили — блокировку отпускаем, библиотека снова сама', () => {
    const lib = library();
    const stop = keepRelaysTrying(lib);

    stop();

    return Promise.resolve().then(() => expect(lib.paused()).toBe(false));
  });
});
