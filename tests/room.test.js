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
// плюс track.kind, по которому room.js отличает видео от звука.
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
  return {
    handlers: null,
    addStream: vi.fn(),
    getPeers: () => Object.fromEntries(pcs),
    leave: vi.fn().mockResolvedValue(undefined),
    setPeer: (peerId, pc) => pcs.set(peerId, pc),
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
} = {}) => {
  const room = await createRoom({
    secret: 'секрет-теста',
    connectFn: fakeConnectFn(connection),
    media,
    ladder,
    onChange,
  });
  return {room, connection, media, ladder, onChange};
};

describe('потолок битрейта на пересчёте ступени', () => {
  it('проставляется отправителям, даже когда ступень не менялась (звонок вдвоём)', async () => {
    const connection = fakeConnection();
    const sender = fakeSender();
    connection.setPeer('сосед', fakePeer([sender]));

    // Настоящая лестница: при 1↔2 собеседниках stepForPeers всегда даёт
    // 'full' — имя ступени не меняется никогда. Это и есть находка 1.
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
    expect(onChange).toHaveBeenCalledTimes(1); // не выросло — перерисовки вхолостую не было

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
// лестница качества и определение говорящего. Единого хозяина не было, и
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

    // cameraWanted остаётся true по умолчанию — человек ничего не нажимал.
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

    expect(room.state().cam).toBe(true);
    expect(room.state().mic).toBe(true);

    room.setCamera(false);
    expect(room.state().cam).toBe(false);

    room.setMicrophone(false);
    expect(room.state().mic).toBe(false);

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
    };
    const media = createMedia({getUserMedia: vi.fn().mockResolvedValue(stream)});

    // full -> small: обычный видео-режим (videoFor: 'all' у обеих), не
    // голосовой, — ровно тот переход, где раньше проявлялась гонка.
    const ladder = fakeLadder([SMALL]);
    const {room} = await openRoom({media, ladder});

    room.setCamera(false);
    enabledHistory.length = 0; // дальше важно только то, что после выключения

    await vi.advanceTimersByTimeAsync(STATS_EVERY_MS); // такт со сменой ступени

    expect(enabledHistory).not.toContain(true);
    expect(video.enabled).toBe(false);

    await room.leave();
  });
});

// Находка «не молчать» 2: захват медиа идёт до подключения, а подключение
// по-настоящему может отклониться (WAIT_FOR_LIFE_MS в src/signal/index.js).
// Раньше при отказе createRoom падал целиком, а поток никто не гасил —
// media.stop() жил только в leave(), до которого дело не доходило: человек
// видел «Связь не установилась», а камера продолжала гореть до закрытия
// вкладки.
describe('поток гасится, если рукопожатие не состоялось', () => {
  it('media.stop() вызывается до того, как ошибка connectFn() долетит до вызывающего', async () => {
    const media = fakeMedia();
    const boom = Object.assign(new Error('ни собеседника, ни живого канала'), {
      name: 'HandshakeTimeoutError',
    });
    const connectFn = vi.fn().mockRejectedValue(boom);

    await expect(
      createRoom({secret: 'секрет-теста', connectFn, media, ladder: fakeLadder([FULL])})
    ).rejects.toBe(boom);

    expect(media.start).toHaveBeenCalled(); // поток был захвачен...
    expect(media.stop).toHaveBeenCalled(); // ...и погашен, а не оставлен гореть
  });

  it('успешное подключение media.stop() не трогает', async () => {
    const {room, media} = await openRoom();

    expect(media.stop).not.toHaveBeenCalled();

    await room.leave();
    expect(media.stop).toHaveBeenCalledTimes(1);
  });
});
