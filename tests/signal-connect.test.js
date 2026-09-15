import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import {watchForLife, QUIET_HINT_AFTER_MS} from '../src/signal/index.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Здесь стояла проверка предела ожидания, который ОТКЛОНЯЛ подключение
// через 45 секунд. Тот предел оказался вреден: проверка «канал жив»
// сверяет адреса строка в строку с тем, что отдаёт библиотека, и одно
// расхождение ключа делало её навсегда ложной — вместе с исправным
// звонком, в том числе по одному Wi-Fi, где соединение обязано вставать
// сразу. Наблюдение осталось, право убивать звонок — нет.
describe('наблюдение за признаками жизни', () => {
  it('когда канал жив сразу — про молчание не заикается', () => {
    const onQuiet = vi.fn();
    const stop = watchForLife(() => true, onQuiet);

    vi.advanceTimersByTime(QUIET_HINT_AFTER_MS * 3);

    expect(onQuiet).not.toHaveBeenCalledWith(true);
    stop();
  });

  it('когда признаков жизни долго нет — подсказывает, но ничего не ломает', () => {
    const onQuiet = vi.fn();
    const stop = watchForLife(() => false, onQuiet);

    vi.advanceTimersByTime(QUIET_HINT_AFTER_MS - 1000);
    expect(onQuiet).not.toHaveBeenCalledWith(true);

    vi.advanceTimersByTime(1000);
    expect(onQuiet).toHaveBeenCalledWith(true);
    stop();
  });

  it('подсказывает один раз, а не на каждом опросе', () => {
    const onQuiet = vi.fn();
    const stop = watchForLife(() => false, onQuiet);

    vi.advanceTimersByTime(QUIET_HINT_AFTER_MS * 4);

    expect(onQuiet.mock.calls.filter(([q]) => q === true)).toHaveLength(1);
    stop();
  });

  it('ожил после молчания — подсказка снимается', () => {
    let alive = false;
    const onQuiet = vi.fn();
    const stop = watchForLife(() => alive, onQuiet);

    vi.advanceTimersByTime(QUIET_HINT_AFTER_MS);
    expect(onQuiet).toHaveBeenCalledWith(true);

    alive = true;
    vi.advanceTimersByTime(1000);
    expect(onQuiet).toHaveBeenLastCalledWith(false);
    stop();
  });

  it('остановка прекращает опрос', () => {
    const alive = vi.fn(() => false);
    const stop = watchForLife(alive, vi.fn());

    vi.advanceTimersByTime(2000);
    const before = alive.mock.calls.length;
    stop();
    vi.advanceTimersByTime(10_000);

    expect(alive.mock.calls.length).toBe(before);
  });
});
