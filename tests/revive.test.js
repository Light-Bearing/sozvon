import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {GRACE_MS, reviveOnDrop} from '../src/revive.js';

// Поддельное соединение: нам важны только состояние, слушатели и то,
// позвали ли перезапуск.
const поддельное = (connectionState = 'connected') => {
  const слушатели = new Map();
  return {
    connectionState,
    restartIce: vi.fn(),
    addEventListener: (имя, fn) => слушатели.set(имя, [...(слушатели.get(имя) ?? []), fn]),
    removeEventListener: (имя, fn) =>
      слушатели.set(имя, (слушатели.get(имя) ?? []).filter(x => x !== fn)),
    стать(state) {
      this.connectionState = state;
      for (const fn of слушатели.get('connectionstatechange') ?? []) fn();
    },
  };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('обрыв пути лечится перезапуском, а не разрывом', () => {
  it('связь провалилась и не вернулась — ищем путь заново', () => {
    const pc = поддельное();
    reviveOnDrop(pc);

    pc.стать('disconnected');
    vi.advanceTimersByTime(GRACE_MS);

    expect(pc.restartIce).toHaveBeenCalledTimes(1);
  });

  it('моргнуло и прошло — не трогаем', () => {
    // Короткие провалы залечиваются сами; перезапуск на каждом — лишняя
    // пересылка на ровном месте.
    const pc = поддельное();
    reviveOnDrop(pc);

    pc.стать('disconnected');
    vi.advanceTimersByTime(GRACE_MS / 2);
    pc.стать('connected');
    vi.advanceTimersByTime(GRACE_MS * 3);

    expect(pc.restartIce).not.toHaveBeenCalled();
  });

  it('одна попытка на один провал', () => {
    // Если перезапуск не помог, слать предложения раз в секунду в мёртвое
    // соединение бессмысленно: дальше сработает закрытие по таймеру
    // библиотеки и поиск собеседника заново.
    const pc = поддельное();
    reviveOnDrop(pc);

    pc.стать('disconnected');
    vi.advanceTimersByTime(GRACE_MS);
    pc.стать('disconnected');
    vi.advanceTimersByTime(GRACE_MS * 5);

    expect(pc.restartIce).toHaveBeenCalledTimes(1);
  });

  it('связь вернулась — следующий провал снова лечим', () => {
    const pc = поддельное();
    reviveOnDrop(pc);
    pc.стать('disconnected');
    vi.advanceTimersByTime(GRACE_MS);

    pc.стать('connected');
    pc.стать('disconnected');
    vi.advanceTimersByTime(GRACE_MS);

    expect(pc.restartIce).toHaveBeenCalledTimes(2);
  });

  it('соединение уже закрыто — воскрешать нечего', () => {
    const pc = поддельное();
    reviveOnDrop(pc);

    pc.стать('failed');
    vi.advanceTimersByTime(GRACE_MS * 5);

    expect(pc.restartIce).not.toHaveBeenCalled();
  });

  it('отписались — больше не вмешиваемся', () => {
    const pc = поддельное();
    const стоп = reviveOnDrop(pc);

    стоп();
    pc.стать('disconnected');
    vi.advanceTimersByTime(GRACE_MS * 5);

    expect(pc.restartIce).not.toHaveBeenCalled();
  });

  it('браузер не умеет перезапуск — не падаем', () => {
    // Старые браузеры знают только пересоздание соединения. Разговор от
    // отсутствия необязательной возможности падать не должен.
    const pc = поддельное();
    pc.restartIce = undefined;
    reviveOnDrop(pc);

    pc.стать('disconnected');

    expect(() => vi.advanceTimersByTime(GRACE_MS)).not.toThrow();
  });

  it('подписались к уже провалившемуся — лечим и его', () => {
    const pc = поддельное('disconnected');

    reviveOnDrop(pc);
    vi.advanceTimersByTime(GRACE_MS);

    expect(pc.restartIce).toHaveBeenCalledTimes(1);
  });
});
