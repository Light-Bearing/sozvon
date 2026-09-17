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
    expect(await media.captureScreen()).toBe(null);
  });

  it('захваченная картинка экрана попадает в общий поток', async () => {
    const экран = fakeTrack('video', 'экран');
    const media = createMedia({
      getUserMedia: vi.fn().mockResolvedValue(fakeStream(fakeTrack('audio'))),
      getDisplayMedia: vi.fn().mockResolvedValue(fakeStream(экран)),
    });
    await media.captureMicrophone(FULL);

    const track = await media.captureScreen();

    expect(track).toBe(экран);
    expect(media.current().getVideoTracks()).toEqual([экран]);
  });

  // Правило «одна картинка на человека» держит и приём (см. onPeerTrack в
  // public-channels.js): показывать сразу и камеру, и экран мы не умеем, а
  // молча слать обе дорожки значило бы, что у собеседника пропадёт одна из
  // них без объяснений.
  it('экран ЗАМЕНЯЕТ камеру, а не добавляется к ней', async () => {
    const камера = fakeTrack('video', 'камера');
    const экран = fakeTrack('video', 'экран');
    const media = createMedia({
      getUserMedia: vi.fn().mockResolvedValue(fakeStream(камера)),
      getDisplayMedia: vi.fn().mockResolvedValue(fakeStream(экран)),
    });
    await media.captureCamera(FULL);

    const swap = await media.useScreen(true, FULL);

    expect(swap).toEqual({old: камера, next: экран});
    expect(камера.stop).toHaveBeenCalled();
    expect(media.current().getVideoTracks()).toEqual([экран]);
  });

  it('выключение экрана возвращает камеру, если она была нужна', async () => {
    const камера = fakeTrack('video', 'камера');
    const другая = fakeTrack('video', 'камера снова');
    const экран = fakeTrack('video', 'экран');
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(fakeStream(камера))
      .mockResolvedValueOnce(fakeStream(другая));
    const media = createMedia({
      getUserMedia,
      getDisplayMedia: vi.fn().mockResolvedValue(fakeStream(экран)),
    });
    await media.captureCamera(FULL);
    await media.useScreen(true, FULL);

    const swap = await media.useScreen(false, FULL);

    expect(swap).toEqual({old: экран, next: другая});
    expect(экран.stop).toHaveBeenCalled();
  });

  it('человек нажал «прекратить показ» в самом браузере — узнаём об этом', async () => {
    const экран = fakeTrack('video', 'экран');
    const media = createMedia({
      getUserMedia: vi.fn(),
      getDisplayMedia: vi.fn().mockResolvedValue(fakeStream(экран)),
    });
    const stopped = vi.fn();

    await media.captureScreen(stopped);
    экран.end();

    expect(stopped).toHaveBeenCalledTimes(1);
  });
});
