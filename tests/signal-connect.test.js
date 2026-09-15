import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {waitUntilAlive, WAIT_FOR_LIFE_MS} from '../src/signal/index.js';

// Находка 5: joinPublicChannels() никогда не отклонялся, и ожидание ничем
// не было ограничено. Если недоступны все трекеры, релеи и брокеры разом
// (корпоративная сеть, блокировки), createRoom спокойно выполнялся, экран
// звонка рисовался, и обе стороны бесконечно сидели на «жду, когда зайдут».
// waitUntilAlive — сердце починки: проверяем саму механику ожидания
// отдельно от настоящих каналов и настоящей криптографии connect().
describe('waitUntilAlive: ждём признаков жизни, но не вечно', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('не ждёт вовсе, если признак жизни уже есть', async () => {
    await expect(waitUntilAlive(() => true)).resolves.toBeUndefined();
  });

  it('сдаётся по истечении отведённого времени, если признаков жизни так и не появилось', async () => {
    const promise = waitUntilAlive(() => false, WAIT_FOR_LIFE_MS);
    const assertion = expect(promise).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(WAIT_FOR_LIFE_MS);
    await assertion;
  });

  it('дожидается момента, когда признак жизни появляется, и не ждёт дольше', async () => {
    let alive = false;
    setTimeout(() => (alive = true), 2_000); // «канал ожил» на второй секунде

    const promise = waitUntilAlive(() => alive, WAIT_FOR_LIFE_MS);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(promise).resolves.toBeUndefined();
  });

  it('ошибка отказа — человеческая по типу (не падает на getUserMedia-подобные имена), диагностика решит остальное', async () => {
    const promise = waitUntilAlive(() => false, WAIT_FOR_LIFE_MS);
    const assertion = promise.catch(error => error);

    await vi.advanceTimersByTimeAsync(WAIT_FOR_LIFE_MS);
    const error = await assertion;

    expect(error).toBeInstanceOf(Error);
    // Имя не должно совпасть ни с одним из кейсов explainFailure() для
    // ошибок доступа к камере — иначе экран «не вышло» соврёт про камеру.
    expect(['NotAllowedError', 'NotFoundError', 'NotReadableError']).not.toContain(error.name);
  });
});
