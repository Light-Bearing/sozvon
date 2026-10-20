import {describe, expect, it, vi} from 'vitest';
import {createMedia} from '../src/media.js';
import {stepForPeers} from '../src/ladder.js';

// Камера телефона: передняя и задняя, у задней — приближение.
const камера = ({facingMode, deviceId, zoom = null} = {}) => {
  let current = zoom ? zoom.min : undefined;
  return {
    kind: 'video',
    enabled: true,
    readyState: 'live',
    stop: vi.fn(),
    getSettings: () => ({facingMode, deviceId, ...(current !== undefined ? {zoom: current} : {})}),
    getCapabilities: () => (zoom ? {zoom} : {}),
    applyConstraints: vi.fn(async c => {
      const want = c?.advanced?.find(x => 'zoom' in x)?.zoom;
      if (want !== undefined) current = want;
    }),
  };
};

const поток = (...tracks) => {
  const list = [...tracks];
  return {
    getVideoTracks: () => list.filter(t => t.kind === 'video'),
    getAudioTracks: () => list.filter(t => t.kind === 'audio'),
    getTracks: () => list,
    addTrack: t => list.push(t),
    removeTrack: t => list.splice(list.indexOf(t), 1),
  };
};

const телефон = () => {
  const перед = камера({facingMode: 'user', deviceId: 'перед'});
  const зад = камера({facingMode: 'environment', deviceId: 'зад', zoom: {min: 1, max: 8, step: 0.1}});
  const getUserMedia = vi.fn(async ({video}) => {
    const want = video?.facingMode?.exact ?? video?.deviceId?.exact;
    const track = want === 'environment' || want === 'зад' ? зад : перед;
    return поток(track);
  });
  const enumerate = async () => [
    {kind: 'videoinput', deviceId: 'перед'},
    {kind: 'videoinput', deviceId: 'зад'},
    {kind: 'audioinput', deviceId: 'мик'},
  ];
  return {перед, зад, getUserMedia, enumerate};
};

describe('другая камера', () => {
  it('с передней на заднюю — и пара дорожек для замены у собеседников', async () => {
    const t = телефон();
    const media = createMedia({getUserMedia: t.getUserMedia, enumerateDevices: t.enumerate});
    await media.captureCamera(stepForPeers(2));

    const swap = await media.flipCamera(stepForPeers(2));

    expect(swap).toEqual({old: t.перед, next: t.зад});
    expect(t.перед.stop).toHaveBeenCalled();
    expect(media.current().getVideoTracks()).toEqual([t.зад]);
    expect(media.facing()).toBe('environment');
  });

  it('и обратно', async () => {
    const t = телефон();
    const media = createMedia({getUserMedia: t.getUserMedia, enumerateDevices: t.enumerate});
    await media.captureCamera(stepForPeers(2));
    await media.flipCamera(stepForPeers(2));

    await media.flipCamera(stepForPeers(2));

    expect(media.current().getVideoTracks()).toEqual([t.перед]);
  });

  it('выбранная камера переживает выключение: включил снова — та же', async () => {
    const t = телефон();
    const media = createMedia({getUserMedia: t.getUserMedia, enumerateDevices: t.enumerate});
    await media.captureCamera(stepForPeers(2));
    await media.flipCamera(stepForPeers(2));
    media.releaseCamera();

    await media.captureCamera(stepForPeers(2));

    expect(media.current().getVideoTracks()).toEqual([t.зад]);
  });

  it('стороны не названы (компьютер с двумя камерами) — по кругу по списку', async () => {
    const a = камера({deviceId: 'a'});
    const b = камера({deviceId: 'b'});
    const getUserMedia = vi.fn(async ({video}) => поток(video?.deviceId?.exact === 'b' ? b : a));
    const enumerateDevices = async () => [
      {kind: 'videoinput', deviceId: 'a'},
      {kind: 'videoinput', deviceId: 'b'},
    ];
    const media = createMedia({getUserMedia, enumerateDevices});
    await media.captureCamera(stepForPeers(2));

    await media.flipCamera(stepForPeers(2));

    expect(media.current().getVideoTracks()).toEqual([b]);
  });

  it('телефон не открывает вторую камеру, пока занята первая, — сначала гасим первую', async () => {
    const t = телефон();
    let попыток = 0;
    const getUserMedia = vi.fn(async c => {
      if (c.video?.facingMode && !t.перед.stop.mock.calls.length) {
        попыток += 1;
        throw Object.assign(new Error('занята'), {name: 'NotReadableError'});
      }
      return t.getUserMedia(c);
    });
    const media = createMedia({getUserMedia, enumerateDevices: t.enumerate});
    await media.captureCamera(stepForPeers(2));

    const swap = await media.flipCamera(stepForPeers(2));

    expect(попыток).toBe(1);
    expect(swap.next).toBe(t.зад);
  });

  it('камера одна — переключать не на что', async () => {
    const t = телефон();
    const media = createMedia({
      getUserMedia: t.getUserMedia,
      enumerateDevices: async () => [{kind: 'videoinput', deviceId: 'перед'}],
    });
    await media.captureCamera(stepForPeers(2));

    expect(await media.cameraCount()).toBe(1);
  });

  it('камера выключена — переключать нечего', async () => {
    const t = телефон();
    const media = createMedia({getUserMedia: t.getUserMedia, enumerateDevices: t.enumerate});

    expect(await media.flipCamera(stepForPeers(2))).toBe(null);
  });
});

describe('приближение', () => {
  it('у камеры без приближения его нет', async () => {
    const t = телефон();
    const media = createMedia({getUserMedia: t.getUserMedia, enumerateDevices: t.enumerate});
    await media.captureCamera(stepForPeers(2));

    expect(media.zoom()).toBe(null);
  });

  it('у задней — есть, от и до, с текущим значением', async () => {
    const t = телефон();
    const media = createMedia({getUserMedia: t.getUserMedia, enumerateDevices: t.enumerate});
    await media.captureCamera(stepForPeers(2));
    await media.flipCamera(stepForPeers(2));

    expect(media.zoom()).toEqual({min: 1, max: 8, value: 1});
  });

  it('приближает и не выходит за пределы камеры', async () => {
    const t = телефон();
    const media = createMedia({getUserMedia: t.getUserMedia, enumerateDevices: t.enumerate});
    await media.captureCamera(stepForPeers(2));
    await media.flipCamera(stepForPeers(2));

    await media.setZoom(3);
    expect(media.zoom().value).toBe(3);

    await media.setZoom(40);
    expect(media.zoom().value).toBe(8);
  });

  it('смена ступени качества приближение не сбрасывает', async () => {
    const t = телефон();
    const media = createMedia({getUserMedia: t.getUserMedia, enumerateDevices: t.enumerate});
    await media.captureCamera(stepForPeers(2));
    await media.flipCamera(stepForPeers(2));
    await media.setZoom(2);

    await media.applyStep(stepForPeers(6));

    const last = t.зад.applyConstraints.mock.calls.at(-1)[0];
    expect(last.advanced).toEqual([{zoom: 2}]);
  });
});
