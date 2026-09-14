import {describe, expect, it, vi} from 'vitest';
import {constraintsFor, createMedia, setMaxBitrate} from '../src/media.js';
import {STEPS, stepForPeers} from '../src/ladder.js';

const fakeTrack = kind => ({
  kind,
  enabled: true,
  stop: vi.fn(),
  applyConstraints: vi.fn().mockResolvedValue(undefined),
});

const fakeStream = () => {
  const audio = fakeTrack('audio');
  const video = fakeTrack('video');
  return {
    audio,
    video,
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
    getTracks: () => [audio, video],
  };
};

describe('условия захвата', () => {
  it('на полной ступени просит 720p', () => {
    const c = constraintsFor(stepForPeers(2));
    expect(c.video.width.ideal).toBe(1280);
    expect(c.video.height.ideal).toBe(720);
  });

  it('в голосовом режиме видео не просит вовсе', () => {
    expect(constraintsFor(STEPS.at(-1)).video).toBe(false);
  });

  it('эхо и шум глушатся всегда', () => {
    for (const step of STEPS) {
      expect(constraintsFor(step).audio.echoCancellation).toBe(true);
      expect(constraintsFor(step).audio.noiseSuppression).toBe(true);
    }
  });
});

describe('камера', () => {
  it('захватывает поток по ступени', async () => {
    const stream = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const media = createMedia({getUserMedia});

    await media.start(stepForPeers(2));

    expect(getUserMedia).toHaveBeenCalledWith(constraintsFor(stepForPeers(2)));
    expect(media.current()).toBe(stream);
  });

  it('спуск по лестнице ужимает картинку, а не пересоздаёт поток', async () => {
    const stream = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const media = createMedia({getUserMedia});

    await media.start(stepForPeers(2));
    await media.applyStep(stepForPeers(4));

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(stream.video.applyConstraints).toHaveBeenCalledWith({
      width: {ideal: 640},
      height: {ideal: 360},
    });
  });

  it('голосовой режим гасит дорожку, но звук оставляет', async () => {
    const stream = fakeStream();
    const media = createMedia({getUserMedia: vi.fn().mockResolvedValue(stream)});

    await media.start(stepForPeers(2));
    await media.applyStep(STEPS.at(-1));

    expect(stream.video.enabled).toBe(false);
    expect(stream.audio.enabled).toBe(true);
  });

  it('выключатели гасят нужные дорожки', async () => {
    const stream = fakeStream();
    const media = createMedia({getUserMedia: vi.fn().mockResolvedValue(stream)});
    await media.start(stepForPeers(2));

    media.setMicrophone(false);
    expect(stream.audio.enabled).toBe(false);
    expect(stream.video.enabled).toBe(true);

    media.setCamera(false);
    expect(stream.video.enabled).toBe(false);
  });

  it('остановка глушит все дорожки и забывает поток', async () => {
    const stream = fakeStream();
    const media = createMedia({getUserMedia: vi.fn().mockResolvedValue(stream)});
    await media.start(stepForPeers(2));

    media.stop();

    expect(stream.audio.stop).toHaveBeenCalled();
    expect(stream.video.stop).toHaveBeenCalled();
    expect(media.current()).toBeNull();
  });

  it('выключатели до захвата не падают', () => {
    const media = createMedia({getUserMedia: vi.fn()});
    expect(() => media.setMicrophone(false)).not.toThrow();
    expect(() => media.stop()).not.toThrow();
  });
});

describe('потолок битрейта', () => {
  it('ставится в первый слой отправителя', async () => {
    const sender = {
      getParameters: () => ({encodings: [{}]}),
      setParameters: vi.fn().mockResolvedValue(undefined),
    };

    await setMaxBitrate(sender, 800_000);

    expect(sender.setParameters).toHaveBeenCalledWith({
      encodings: [{maxBitrate: 800_000}],
    });
  });

  it('отправитель без слоёв не ломает звонок', async () => {
    const sender = {
      getParameters: () => ({}),
      setParameters: vi.fn(),
    };

    await expect(setMaxBitrate(sender, 800_000)).resolves.toBeUndefined();
    expect(sender.setParameters).not.toHaveBeenCalled();
  });
});
