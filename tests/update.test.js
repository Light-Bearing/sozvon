import {describe, expect, it, vi} from 'vitest';
import {checkForUpdate, refreshHard} from '../src/update.js';

const ответ = (body, ok = true) => vi.fn().mockResolvedValue({ok, json: async () => body});

describe('сборка замечает, что устарела', () => {
  it('на сайте новее — называем, какая', async () => {
    expect(await checkForUpdate({current: '0.18.1', fetchImpl: ответ({version: '0.19.0'})})).toBe(
      '0.19.0',
    );
  });

  it('та же версия — молчим', async () => {
    expect(await checkForUpdate({current: '0.18.1', fetchImpl: ответ({version: '0.18.1'})})).toBe(
      null,
    );
  });

  it('спрашиваем в обход всех кэшей', async () => {
    // Иначе кэш браузера или посредник по дороге отдал бы вчерашний ответ,
    // и устаревшая сборка считала бы себя свежей — ровно та беда, ради
    // которой всё это.
    const fetchImpl = ответ({version: '0.18.1'});

    await checkForUpdate({current: '0.18.1', fetchImpl});

    const [адрес, опции] = fetchImpl.mock.calls[0];
    expect(адрес).toMatch(/version\.json\?_=\d+$/);
    expect(опции).toEqual({cache: 'no-store'});
  });

  it('нет сети, ошибка сервера, испорченный ответ — молчим, а не пугаем', async () => {
    const упал = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await checkForUpdate({current: '1', fetchImpl: упал})).toBe(null);
    expect(await checkForUpdate({current: '1', fetchImpl: ответ({version: '2'}, false)})).toBe(null);
    expect(await checkForUpdate({current: '1', fetchImpl: ответ({})})).toBe(null);
    const кривой = vi.fn().mockResolvedValue({ok: true, json: async () => JSON.parse('{')});
    expect(await checkForUpdate({current: '1', fetchImpl: кривой})).toBe(null);
  });

  it('своей версии не знаем (сборка без неё) — не сравниваем', async () => {
    const fetchImpl = ответ({version: '9'});
    expect(await checkForUpdate({current: '', fetchImpl})).toBe(null);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('обновиться одним нажатием', () => {
  it('снимает воркер, стирает его кэш и загружает заново', async () => {
    // То же, что человек делал руками, когда «сброс кэша помогает».
    const unregister = vi.fn().mockResolvedValue(true);
    const sw = {getRegistrations: vi.fn().mockResolvedValue([{unregister}, {unregister}])};
    const cacheStorage = {
      keys: vi.fn().mockResolvedValue(['sozvon-v1']),
      delete: vi.fn().mockResolvedValue(true),
    };
    const reload = vi.fn();

    await refreshHard({sw, cacheStorage, reload});

    expect(unregister).toHaveBeenCalledTimes(2);
    expect(cacheStorage.delete).toHaveBeenCalledWith('sozvon-v1');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('не дали снять воркер или стереть кэш — всё равно перезагружаемся', async () => {
    const reload = vi.fn();

    await refreshHard({
      sw: {getRegistrations: vi.fn().mockRejectedValue(new Error('SecurityError'))},
      cacheStorage: {keys: vi.fn().mockRejectedValue(new Error('SecurityError'))},
      reload,
    });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('браузер без воркеров и кэша — просто перезагрузка', async () => {
    const reload = vi.fn();

    await refreshHard({sw: undefined, cacheStorage: undefined, reload});

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
