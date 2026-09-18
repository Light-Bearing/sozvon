// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createAwake} from '../src/awake.js';

// jsdom не знает ни про блокировку экрана, ни про смену видимости —
// подставляем и то и другое.
const видимость = state =>
  Object.defineProperty(document, 'visibilityState', {value: state, configurable: true});

const поддельнаяБлокировка = () => {
  const слушатели = [];
  return {
    release: vi.fn().mockResolvedValue(undefined),
    addEventListener: (_имя, fn) => слушатели.push(fn),
    снять: () => слушатели.forEach(fn => fn()),
  };
};

const датьБлокировку = (лок = поддельнаяБлокировка()) => {
  const request = vi.fn().mockResolvedValue(лок);
  Object.defineProperty(navigator, 'wakeLock', {value: {request}, configurable: true});
  return {лок, request};
};

const убратьБлокировку = () =>
  Object.defineProperty(navigator, 'wakeLock', {value: undefined, configurable: true});

// Слушатель висит на общем для всего файла document: недоглядев, получишь
// тест, в котором «лишний» вызов приходит от соседа сверху.
const созданные = [];
const создать = опции => {
  const awake = createAwake(опции);
  созданные.push(awake);
  return awake;
};

afterEach(async () => {
  for (const awake of созданные) await awake.stop();
  созданные.length = 0;
  видимость('visible');
  убратьБлокировку();
});

describe('экран не гаснет, пока идёт разговор', () => {
  it('на старте просит блокировку', async () => {
    const {request} = датьБлокировку();
    const awake = создать();

    await awake.start();

    expect(request).toHaveBeenCalledWith('screen');
    expect(awake.held()).toBe(true);
  });

  it('из скрытой страницы не просит вовсе', async () => {
    // Блокировку дают только видимой странице: просьба из скрытой — верный
    // отказ, и шуметь им незачем.
    const {request} = датьБлокировку();
    видимость('hidden');
    const awake = создать();

    await awake.start();

    expect(request).not.toHaveBeenCalled();
    expect(awake.held()).toBe(false);
  });

  it('телефон снял блокировку — просим заново, когда вернулись', async () => {
    const {лок, request} = датьБлокировку();
    const awake = создать();
    await awake.start();

    // Экран погас: телефон снимает блокировку сам.
    лок.снять();
    expect(awake.held()).toBe(false);

    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('пока страница скрыта, возвращением не считается', async () => {
    датьБлокировку();
    const разбудили = vi.fn();
    const awake = создать({onWake: разбудили});
    await awake.start();

    видимость('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(разбудили).not.toHaveBeenCalled();
  });

  it('вернулись — зовём вернуть отобранное', async () => {
    датьБлокировку();
    const разбудили = vi.fn();
    const awake = создать({onWake: разбудили});
    await awake.start();

    document.dispatchEvent(new Event('visibilitychange'));

    expect(разбудили).toHaveBeenCalledTimes(1);
  });

  it('повесили трубку — блокировку отпускаем и больше не слушаем', async () => {
    const {лок} = датьБлокировку();
    const разбудили = vi.fn();
    const awake = создать({onWake: разбудили});
    await awake.start();

    await awake.stop();
    document.dispatchEvent(new Event('visibilitychange'));

    expect(лок.release).toHaveBeenCalled();
    expect(awake.held()).toBe(false);
    expect(разбудили).not.toHaveBeenCalled();
  });

  it('браузер блокировку не умеет — разговор всё равно идёт', async () => {
    // Отсутствие необязательной возможности не должно ронять звонок: без
    // блокировки экран просто гаснет, а поднимать нас будет onWake.
    убратьБлокировку();
    const awake = создать();

    await expect(awake.start()).resolves.toBeUndefined();
    expect(awake.held()).toBe(false);
    await expect(awake.stop()).resolves.toBeUndefined();
  });

  it('блокировку запретили — тоже не падаем', async () => {
    Object.defineProperty(navigator, 'wakeLock', {
      value: {request: vi.fn().mockRejectedValue(new Error('NotAllowedError'))},
      configurable: true,
    });
    const awake = создать();

    await expect(awake.start()).resolves.toBeUndefined();
    expect(awake.held()).toBe(false);
  });
});
