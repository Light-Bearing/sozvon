import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRoom} from '../src/room.js';
import {createLadder, stepForPeers} from '../src/ladder.js';

// createRoom.state() зовёт secretToLink() без базы — та берёт глобальный
// location, которого в узловом окружении vitest (без jsdom) нет. Содержимое
// ссылки в этих тестах не проверяется, поэтому достаточно минимальной
// подстановки, лишь бы announce() не падал.
beforeEach(() => {
  globalThis.location = {origin: 'https://sozvon.test', pathname: '/'};
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
