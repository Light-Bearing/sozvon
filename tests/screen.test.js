import {describe, expect, it, vi} from 'vitest';
import {createMedia} from '../src/media.js';
import {stepForPeers} from '../src/ladder.js';

const FULL = stepForPeers(1);

const fakeTrack = (kind, label = '') => {
  const listeners = {};
  return {
    kind,
    label,
    readyState: 'live',
    enabled: true,
    stop: vi.fn(function () {
      this.readyState = 'ended';
    }),
    addEventListener: (name, fn) => (listeners[name] = fn),
    end: () => listeners.ended?.(),
  };
};

const fakeStream = (...tracks) => {
  const list = [...tracks];
  return {
    getTracks: () => list,
    getVideoTracks: () => list.filter(t => t.kind === 'video'),
    getAudioTracks: () => list.filter(t => t.kind === 'audio'),
    addTrack: t => list.push(t),
    removeTrack: t => list.splice(list.indexOf(t), 1),
  };
};

describe('демонстрация экрана', () => {
  it('без поддержки в браузере честно отвечает «нельзя», а не падает', async () => {
    const media = createMedia({getUserMedia: vi.fn(), getDisplayMedia: undefined});

    expect(media.canShareScreen()).toBe(false);
    expect(await media.useScreen(true, FULL)).toBe(null);
  });

  it('картинка экрана НЕ попадает в общий поток', async () => {
    const экран = fakeTrack('video', 'экран');
    const media = createMedia({
      getUserMedia: vi.fn().mockResolvedValue(fakeStream(fakeTrack('audio'))),
      getDisplayMedia: vi.fn().mockResolvedValue(fakeStream(экран)),
    });
    await media.captureMicrophone(FULL);

    const итог = await media.useScreen(true, FULL);

    expect(итог.added).toBe(экран);
    // Общий поток остаётся при своём: там лицо и звук, экран отдельно.
    expect(media.current().getVideoTracks()).toEqual([]);
  });

  // Лицо и экран идут ВМЕСТЕ, каждое своей дорожкой. Различает их пометка
  // на дорожке (см. onPeerTrack в src/signal/public-channels.js).
  it('экран добавляется к камере, а не заменяет её', async () => {
    const камера = fakeTrack('video', 'камера');
    const экран = fakeTrack('video', 'экран');
    const media = createMedia({
      getUserMedia: vi.fn().mockResolvedValue(fakeStream(камера)),
      getDisplayMedia: vi.fn().mockResolvedValue(fakeStream(экран)),
    });
    await media.captureCamera(FULL);

    const итог = await media.useScreen(true, FULL);

    expect(итог.added).toBe(экран);
    expect(камера.stop).not.toHaveBeenCalled();
    // Экран в СВОЁМ потоке: общий остаётся при своём лице.
    expect(media.current().getVideoTracks()).toEqual([камера]);
    expect(media.screen().getVideoTracks()).toEqual([экран]);
  });

  it('выключение экрана убирает только его, камера остаётся', async () => {
    const камера = fakeTrack('video', 'камера');
    const экран = fakeTrack('video', 'экран');
    const media = createMedia({
      getUserMedia: vi.fn().mockResolvedValue(fakeStream(камера)),
      getDisplayMedia: vi.fn().mockResolvedValue(fakeStream(экран)),
    });
    await media.captureCamera(FULL);
    await media.useScreen(true, FULL);

    const итог = await media.useScreen(false, FULL);

    expect(итог).toEqual({removed: экран});
    expect(экран.stop).toHaveBeenCalled();
    expect(media.current().getVideoTracks()).toEqual([камера]);
    expect(media.screen()).toBe(null);
  });

  // Выключатель камеры, лестница качества и освобождение устройства не
  // должны трогать экран: это разные картинки.
  it('выключение камеры не гасит показ экрана', async () => {
    const камера = fakeTrack('video', 'камера');
    const экран = fakeTrack('video', 'экран');
    const media = createMedia({
      getUserMedia: vi.fn().mockResolvedValue(fakeStream(камера)),
      getDisplayMedia: vi.fn().mockResolvedValue(fakeStream(экран)),
    });
    await media.captureCamera(FULL);
    await media.useScreen(true, FULL);

    media.setCamera(false);

    expect(камера.enabled).toBe(false);
    expect(экран.enabled).toBe(true);
  });

  it('освобождение камеры не останавливает экран', async () => {
    const камера = fakeTrack('video', 'камера');
    const экран = fakeTrack('video', 'экран');
    const media = createMedia({
      getUserMedia: vi.fn().mockResolvedValue(fakeStream(камера)),
      getDisplayMedia: vi.fn().mockResolvedValue(fakeStream(экран)),
    });
    await media.captureCamera(FULL);
    await media.useScreen(true, FULL);

    const снятые = media.releaseCamera();

    expect(снятые).toEqual([камера]);
    expect(экран.stop).not.toHaveBeenCalled();
    expect(media.screen().getVideoTracks()).toEqual([экран]);
  });

  it('человек нажал «прекратить показ» в самом браузере — узнаём об этом', async () => {
    const экран = fakeTrack('video', 'экран');
    const media = createMedia({
      getUserMedia: vi.fn(),
      getDisplayMedia: vi.fn().mockResolvedValue(fakeStream(экран)),
    });
    const stopped = vi.fn();

    await media.useScreen(true, FULL, stopped);
    экран.end();

    expect(stopped).toHaveBeenCalledTimes(1);
  });
});
