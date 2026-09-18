import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRoom} from '../src/room.js';
import {createMedia} from '../src/media.js';
import {createLadder, stepForPeers, STEPS} from '../src/ladder.js';

// createRoom.state() зовёт secretToLink() без базы — та берёт глобальный
// location, которого в узловом окружении vitest (без jsdom) нет. Содержимое
// ссылки в этих тестах не проверяется, поэтому достаточно минимальной
// подстановки, лишь бы announce() не падал.
beforeEach(() => {
  globalThis.location = {
    origin: 'https://sozvon.test',
    pathname: '/',
    href: 'https://sozvon.test/',
  };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// Совпадает с STATS_EVERY_MS из src/room.js — наружу эта константа не
// экспортируется, а заводить экспорт ради теста незачем.
const STATS_EVERY_MS = 2_000;

const FULL = stepForPeers(1); // стартовая ступень
const SMALL = stepForPeers(4); // соседняя ступень — для проверки смены

// Поддельный отправитель вместо настоящего RTCRtpSender: даёт ровно то, чем
// пользуется setMaxBitrate из src/media.js (getParameters/setParameters),
// плюс track.kind, по которому room.js отличает video от звука.
const fakeSender = () => ({
  track: {kind: 'video'},
  getParameters: () => ({encodings: [{}]}),
  setParameters: vi.fn().mockResolvedValue(undefined),
});

// Поддельное соединение вместо настоящего RTCPeerConnection: getSenders —
// для потолка битрейта, getStats — для сводки на такте.
const fakePeer = (senders = [fakeSender()]) => ({
  getSenders: () => senders,
  getStats: vi.fn().mockResolvedValue([]),
});

const fakeMedia = () => ({
  current: vi.fn(() => null),
  start: vi.fn().mockResolvedValue({fake: 'stream'}),
  applyStep: vi.fn().mockResolvedValue(undefined),
  setMicrophone: vi.fn(),
  setCamera: vi.fn(),
  // По умолчанию «нечего захватывать/снимать» — большинству тестов файла
  // захват безразличен, они проверяют такт лестницы и единого хозяина
  // намерения. Тесты про сам захват (ниже) подменяют возвращаемое значение.
  captureMicrophone: vi.fn().mockResolvedValue(null),
  captureCamera: vi.fn().mockResolvedValue(null),
  releaseMicrophone: vi.fn(() => []),
  releaseCamera: vi.fn(() => []),
  stop: vi.fn(),
});

// Ступени выдаются по очереди при каждом вызове update(); какая нужна на
// каком такте — решает тест, а не настоящая статистика связи.
const fakeLadder = steps => {
  let i = 0;
  return {update: vi.fn(() => steps[Math.min(i++, steps.length - 1)])};
};

// Поддельное подключение вместо connect() из src/signal/index.js: handlers
// запоминаются, чтобы тест мог сам сыграть onPeerJoin, а getPeers() отдаёт
// то, что тест положил через setPeer — как будто это уже установленные
// RTCPeerConnection к собеседникам.
const fakeConnection = () => {
  const pcs = new Map();
  // Каналы обмена (имена, уровни звука) — по одному на пространство имён,
  // как у настоящего connection.action(). Тест добирается до отправленного
  // через sent, а входящее играет через onMessage.
  const channels = new Map();
  return {
    handlers: null,
    addStream: vi.fn(),
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    replaceTrack: vi.fn(),
    getPeers: () => Object.fromEntries(pcs),
    leave: vi.fn().mockResolvedValue(undefined),
    setPeer: (peerId, pc) => pcs.set(peerId, pc),
    action: namespace => {
      if (!channels.has(namespace)) {
        const channel = {sent: [], onMessage: null};
        channel.send = data => {
          channel.sent.push(data);
          return Promise.resolve();
        };
        channels.set(namespace, channel);
      }
      return channels.get(namespace);
    },
    channel: namespace => channels.get(namespace),
  };
};

const fakeConnectFn = connection => async ({handlers}) => {
  connection.handlers = handlers;
  return connection;
};

const openRoom = async ({
  connection = fakeConnection(),
  media = fakeMedia(),
  ladder = fakeLadder([FULL]),
  onChange = vi.fn(),
  name,
} = {}) => {
  const room = await createRoom({
    secret: 'секрет-теста',
    connectFn: fakeConnectFn(connection),
    media,
    ladder,
    onChange,
    name,
  });
  return {room, connection, media, ladder, onChange};
};

describe('потолок битрейта на пересчёте ступени', () => {
  it('проставляется отправителям, даже когда ступень не менялась (звонок вдвоём)', async () => {
    const connection = fakeConnection();
    const sender = fakeSender();
    connection.setPeer('сосед', fakePeer([sender]));

    // Настоящая лестница: при 1↔2 собеседниках stepForPeers всегда даёт
    // 'full' — name ступени не меняется никогда. Это и есть находка 1.
    const {room} = await openRoom({connection, ladder: createLadder()});
    connection.handlers.onPeerJoin('сосед');

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS);

    expect(sender.setParameters).toHaveBeenCalledWith({
      encodings: [{maxBitrate: stepForPeers(2).maxBitrate}],
    });

    await room.leave();
  });

  it('собеседник, подключившийся после смены ступени, тоже получает потолок', async () => {
    const connection = fakeConnection();
    const ladder = fakeLadder([SMALL, SMALL]);
    const {room} = await openRoom({connection, ladder});

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS); // тик 1: смена full → small

    const lateSender = fakeSender();
    connection.setPeer('опоздавший', fakePeer([lateSender]));
    connection.handlers.onPeerJoin('опоздавший');

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS); // тик 2: ступень та же ('small')

    expect(lateSender.setParameters).toHaveBeenCalledWith({
      encodings: [{maxBitrate: SMALL.maxBitrate}],
    });

    await room.leave();
  });
});

describe('устойчивость такта к сбоям', () => {
  it('сбой getStats() у одного собеседника не мешает обработать остальных', async () => {
    const connection = fakeConnection();

    const badPeer = fakePeer();
    badPeer.getStats = vi.fn().mockRejectedValue(new Error('соединение отвалилось'));
    connection.setPeer('плохой', badPeer);

    const goodPeer = fakePeer();
    connection.setPeer('хороший', goodPeer);

    const ladder = fakeLadder([FULL]);
    const {room} = await openRoom({connection, ladder});

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS);

    expect(goodPeer.getStats).toHaveBeenCalled();
    expect(ladder.update).toHaveBeenCalledTimes(1); // пересчёт такта всё равно случился

    await room.leave();
  });

  it('сбой setParameters() у одного отправителя не мешает обработать остальных', async () => {
    const connection = fakeConnection();

    const badSender = fakeSender();
    badSender.setParameters = vi.fn().mockRejectedValue(new Error('InvalidStateError'));
    const badPeer = fakePeer([badSender]);
    connection.setPeer('плохой', badPeer);

    const goodSender = fakeSender();
    const goodPeer = fakePeer([goodSender]);
    connection.setPeer('хороший', goodPeer);

    const {room} = await openRoom({connection, ladder: createLadder()});

    connection.handlers.onPeerJoin('плохой');
    connection.handlers.onPeerJoin('хороший');

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS);

    // Несмотря на сбой у плохого собеседника, хороший получил потолок
    expect(goodSender.setParameters).toHaveBeenCalled();

    await room.leave();
  });
});

describe('перенастройка камеры', () => {
  it('срабатывает при смене ступени и не срабатывает, когда ступень та же', async () => {
    const ladder = fakeLadder([SMALL, SMALL, FULL]);
    const {room, media, onChange} = await openRoom({ladder});
    onChange.mockClear(); // сбросить объявление, сделанное при самом подключении

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS); // тик 1: full → small — смена
    expect(media.applyStep).toHaveBeenCalledTimes(1);
    expect(media.applyStep).toHaveBeenLastCalledWith(SMALL);
    expect(onChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS); // тик 2: small → small — без смены
    expect(media.applyStep).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1); // не выросло — перерисовки вхолостую не previous

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS); // тик 3: small → full — смена
    expect(media.applyStep).toHaveBeenCalledTimes(2);
    expect(media.applyStep).toHaveBeenLastCalledWith(FULL);
    expect(onChange).toHaveBeenCalledTimes(2);

    await room.leave();
  });
});

describe('завершение звонка', () => {
  it('leave() останавливает такты и гасит камеру', async () => {
    const ladder = fakeLadder([FULL, FULL, FULL]);
    const {room, media, connection} = await openRoom({ladder});

    await room.leave();

    expect(media.stop).toHaveBeenCalled();
    expect(connection.leave).toHaveBeenCalled();

    const callsAtLeave = ladder.update.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS * 5);

    expect(ladder.update).toHaveBeenCalledTimes(callsAtLeave); // не растёт — таймер остановлен
  });
});

// Находка 1: тремя местами писали в media.setCamera() — человек кнопкой,
// лестница качества и определение говорящего. Единого хозяина не previous, и
// на ступенях 'full'/'small' (videoFor: 'all' — обычный звонок вдвоём-
// вчетвером) такт безусловно переустанавливал камеру, отменяя нажатие
// человека уже через одно и то же 2-секундное деление STATS_EVERY_MS.
describe('намерение человека — единый хозяин камеры и микрофона', () => {
  it('такт не включает камеру обратно после того, как человек её выключил (ступень full)', async () => {
    const ladder = fakeLadder([FULL, FULL, FULL]);
    const {room, media} = await openRoom({ladder});

    room.setCamera(false);
    expect(media.setCamera).toHaveBeenLastCalledWith(false);

    // Раньше здесь, на такте, applyStep безусловно вызывал
    // media.setCamera(true) для videoFor: 'all' — вот она, находка 1.
    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS);
    expect(media.setCamera).toHaveBeenLastCalledWith(false);

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS);
    expect(media.setCamera).toHaveBeenLastCalledWith(false);

    await room.leave();
  });

  it('такт не включает камеру обратно и на ступени small (тоже videoFor: all)', async () => {
    const ladder = fakeLadder([SMALL, SMALL]);
    const {room, media} = await openRoom({ladder});

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS); // смена full → small
    room.setCamera(false);

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS);
    expect(media.setCamera).toHaveBeenLastCalledWith(false);

    await room.leave();
  });

  it('человек передумал и включил камеру обратно — такт это не отменяет', async () => {
    const ladder = fakeLadder([FULL, FULL]);
    const {room, media} = await openRoom({ladder});

    room.setCamera(false);
    room.setCamera(true);
    expect(media.setCamera).toHaveBeenLastCalledWith(true);

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS);
    expect(media.setCamera).toHaveBeenLastCalledWith(true);

    await room.leave();
  });

  it('на ступени voice (videoFor: none) камера выключена, даже если человек её хочет', async () => {
    const VOICE = STEPS.at(-1);
    expect(VOICE.videoFor).toBe('none'); // на случай, если состав STEPS поменяют

    const ladder = fakeLadder([VOICE]);
    const {room, media} = await openRoom({ladder});

    // Намерение теперь начинается с false — человек должен сперва попросить
    // камеру, иначе сравнивать с запретом лестницы нечего.
    await room.setCamera(true);
    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS);
    expect(media.setCamera).toHaveBeenLastCalledWith(false);

    await room.leave();
  });

  it('setMicrophone так же не переопределяется тактом лестницы', async () => {
    const ladder = fakeLadder([FULL, FULL]);
    const {room, media} = await openRoom({ladder});

    room.setMicrophone(false);
    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS);

    expect(media.setMicrophone).toHaveBeenLastCalledWith(false);

    await room.leave();
  });

  it('нажатие кнопки объявляет новое состояние немедленно, не дожидаясь такта', async () => {
    const {room, onChange} = await openRoom();
    onChange.mockClear();

    room.setCamera(false);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].cam).toBe(false);
  });

  // Находка 2 со стороны room.js: state() должен нести намерение по камере
  // и микрофону — иначе интерфейсу физически нечем нарисовать aria-pressed
  // по правде (см. tests/call.test.js).
  it('state() отдаёт текущее намерение по камере и микрофону', async () => {
    const {room} = await openRoom();

    // Вход молчаливый — оба намерения начинаются с false.
    expect(room.state().cam).toBe(false);
    expect(room.state().mic).toBe(false);

    await room.setCamera(true);
    expect(room.state().cam).toBe(true);

    await room.setMicrophone(true);
    expect(room.state().mic).toBe(true);

    await room.leave();
  });
});

// Находка 6: AudioContext создавался после await'ов, то есть вне жеста
// человека, и по правилам браузеров мог родиться приостановленным. Тогда
// анализатор молча читает нули, tracker.report(SELF, …) не срабатывает,
// tracker.speaker() === SELF всегда ложь — и на ступени «видео у говорящего»
// камера этого человека выключена весь звонок, без единого объяснения.
//
// fakeConnection() из остальных тестов файла нарочно без action() — этот
// путь в room.js рассчитан на то, что action()/AudioContext иногда
// недоступны вовсе (см. комментарий в src/room.js), и большинство тестов
// это проверяет неявно, просто не подсовывая ни то, ни другое. Здесь —
// обратный случай: оба доступны, и оба должны быть использованы правильно.
describe('измерение уровня звука не должно молчать (AudioContext)', () => {
  it('возобновляет AudioContext, если браузер создал его приостановленным', async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    class FakeAudioContext {
      constructor() {
        this.state = 'suspended';
        this.resume = resume;
      }
      createAnalyser() {
        return {fftSize: 0, connect: () => {}, getFloatTimeDomainData: () => {}};
      }
      createMediaStreamSource() {
        return {connect: () => {}};
      }
      close() {
        return Promise.resolve();
      }
    }
    const previousAudioContext = globalThis.AudioContext;
    globalThis.AudioContext = FakeAudioContext;

    try {
      const connection = fakeConnection();
      connection.action = vi.fn(() => ({onMessage: null, send: vi.fn().mockResolvedValue(undefined)}));

      const {room} = await openRoom({connection});
      // Измерение своего уровня включается вместе с микрофоном — раньше
      // AudioContext заводился безусловно при старте звонка, теперь только
      // здесь, потому что и сам микрофон захватывается только по просьбе.
      await room.setMicrophone(true);

      expect(resume).toHaveBeenCalledTimes(1);

      await room.leave();
    } finally {
      globalThis.AudioContext = previousAudioContext;
    }
  });

  it('не трогает resume(), если AudioContext создался уже запущенным', async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    class FakeAudioContext {
      constructor() {
        this.state = 'running';
        this.resume = resume;
      }
      createAnalyser() {
        return {fftSize: 0, connect: () => {}, getFloatTimeDomainData: () => {}};
      }
      createMediaStreamSource() {
        return {connect: () => {}};
      }
      close() {
        return Promise.resolve();
      }
    }
    const previousAudioContext = globalThis.AudioContext;
    globalThis.AudioContext = FakeAudioContext;

    try {
      const connection = fakeConnection();
      connection.action = vi.fn(() => ({onMessage: null, send: vi.fn().mockResolvedValue(undefined)}));

      const {room} = await openRoom({connection});
      await room.setMicrophone(true);

      expect(resume).not.toHaveBeenCalled();

      await room.leave();
    } finally {
      globalThis.AudioContext = previousAudioContext;
    }
  });
});

// Находка «не молчать» 1: media.applyStep (src/media.js) безусловно ставил
// video.enabled = true перед перенастройкой камеры (applyConstraints,
// 100–600 мс) — и если человек только что выключил камеру, а в этот же такт
// сменилась ступень (например, зашёл третий и full → small), поправка
// приходила только после двух await — applyStep и applyBitrateCeiling —
// а всё это время живые кадры уходили всем собеседникам. fakeMedia() выше
// в этом файле — пустышка (applyStep ничего не делает), поэтому обычные
// тесты на такт лестницы эту гонку видеть не могут в принципе: нужен
// настоящий src/media.js по обе стороны гонки.
describe('камера не включается против воли человека при смене ступени (настоящий media.js)', () => {
  it('video.enabled ни разу не становится true между выключением камеры и следующим тактом лестницы', async () => {
    const enabledHistory = [];
    let enabledValue = true;
    const video = {
      kind: 'video',
      applyConstraints: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      get enabled() {
        return enabledValue;
      },
      set enabled(v) {
        enabledValue = v;
        enabledHistory.push(v);
      },
    };
    const audio = {kind: 'audio', enabled: true, stop: vi.fn()};
    const stream = {
      getVideoTracks: () => [video],
      getAudioTracks: () => [audio],
      getTracks: () => [audio, video],
      // Захват по требованию дописывает/снимает дорожки настоящими
      // addTrack()/removeTrack() — см. src/media.js. Список дорожек здесь
      // намеренно остаётся фиксированным (как и в tests/media.test.js): для
      // этого теста важно только то, что enabled не трогается лишний раз.
      addTrack: vi.fn(),
      removeTrack: vi.fn(),
    };
    const media = createMedia({getUserMedia: vi.fn().mockResolvedValue(stream)});

    // full -> small: обычный video-режим (videoFor: 'all' у обеих), не
    // голосовой, — ровно тот переход, где раньше проявлялась гонка.
    const ladder = fakeLadder([SMALL]);
    const {room} = await openRoom({media, ladder});

    // Вход молчаливый — камеру сперва нужно по-настоящему запросить (это и
    // заводит внутренний stream настоящего media.js на fake-stream выше),
    // только потом есть что выключать.
    await room.setCamera(true);
    room.setCamera(false);
    enabledHistory.length = 0; // дальше важно только то, что после выключения

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS); // такт со сменой ступени

    expect(enabledHistory).not.toContain(true);
    expect(video.enabled).toBe(false);

    await room.leave();
  });
});

// Раньше медиа захватывалось до подключения, а подключение могло
// отклониться — например, если библиотека не сумела подняться вовсе. Тогда
// при отказе createRoom падал целиком, а stream никто не гасил: media.stop()
// жил только в leave(), до которого дело не доходило — человек видел «Связь
// не установилась», а камера продолжала гореть до закрытия вкладки.
//
// Теперь до подключения не захватывается вообще ничего (setMicrophone()/
// setCamera() ещё недоступны вызывающему — createRoom их не вернул), так
// что media.start() здесь больше не при делах. media.stop() в catch —
// оставлен как защитная подстраховка (симметрично с leave()) и должен
// оставаться безопасным, даже когда снимать нечего.
describe('поток гасится, если рукопожатие не состоялось', () => {
  it('отказ connectFn() долетает до вызывающего, а media.stop() не мешает и не падает', async () => {
    const media = fakeMedia();
    const boom = Object.assign(new Error('рукопожатие не поднялось'), {
      name: 'SignalStartupError',
    });
    const connectFn = vi.fn().mockRejectedValue(boom);

    await expect(
      createRoom({secret: 'секрет-теста', connectFn, media, ladder: fakeLadder([FULL])})
    ).rejects.toBe(boom);

    expect(media.start).not.toHaveBeenCalled(); // захвата при входе больше нет
    expect(media.stop).toHaveBeenCalled(); // защитный вызов остался и не падает на пустом месте
  });

  it('успешное подключение media.stop() не трогает', async () => {
    const {room, media} = await openRoom();

    expect(media.stop).not.toHaveBeenCalled();

    await room.leave();
    expect(media.stop).toHaveBeenCalledTimes(1);
  });
});

// Человек попросил выключить камеру по умолчанию, а следом и микрофон:
// вход в разговор молчаливый, оба включаются по отдельному явному нажатию,
// и каждое просит браузер ровно об одном виде медиа.
describe('вход без захвата и включение по требованию', () => {
  it('вход в разговор не захватывает ни звука, ни картинки', async () => {
    const media = fakeMedia();
    const {room} = await openRoom({media});

    expect(media.start).not.toHaveBeenCalled();
    expect(media.captureMicrophone).not.toHaveBeenCalled();
    expect(media.captureCamera).not.toHaveBeenCalled();

    await room.leave();
  });

  it('включение микрофона захватывает только звук и рассылает дорожку адресно', async () => {
    const media = fakeMedia();
    const track = {kind: 'audio'};
    media.captureMicrophone.mockResolvedValue(track);
    const connection = fakeConnection();
    const {room} = await openRoom({media, connection});

    await room.setMicrophone(true);

    expect(media.captureMicrophone).toHaveBeenCalledTimes(1);
    expect(media.captureCamera).not.toHaveBeenCalled(); // камеру отдельным нажатием не просили
    expect(connection.addTrack).toHaveBeenCalledWith(track, media.current());

    await room.leave();
  });

  it('включение камеры захватывает только картинку — микрофон не просит', async () => {
    const media = fakeMedia();
    const track = {kind: 'video'};
    media.captureCamera.mockResolvedValue(track);
    const connection = fakeConnection();
    const {room} = await openRoom({media, connection});

    await room.setCamera(true);

    expect(media.captureCamera).toHaveBeenCalledTimes(1);
    expect(media.captureMicrophone).not.toHaveBeenCalled();
    expect(connection.addTrack).toHaveBeenCalledWith(track, media.current());

    await room.leave();
  });

  it('выключение снимает дорожку с соединений — release() освобождает устройство', async () => {
    const media = fakeMedia();
    const track = {kind: 'video'};
    media.captureCamera.mockResolvedValue(track);
    media.releaseCamera.mockReturnValue([track]); // то, что реально отдаёт настоящий media.js — см. tests/media.test.js
    const connection = fakeConnection();
    const {room} = await openRoom({media, connection});

    await room.setCamera(true);
    room.setCamera(false);

    expect(media.releaseCamera).toHaveBeenCalled();
    expect(connection.removeTrack).toHaveBeenCalledWith(track);

    await room.leave();
  });

  it('отказ в разрешении не роняет звонок — намерение честно откатывается', async () => {
    const media = fakeMedia();
    const boom = Object.assign(new Error('пользователь запретил'), {name: 'NotAllowedError'});
    media.captureCamera.mockRejectedValue(boom);
    const {room} = await openRoom({media});

    // Промис захвата не должен ни отклониться, ни уронить звонок.
    await expect(room.setCamera(true)).resolves.toBeUndefined();

    expect(room.state().cam).toBe(false); // кнопка возвращается в «выключено»

    await room.leave();
  });

  it('отказ в разрешении на микрофон так же не роняет звонок', async () => {
    const media = fakeMedia();
    const boom = Object.assign(new Error('пользователь запретил'), {name: 'NotAllowedError'});
    media.captureMicrophone.mockRejectedValue(boom);
    const {room} = await openRoom({media});

    await expect(room.setMicrophone(true)).resolves.toBeUndefined();
    expect(room.state().mic).toBe(false);

    await room.leave();
  });

  // Требование задачи: лестница может только НЕ ДАТЬ включить (гасит
  // enabled на уже существующей дорожке через applyDesiredMedia), но сама
  // она за человека камеру или микрофон никогда не захватывает.
  it('такты лестницы сами по себе ничего не захватывают, пока человек не попросил', async () => {
    const media = fakeMedia();
    const ladder = fakeLadder([FULL, FULL, FULL]);
    const {room} = await openRoom({media, ladder});

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS * 3);

    expect(media.captureMicrophone).not.toHaveBeenCalled();
    expect(media.captureCamera).not.toHaveBeenCalled();

    await room.leave();
  });
});

// Переключатель семейств каналов для диагностики (?каналы=... в main.js) —
// сам разбор и отбор живут в signal/public-channels.js и проверены там;
// здесь достаточно убедиться, что createRoom честно доносит параметр до
// connectFn(), не подменяя и не теряя его по пути.
describe('передача параметра семейств дальше в connectFn', () => {
  it('families уходит в connectFn как есть', async () => {
    const connection = fakeConnection();
    const families = [{family: 'nostr'}];
    const connectFn = vi.fn(fakeConnectFn(connection));

    const room = await createRoom({
      secret: 'секрет-теста',
      connectFn,
      families,
      ladder: fakeLadder([FULL]),
    });

    expect(connectFn).toHaveBeenCalledWith(expect.objectContaining({families}));

    await room.leave();
  });

  it('без параметра в connectFn уходит undefined — там уже свой умолчательный список', async () => {
    const connection = fakeConnection();
    const connectFn = vi.fn(fakeConnectFn(connection));

    const room = await createRoom({
      secret: 'секрет-теста',
      connectFn,
      ladder: fakeLadder([FULL]),
    });

    expect(connectFn).toHaveBeenCalledWith(expect.objectContaining({families: undefined}));

    await room.leave();
  });
});

// Провал льда не производит ни одного события Trystero: onPeerJoin ждёт
// открытого канала данных, которого не будет. Без этой ветки экран показывал
// «Жду, когда зайдут» бесконечно, хотя собеседник был найден.
describe('беда с прямым путём доходит до состояния', () => {
  it('без жалоб servers пуст', async () => {
    const {room} = await openRoom();

    expect(room.state().troubles).toEqual([]);
  });

  it('жалоба каналов попадает в состояние и объявляется наверх', async () => {
    const {room, connection, onChange} = await openRoom();
    onChange.mockClear();

    connection.handlers.onTrouble([{peerId: 'петя', kind: 'no-path'}]);

    expect(room.state().troubles).toEqual(['no-path']);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('одинаковая беда у двоих названа один раз', async () => {
    const {room, connection} = await openRoom();

    connection.handlers.onTrouble([
      {peerId: 'петя', kind: 'no-path'},
      {peerId: 'вася', kind: 'no-path'},
    ]);

    expect(room.state().troubles).toEqual(['no-path']);
  });

  it('снятая жалоба очищает состояние', async () => {
    const {room, connection} = await openRoom();
    connection.handlers.onTrouble([{peerId: 'петя', kind: 'no-path'}]);

    connection.handlers.onTrouble([]);

    expect(room.state().troubles).toEqual([]);
  });
});

describe('имена участников', () => {
  it('без заданного имени придумывается смешное из двух слов', async () => {
    const {room} = await openRoom();

    expect(room.state().name.split(' ')).toHaveLength(2);
  });

  it('заданное имя берётся как есть, только чистится', async () => {
    const {room} = await openRoom({name: '  Пётр   Иванович  '});

    expect(room.state().name).toBe('Пётр Иванович');
  });

  it('вошедшему сразу отсылается своё имя', async () => {
    const {room, connection} = await openRoom({name: 'Пётр'});

    connection.handlers.onPeerJoin('петя');

    expect(connection.channel('name').sent).toEqual(['Пётр']);
  });

  it('чужое имя попадает на плитку собеседника', async () => {
    const {room, connection} = await openRoom();
    connection.handlers.onPeerJoin('петя');

    connection.channel('name').onMessage('Сонная Выдра', {peerId: 'петя'});

    expect(room.state().peers).toEqual([
      {peerId: 'петя', stream: null, screen: null, name: 'Сонная Выдра'},
    ]);
  });

  it('смена имени в звонке уходит собеседникам', async () => {
    const {room, connection} = await openRoom({name: 'Пётр'});
    connection.handlers.onPeerJoin('петя');
    connection.channel('name').sent.length = 0;

    room.setName('Пётр Иванович');

    expect(room.state().name).toBe('Пётр Иванович');
    expect(connection.channel('name').sent).toEqual(['Пётр Иванович']);
  });

  it('пустое имя не оставляет плитку безымянной', async () => {
    const {room} = await openRoom({name: 'Пётр'});

    room.setName('   ');

    expect(room.state().name.split(' ')).toHaveLength(2);
  });

  it('ушедший уносит своё имя', async () => {
    const {room, connection} = await openRoom();
    connection.handlers.onPeerJoin('петя');
    connection.channel('name').onMessage('Сонная Выдра', {peerId: 'петя'});

    connection.handlers.onPeerLeave('петя');
    connection.handlers.onPeerJoin('петя');

    expect(room.state().peers[0].name).toBe(null);
  });
});

describe('выбор устройства из настроек', () => {
  const mediaWithSwap = swap => ({...fakeMedia(), useMicrophone: vi.fn().mockResolvedValue(swap), useCamera: vi.fn().mockResolvedValue(swap), chosen: () => ({microphone: null, camera: null})});

  it('новая makeTrack микрофона переставляется на соединениях', async () => {
    const swap = {old: {id: 'старая'}, next: {id: 'новая'}};
    const {room, connection} = await openRoom({media: mediaWithSwap(swap)});

    await room.setMicrophoneDevice('м2');

    expect(connection.replaceTrack).toHaveBeenCalledWith(swap.old, swap.next);
  });

  it('без живой дорожки выбор просто запоминается, ничего не переставляется', async () => {
    const {room, connection} = await openRoom({media: mediaWithSwap(null)});

    await room.setMicrophoneDevice('м2');

    expect(connection.replaceTrack).not.toHaveBeenCalled();
  });

  it('камера переставляется тем же порядком', async () => {
    const swap = {old: {id: 'старая'}, next: {id: 'новая'}};
    const {room, connection} = await openRoom({media: mediaWithSwap(swap)});

    await room.setCameraDevice('к2');

    expect(connection.replaceTrack).toHaveBeenCalledWith(swap.old, swap.next);
  });
});

describe('показ экрана', () => {
  const mediaWithScreen = (swap, canShare = true) => ({
    ...fakeMedia(),
    canShareScreen: () => canShare,
    useScreen: vi.fn().mockResolvedValue(swap),
    chosen: () => ({microphone: null, camera: null}),
  });

  it('пока не показываем — так и говорим', async () => {
    const {room} = await openRoom({media: mediaWithScreen(null)});

    expect(room.state().screen).toBe(false);
    expect(room.state().canShareScreen).toBe(true);
  });

  it('где браузер не умеет — честно сообщаем, чтобы кнопки не было', async () => {
    const {room} = await openRoom({media: mediaWithScreen(null, false)});

    expect(room.state().canShareScreen).toBe(false);
  });

  // Лицо и экран идут вместе. Пометка обязательна: по ней собеседник
  // отличит одно от другого и покажет двумя плитками.
  it('дорожка экрана уходит помеченной, камеру не трогаем', async () => {
    const экран = {id: 'экран'};
    const {room, connection} = await openRoom({media: mediaWithScreen({added: экран})});

    await room.setScreen(true);

    expect(connection.replaceTrack).not.toHaveBeenCalled();
    const [дорожка, , метка] = connection.addTrack.mock.calls[0];
    expect(дорожка).toBe(экран);
    expect(метка).toEqual({role: 'screen'});
    expect(room.state().screen).toBe(true);
  });

  it('прекращение показа снимает только дорожку экрана', async () => {
    const экран = {id: 'экран'};
    const media = mediaWithScreen({added: экран});
    const {room, connection} = await openRoom({media});
    await room.setScreen(true);
    media.useScreen.mockResolvedValue({removed: экран});

    await room.setScreen(false);

    expect(connection.removeTrack).toHaveBeenCalledWith(экран);
    expect(room.state().screen).toBe(false);
  });

  // Поток экрана теперь спрашивают о дорожках: пустой поток — это не показ.
  const потокЭкрана = (дорожек = 1) => ({
    id: 'экран',
    getVideoTracks: () => Array.from({length: дорожек}, (_, i) => ({kind: 'video', id: i})),
  });

  it('экран собеседника приходит отдельным потоком, а не вместо лица', async () => {
    const {room, connection} = await openRoom({media: mediaWithScreen(null)});
    connection.handlers.onPeerJoin('петя');
    const лицо = {id: 'лицо'};
    const экран = потокЭкрана();

    connection.handlers.onPeerStream(лицо, 'петя', 'camera');
    connection.handlers.onPeerStream(экран, 'петя', 'screen');

    expect(room.state().peers[0]).toEqual({
      peerId: 'петя',
      stream: лицо,
      screen: экран,
      name: null,
    });
  });

  it('собеседник прекратил показ — плитка экрана уходит', async () => {
    // Снятие дорожки у отправителя даёт получателю 'mute', а не 'ended':
    // по состоянию дорожки конец показа не отличить от задержки на
    // пересогласовании. Поэтому конец объявляется словом по каналу данных.
    const {room, connection} = await openRoom({media: mediaWithScreen(null)});
    connection.handlers.onPeerJoin('петя');
    connection.handlers.onPeerStream({id: 'лицо'}, 'петя', 'camera');
    connection.handlers.onPeerStream(потокЭкрана(), 'петя', 'screen');
    expect(room.state().peers[0].screen).not.toBe(null);

    connection.channel('screen').onMessage(false, {peerId: 'петя'});

    expect(room.state().peers[0].screen).toBe(null);
    // Сам собеседник никуда не делся — ушла только плитка экрана.
    expect(room.state().peers[0].stream).toEqual({id: 'лицо'});
  });

  it('пустой поток экрана плиткой не становится', async () => {
    const {room, connection} = await openRoom({media: mediaWithScreen(null)});
    connection.handlers.onPeerJoin('петя');
    connection.handlers.onPeerStream(потокЭкрана(), 'петя', 'screen');

    connection.handlers.onPeerStream(потокЭкрана(0), 'петя', 'screen');

    expect(room.state().peers[0].screen).toBe(null);
  });

  it('о своём показе сообщаем и тому, кто вошёл позже', async () => {
    // Иначе вошедший увидит дорожку и не будет знать, что это экран, —
    // а по одной дорожке этого не сказать.
    const дорожка = {kind: 'video', id: 'экран'};
    const {room, connection} = await openRoom({media: mediaWithScreen(дорожка)});
    await room.setScreen(true);
    connection.channel('screen').sent.length = 0;

    connection.handlers.onPeerJoin('поздний');

    expect(connection.channel('screen').sent).toEqual([true]);
  });

  it('прекратили показ — говорим об этом собеседникам', async () => {
    const дорожка = {kind: 'video', id: 'экран'};
    const {room, connection} = await openRoom({media: mediaWithScreen(дорожка)});
    await room.setScreen(true);

    await room.setScreen(false);

    expect(connection.channel('screen').sent).toEqual([true, false]);
  });

  it('человек передумал в окне выбора — это не поломка, показ просто не начался', async () => {
    const media = mediaWithScreen(null);
    media.useScreen = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    const {room} = await openRoom({media});

    await room.setScreen(true);

    expect(room.state().screen).toBe(false);
  });

  it('второе нажатие, пока браузер ещё спрашивает, ничего не ломает', async () => {
    const media = mediaWithScreen({old: null, next: {id: 'экран'}});
    let отпустить;
    media.useScreen = vi.fn(() => new Promise(r => (отпустить = r)));
    const {room} = await openRoom({media});

    const первое = room.setScreen(true);
    await room.setScreen(true);
    отпустить({old: null, next: {id: 'экран'}});
    await первое;

    expect(media.useScreen).toHaveBeenCalledTimes(1);
  });
});

describe('переписка', () => {
  it('в начале лента пуста и непрочитанного нет', async () => {
    const {room} = await openRoom();

    expect(room.state().messages).toEqual([]);
    expect(room.state().unread).toBe(0);
  });

  it('своё сообщение появляется в ленте сразу и уходит собеседникам', async () => {
    const {room, connection} = await openRoom({name: 'Пётр'});

    expect(room.say('привет')).toBe(true);

    expect(room.state().messages).toEqual([
      expect.objectContaining({text: 'привет', from: 'Пётр', mine: true}),
    ]);
    expect(connection.channel('chat').sent).toEqual(['привет']);
  });

  it('пустое не отправляется и в ленту не попадает', async () => {
    const {room, connection} = await openRoom();

    expect(room.say('   ')).toBe(false);

    expect(room.state().messages).toEqual([]);
    // Канал заводится при старте звонка, а вот отправлено по нему ничего.
    expect(connection.channel('chat').sent).toEqual([]);
  });

  it('чужое сообщение подписано именем собеседника', async () => {
    const {room, connection} = await openRoom();
    connection.handlers.onPeerJoin('петя');
    connection.channel('name').onMessage('Пётр', {peerId: 'петя'});

    connection.channel('chat').onMessage('и тебе привет', {peerId: 'петя'});

    expect(room.state().messages).toEqual([
      expect.objectContaining({text: 'и тебе привет', from: 'Пётр', mine: false}),
    ]);
  });

  it('пришедшее считается непрочитанным, своё — нет', async () => {
    const {room, connection} = await openRoom();
    connection.handlers.onPeerJoin('петя');

    connection.channel('chat').onMessage('ау', {peerId: 'петя'});
    room.say('слушаю');

    expect(room.state().unread).toBe(1);
  });

  it('открыли переписку — непрочитанное обнуляется', async () => {
    const {room, connection} = await openRoom();
    connection.handlers.onPeerJoin('петя');
    connection.channel('chat').onMessage('ау', {peerId: 'петя'});

    room.readChat();

    expect(room.state().unread).toBe(0);
  });
});

describe('реакции', () => {
  it('чужая реакция всплывает над плиткой того, кто послал', async () => {
    const {room, connection} = await openRoom();
    connection.handlers.onPeerJoin('петя');

    connection.channel('chat').onMessage('👍', {peerId: 'петя'});

    expect(room.state().reactions.get('петя')).toEqual(
      expect.objectContaining({emoji: '👍'}),
    );
  });

  it('реакция не будит счётчик непрочитанного, а слово — будит', async () => {
    // Реакцию человек уже увидел над плиткой. Звать его открывать
    // переписку ради значка — значит обещать там то, чего нет.
    const {room, connection} = await openRoom();
    connection.handlers.onPeerJoin('петя');

    connection.channel('chat').onMessage('👍', {peerId: 'петя'});
    expect(room.state().unread).toBe(0);

    connection.channel('chat').onMessage('привет', {peerId: 'петя'});
    expect(room.state().unread).toBe(1);
  });

  it('реакция всё равно остаётся в ленте', async () => {
    const {room, connection} = await openRoom();
    connection.handlers.onPeerJoin('петя');

    connection.channel('chat').onMessage('👍', {peerId: 'петя'});

    expect(room.state().messages).toEqual([
      expect.objectContaining({text: '👍', mine: false}),
    ]);
  });

  it('своя реакция всплывает над своей плиткой и уходит собеседникам', async () => {
    const {room, connection} = await openRoom();

    room.say('🎉');

    expect(room.state().reactions.get('self')).toEqual(
      expect.objectContaining({emoji: '🎉'}),
    );
    expect(connection.channel('chat').sent).toEqual(['🎉']);
  });

  it('через четыре секунды гаснет', async () => {
    const {room, connection} = await openRoom();
    connection.handlers.onPeerJoin('петя');
    connection.channel('chat').onMessage('👍', {peerId: 'петя'});

    await vi.advanceTimersByTimeAsync(4_000);

    expect(room.state().reactions.has('петя')).toBe(false);
  });

  it('ушедший не оставляет после себя значка', async () => {
    const {room, connection} = await openRoom();
    connection.handlers.onPeerJoin('петя');
    connection.channel('chat').onMessage('👍', {peerId: 'петя'});

    connection.handlers.onPeerLeave('петя');

    expect(room.state().reactions.has('петя')).toBe(false);
  });
});

describe('возвращение после погасшего экрана', () => {
  // Телефон за скрытой страницей отбирает дорожки: они кончаются
  // (readyState === 'ended'), и воскресить их нельзя — только захватить
  // заново. Заглушённую (muted) трогать нельзя: она оживёт сама.
  const поток = (...дорожки) => ({
    getAudioTracks: () => дорожки.filter(t => t.kind === 'audio'),
    getVideoTracks: () => дорожки.filter(t => t.kind === 'video'),
  });
  const дорожка = (kind, readyState = 'live') => ({kind, readyState, enabled: true});

  it('микрофон кончился, пока экран был погашен, — захватываем заново', async () => {
    const media = fakeMedia();
    const {room} = await openRoom({media});
    media.captureMicrophone.mockResolvedValue(дорожка('audio'));
    await room.setMicrophone(true);
    media.captureMicrophone.mockClear();
    media.current.mockReturnValue(поток(дорожка('audio', 'ended')));

    await room.wake();

    expect(media.captureMicrophone).toHaveBeenCalled();
  });

  it('живую дорожку не трогаем', async () => {
    // Перезахват ради живой дорожки — лишний поход к устройству, огонёк
    // камеры мигает, а собеседник теряет звук на время пересогласования.
    const media = fakeMedia();
    const {room} = await openRoom({media});
    media.captureMicrophone.mockResolvedValue(дорожка('audio'));
    await room.setMicrophone(true);
    media.captureMicrophone.mockClear();
    media.current.mockReturnValue(поток(дорожка('audio', 'live')));

    await room.wake();

    expect(media.captureMicrophone).not.toHaveBeenCalled();
  });

  it('заглушённую дорожку тоже не трогаем — она оживёт сама', async () => {
    const media = fakeMedia();
    const {room} = await openRoom({media});
    media.captureMicrophone.mockResolvedValue(дорожка('audio'));
    await room.setMicrophone(true);
    media.captureMicrophone.mockClear();
    media.current.mockReturnValue(поток({kind: 'audio', readyState: 'live', muted: true}));

    await room.wake();

    expect(media.captureMicrophone).not.toHaveBeenCalled();
  });

  it('выключённую камеру не включаем обратно', async () => {
    // Человек выключил камеру сам — возвращение из спящего экрана не
    // повод её зажечь.
    const media = fakeMedia();
    const {room} = await openRoom({media});
    media.current.mockReturnValue(поток(дорожка('video', 'ended')));

    await room.wake();

    expect(media.captureCamera).not.toHaveBeenCalled();
  });

  it('экран перерисовывается: состояние могло поменяться', async () => {
    const {room, onChange} = await openRoom();
    onChange.mockClear();

    await room.wake();

    expect(onChange).toHaveBeenCalled();
  });
});
