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

  it('голосовой режим не перенастраивает видео — гасить дорожку не его дело', async () => {
    const stream = fakeStream();
    const media = createMedia({getUserMedia: vi.fn().mockResolvedValue(stream)});

    await media.start(stepForPeers(2));
    await media.applyStep(STEPS.at(-1));

    // applyStep больше не трогает enabled ни в одну сторону — единый
    // хозяин дорожки это setCamera() (через applyDesiredMedia() в
    // src/room.js), поэтому здесь дорожка остаётся как была.
    expect(stream.video.applyConstraints).not.toHaveBeenCalled();
    expect(stream.video.enabled).toBe(true);
    expect(stream.audio.enabled).toBe(true);
  });

  // Находка 1 (см. src/media.js): applyStep безусловно ставил enabled = true
  // перед перенастройкой камеры (applyConstraints, 100–600 мс) — и если
  // человек только что выключил камеру, а в этот же такт сменилась ступень,
  // живые кадры уходили собеседникам ещё до того, как room.js успевал
  // поправить. Теперь applyStep вообще не имеет права писать в enabled.
  it('applyStep ни при каких условиях не включает и не выключает дорожку — это дело setCamera', async () => {
    const stream = fakeStream();
    const media = createMedia({getUserMedia: vi.fn().mockResolvedValue(stream)});
    await media.start(stepForPeers(2));

    stream.video.enabled = false; // человек выключил камеру

    // Смена ступени на обычный видео-режим (не voice) — раньше именно
    // здесь enabled синхронно становился true.
    await media.applyStep(stepForPeers(4));

    expect(stream.video.enabled).toBe(false);
    expect(stream.video.applyConstraints).toHaveBeenCalled(); // перенастройка при этом всё же случилась
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

// Человек входит в разговор без камеры и микрофона и включает их сам —
// captureMicrophone()/captureCamera() просят браузер ровно об одном виде
// медиа за раз, а release*() по-настоящему освобождают устройство
// (track.stop()), а не просто гасят enabled — этим занимаются
// setMicrophone()/setCamera() выше, и это другая, независимая пара методов.
describe('захват и освобождение по требованию', () => {
  const fakeAudioTrack = () => ({kind: 'audio', enabled: true, stop: vi.fn()});
  const fakeVideoTrack = () => ({kind: 'video', enabled: true, stop: vi.fn()});

  // В отличие от fakeStream() выше (список дорожек фиксирован), этой группе
  // тестов важно, что addTrack()/removeTrack() по-настоящему меняют состав:
  // второй захват должен увидеть дорожку, добавленную первым, и не просить
  // getUserMedia заново.
  const fakeCapturedStream = initial => {
    const tracks = [...initial];
    return {
      addTrack: t => tracks.push(t),
      removeTrack: t => {
        const i = tracks.indexOf(t);
        if (i >= 0) tracks.splice(i, 1);
      },
      getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
      getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
      getTracks: () => [...tracks],
    };
  };

  it('captureMicrophone просит браузер только о звуке', async () => {
    const audioTrack = fakeAudioTrack();
    const capturedStream = fakeCapturedStream([audioTrack]);
    const getUserMedia = vi.fn().mockResolvedValue(capturedStream);
    const media = createMedia({getUserMedia});

    const track = await media.captureMicrophone(stepForPeers(2));

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: constraintsFor(stepForPeers(2)).audio,
      video: false,
    });
    expect(track).toBe(audioTrack);
    expect(media.current()).toBe(capturedStream);
  });

  it('captureCamera просит браузер только о картинке', async () => {
    const videoTrack = fakeVideoTrack();
    const capturedStream = fakeCapturedStream([videoTrack]);
    const getUserMedia = vi.fn().mockResolvedValue(capturedStream);
    const media = createMedia({getUserMedia});

    const track = await media.captureCamera(stepForPeers(2));

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: constraintsFor(stepForPeers(2)).video,
    });
    expect(track).toBe(videoTrack);
  });

  it('на голосовой ступени камеру не захватывает вовсе — лестница не даёт включить, даже по прямой просьбе', async () => {
    const getUserMedia = vi.fn();
    const media = createMedia({getUserMedia});

    const track = await media.captureCamera(STEPS.at(-1));

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(track).toBeNull();
  });

  it('второй вид медиа дописывается в уже идущий поток, а не пересоздаёт его', async () => {
    const audioTrack = fakeAudioTrack();
    const micStream = fakeCapturedStream([audioTrack]);
    const videoTrack = fakeVideoTrack();
    const camStream = fakeCapturedStream([videoTrack]);
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(micStream)
      .mockResolvedValueOnce(camStream);
    const media = createMedia({getUserMedia});

    await media.captureMicrophone(stepForPeers(2));
    const streamAfterMic = media.current();
    await media.captureCamera(stepForPeers(2));

    expect(media.current()).toBe(streamAfterMic); // тот же объект, не пересоздан
    expect(media.current().getAudioTracks()).toEqual([audioTrack]);
    expect(media.current().getVideoTracks()).toEqual([videoTrack]);
  });

  it('повторный захват при уже идущей дорожке не зовёт getUserMedia снова', async () => {
    const audioTrack = fakeAudioTrack();
    const capturedStream = fakeCapturedStream([audioTrack]);
    const getUserMedia = vi.fn().mockResolvedValue(capturedStream);
    const media = createMedia({getUserMedia});

    await media.captureMicrophone(stepForPeers(2));
    const second = await media.captureMicrophone(stepForPeers(2));

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(second).toBeNull();
  });

  it('releaseMicrophone по-настоящему останавливает дорожку и убирает её из потока', async () => {
    const audioTrack = fakeAudioTrack();
    const capturedStream = fakeCapturedStream([audioTrack]);
    const media = createMedia({getUserMedia: vi.fn().mockResolvedValue(capturedStream)});
    await media.captureMicrophone(stepForPeers(2));

    const released = media.releaseMicrophone();

    expect(audioTrack.stop).toHaveBeenCalled(); // не просто enabled = false — устройство освобождено
    expect(released).toEqual([audioTrack]);
    expect(media.current().getAudioTracks()).toEqual([]);
  });

  it('releaseCamera останавливает и убирает картинку, микрофон не трогает', async () => {
    const audioTrack = fakeAudioTrack();
    const videoTrack = fakeVideoTrack();
    const micStream = fakeCapturedStream([audioTrack]);
    const camStream = fakeCapturedStream([videoTrack]);
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(micStream)
      .mockResolvedValueOnce(camStream);
    const media = createMedia({getUserMedia});
    await media.captureMicrophone(stepForPeers(2));
    await media.captureCamera(stepForPeers(2));

    const released = media.releaseCamera();

    expect(videoTrack.stop).toHaveBeenCalled();
    expect(audioTrack.stop).not.toHaveBeenCalled();
    expect(released).toEqual([videoTrack]);
    expect(media.current().getVideoTracks()).toEqual([]);
    expect(media.current().getAudioTracks()).toEqual([audioTrack]); // микрофон остался жив
  });

  it('освобождение без предварительного захвата не падает и ничего не возвращает', () => {
    const media = createMedia({getUserMedia: vi.fn()});

    expect(media.releaseMicrophone()).toEqual([]);
    expect(media.releaseCamera()).toEqual([]);
  });
});
