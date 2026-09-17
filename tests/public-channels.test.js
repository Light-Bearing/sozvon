import {beforeEach, describe, expect, it, vi} from 'vitest';
import {familiesFor, joinPublicChannels, parseFamilyNames} from '../src/signal/public-channels.js';
import {relayUrlsFor} from '../src/signal/relays.js';

const FAMILY_NAMES = ['nostr', 'mqtt'];

// Поток собеседника приложение собирает само, поэтому «поток» в тестах —
// не пустышка с полем id, а нечто, у чего есть дорожки.
const fakeTrack = kind => {
  const listeners = {};
  const track = {
    kind,
    readyState: 'live',
    enabled: true,
    muted: false,
    addEventListener: (name, fn) => (listeners[name] = fn),
    // Настоящая дорожка при завершении меняет readyState — подделка обязана
    // делать то же, иначе тест проверяет не то, что происходит на деле.
    end: () => {
      track.readyState = 'ended';
      listeners.ended?.();
    },
    mute: () => {
      track.muted = true;
      listeners.mute?.();
    },
  };
  return track;
};

const fakeStream = (...tracks) => ({
  id: 'поток-' + tracks.map(t => t.kind).join('-'),
  getTracks: () => tracks,
});

class FakeMediaStream {
  constructor() {
    this.tracks = [];
  }
  addTrack(t) {
    if (!this.tracks.includes(t)) this.tracks.push(t);
  }
  removeTrack(t) {
    this.tracks = this.tracks.filter(x => x !== t);
  }
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter(t => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter(t => t.kind === 'audio');
  }
}
globalThis.MediaStream = FakeMediaStream;

// Поддельная комната вместо настоящего joinRoom из трёх пакетов trystero.
// Даёт ровно то, чем пользуется public-channels.js (onPeerJoin/onPeerLeave/
// onPeerStream, getPeers, addStream, replaceTrack, makeAction, leave) плюс
// тестовые хуки join/leave/stream для имитации событий библиотеки — саму
// библиотеку в тестах не открываем (живая проверка — задача 7).
const createFakeRoom = () => {
  const peers = new Map();
  const addStreamCalls = [];
  const addTrackCalls = [];
  const removeTrackCalls = [];
  const actionsByNamespace = new Map();

  const room = {
    onPeerJoin: null,
    onPeerLeave: null,
    onPeerStream: null,
    onPeerTrack: null,
    getPeers: () => Object.fromEntries(peers),
    addStream: (stream, options = {}) =>
      addStreamCalls.push({stream, target: options.target}),
    addTrack: (track, stream, options = {}) =>
      addTrackCalls.push({track, stream, target: options.target}),
    removeTrack: (track, options = {}) => removeTrackCalls.push({track, target: options.target}),
    replaceTrack: () => {},
    makeAction: namespace => {
      if (!actionsByNamespace.has(namespace)) {
        const calls = [];
        let onMessage = null;
        actionsByNamespace.set(namespace, {
          calls,
          send: (data, options = {}) => {
            calls.push({data, target: options.target});
            return Promise.resolve();
          },
          get onMessage() {
            return onMessage;
          },
          set onMessage(fn) {
            onMessage = fn;
          },
        });
      }
      return actionsByNamespace.get(namespace);
    },
    leave: () => Promise.resolve(),
  };

  return {
    room,
    // Третий довод joinRoom — обратные вызовы библиотеки. Комнату заводит
    // public-channels.js, поэтому тест добирается до них через эту ссылку.
    callbacks: null,
    addStreamCalls,
    addTrackCalls,
    removeTrackCalls,
    // Поддельные сокеты релеев этого семейства — {url: {readyState}}.
    // Пустой объект по умолчанию: ни один адрес не открыт, семейство мертво,
    // пока тест явно не откроет сокет через sockets.
    sockets: {},
    action: namespace => room.makeAction(namespace),
    join: peerId => {
      peers.set(peerId, {peerId});
      room.onPeerJoin?.(peerId);
    },
    leave: peerId => {
      peers.delete(peerId);
      room.onPeerLeave?.(peerId);
    },
    stream: (stream, peerId) => room.onPeerStream?.(stream, peerId),
    track: (track, stream, peerId) => room.onPeerTrack?.(track, stream, peerId),
  };
};

describe('публичные каналы: адресная доставка', () => {
  let fakes;
  let handlers;
  let connection;

  beforeEach(() => {
    fakes = Object.fromEntries(FAMILY_NAMES.map(name => [name, createFakeRoom()]));
    const families = FAMILY_NAMES.map(family => ({
      family,
      join: (_config, _roomId, callbacks) => {
        fakes[family].callbacks = callbacks;
        return fakes[family].room;
      },
      // Читает fakes[family].sockets заново при каждом вызове — тест может
      // поменять его после того, как connection уже создан.
      getRelaySockets: () => fakes[family].sockets,
    }));
    handlers = {
      onPeerJoin: vi.fn(),
      onPeerLeave: vi.fn(),
      onPeerStream: vi.fn(),
      onTrouble: vi.fn(),
    };
    connection = joinPublicChannels({roomId: 'r', password: 'p', handlers, families});
  });

  describe('addStream', () => {
    it('участник, известный двум семействам, получает поток один раз — в комнате владельца', () => {
      fakes.nostr.join('петя');
      fakes.mqtt.join('петя');
      const stream = {id: 'stream-1'};

      connection.addStream(stream);

      expect(fakes.nostr.addStreamCalls).toEqual([{stream, target: 'петя'}]);
      expect(fakes.mqtt.addStreamCalls).toEqual([]);
    });

    it('поток, добавленный заранее, доразмечается новому участнику в комнате владельца', () => {
      const stream = {id: 'stream-1'};

      connection.addStream(stream);
      fakes.nostr.join('петя');
      fakes.mqtt.join('петя');

      expect(fakes.nostr.addStreamCalls).toEqual([{stream, target: 'петя'}]);
      expect(fakes.mqtt.addStreamCalls).toEqual([]);
    });
  });

  // Включение микрофона/камеры человеком после входа — addTrack()/
  // removeTrack() следуют тому же правилу «решает отправитель», что и
  // addStream() выше: своё медиа уходит адресно, только через канал
  // владельца, никогда широковещательно.
  describe('addTrack и removeTrack', () => {
    it('дорожка уходит только владельцу, адресно', () => {
      fakes.nostr.join('петя');
      fakes.mqtt.join('петя');
      const track = {id: 'track-1'};
      const stream = {id: 'stream-1'};

      connection.addTrack(track, stream);

      expect(fakes.nostr.addTrackCalls).toEqual([{track, stream, target: 'петя'}]);
      expect(fakes.mqtt.addTrackCalls).toEqual([]);
    });

    it('несколько участников из разных семейств — каждому своя адресная дорожка', () => {
      fakes.nostr.join('аня');
      fakes.mqtt.join('боря');
      const track = {id: 'track-1'};
      const stream = {id: 'stream-1'};

      connection.addTrack(track, stream);

      expect(fakes.nostr.addTrackCalls).toEqual([{track, stream, target: 'аня'}]);
      expect(fakes.mqtt.addTrackCalls).toEqual([{track, stream, target: 'боря'}]);
    });

    it('дорожка, добавленная заранее, доразмечается новому участнику вместе с остальным потоком', () => {
      const track = {id: 'track-1'};
      const stream = {id: 'stream-1'};

      connection.addTrack(track, stream);
      fakes.nostr.join('петя');
      fakes.mqtt.join('петя');

      // Как и у addStream() выше: localStream досылается новому участнику
      // целиком через onPeerJoin() — отдельного addTrackCalls «задним
      // числом» для позже подключившихся нет и не нужно.
      expect(fakes.nostr.addStreamCalls).toEqual([{stream, target: 'петя'}]);
      expect(fakes.mqtt.addStreamCalls).toEqual([]);
    });

    it('removeTrack снимает дорожку только у владельца, тоже адресно', () => {
      fakes.nostr.join('петя');
      fakes.mqtt.join('петя');
      const track = {id: 'track-1'};

      connection.removeTrack(track);

      expect(fakes.nostr.removeTrackCalls).toEqual([{track, target: 'петя'}]);
      expect(fakes.mqtt.removeTrackCalls).toEqual([]);
    });
  });

  describe('action(namespace).send', () => {
    it('уходит адресно и сгруппировано по владельцу, а каналу без участников — ничего', async () => {
      fakes.nostr.join('аня');
      fakes.nostr.join('боря');
      fakes.mqtt.join('вера');

      await connection.action('chat').send({text: 'привет'});

      expect(fakes.nostr.action('chat').calls).toEqual([
        {data: {text: 'привет'}, target: ['аня', 'боря']},
      ]);
      expect(fakes.mqtt.action('chat').calls).toEqual([
        {data: {text: 'привет'}, target: ['вера']},
      ]);
    });
  });

  describe('onPeerStream', () => {
    it('второй поток от уже принятого участника наверх не проходит', () => {
      fakes.nostr.join('петя');
      const первый = fakeTrack('audio');
      const второй = fakeTrack('audio');

      fakes.nostr.stream(fakeStream(первый), 'петя');
      fakes.nostr.stream(fakeStream(второй), 'петя');

      expect(handlers.onPeerStream).toHaveBeenCalledTimes(1);
      expect(handlers.onPeerStream.mock.calls[0][0].getTracks()).toEqual([первый]);
    });

    it('принимается от любого семейства, не только от владельца', () => {
      fakes.nostr.join('петя');
      fakes.mqtt.join('петя');
      const дорожка = fakeTrack('video');

      fakes.mqtt.stream(fakeStream(дорожка), 'петя');

      expect(handlers.onPeerStream).toHaveBeenCalledTimes(1);
      expect(handlers.onPeerStream.mock.calls[0][0].getTracks()).toEqual([дорожка]);
    });
  });

  describe('призрак', () => {
    it('ушёл владелец, но соседнее семейство ещё видит участника — наверх не сообщаем, участник остаётся в getPeers()', () => {
      fakes.nostr.join('петя');
      fakes.mqtt.join('петя');

      fakes.nostr.leave('петя');

      expect(handlers.onPeerLeave).not.toHaveBeenCalled();
      expect(connection.getPeers()).toHaveProperty('петя');
    });

    it('живой поток переотправляется адресно в комнату нового владельца', () => {
      const stream = {id: 's1'};
      connection.addStream(stream);
      fakes.nostr.join('петя');
      fakes.mqtt.join('петя');

      fakes.nostr.leave('петя');

      expect(fakes.mqtt.addStreamCalls).toEqual([{stream, target: 'петя'}]);
    });

    it('ушёл последний — вот тогда сообщаем об уходе', () => {
      fakes.nostr.join('петя');
      fakes.mqtt.join('петя');
      fakes.nostr.leave('петя');

      expect(handlers.onPeerLeave).not.toHaveBeenCalled(); // после первого ухода — тишина

      fakes.mqtt.leave('петя');

      expect(handlers.onPeerLeave).toHaveBeenCalledTimes(1);
      expect(handlers.onPeerLeave).toHaveBeenCalledWith('петя');
      expect(connection.getPeers()).not.toHaveProperty('петя');
    });
  });

  describe('переподключение участника', () => {
    it('участник полностью ушёл, вернулся в той же сессии — его новый поток доходит наверх', () => {
      const первая = fakeTrack('audio');
      const вторая = fakeTrack('video');
      const последний = () => handlers.onPeerStream.mock.calls.at(-1)[0];

      fakes.nostr.join('петя');
      fakes.nostr.stream(fakeStream(первая), 'петя');
      expect(handlers.onPeerStream).toHaveBeenCalledTimes(1);
      expect(последний().getTracks()).toEqual([первая]);

      handlers.onPeerStream.mockClear();
      fakes.nostr.leave('петя');
      expect(handlers.onPeerLeave).toHaveBeenCalledTimes(1);
      expect(handlers.onPeerLeave).toHaveBeenCalledWith('петя');

      fakes.nostr.join('петя');
      fakes.nostr.stream(fakeStream(вторая), 'петя');

      expect(handlers.onPeerStream).toHaveBeenCalledTimes(1);
      // Старой дорожки быть не должно: ушедший унёс свой поток с собой.
      expect(последний().getTracks()).toEqual([вторая]);
    });
  });

  // Находка 5: раньше status() просто отдавал настроенный список адресов —
  // он ничего не говорил о том, жив ли канал прямо сейчас, и его никто не
  // читал. Теперь он честно смотрит на readyState сокетов из getRelaySockets().
  describe('status(): какие каналы живы прямо сейчас', () => {
    it('семейство без единого открытого сокета живым не считается', () => {
      const nostr = connection.status().find(c => c.family === 'nostr');
      expect(nostr.alive).toBe(false);
      expect(nostr.aliveCount).toBe(0);
    });

    it('семейство с открытым (readyState: OPEN) сокетом на своём адресе считается живым', () => {
      const url = relayUrlsFor('nostr')[0];
      fakes.nostr.sockets = {[url]: {readyState: 1}};

      const nostr = connection.status().find(c => c.family === 'nostr');
      expect(nostr.alive).toBe(true);
      expect(nostr.aliveCount).toBe(1);

      // Соседнее семейство эта правка не задевает.
      expect(connection.status().find(c => c.family === 'mqtt').alive).toBe(false);
    });

    it('сокет ещё подключается (readyState CONNECTING, не OPEN) — живым не считается', () => {
      const url = relayUrlsFor('nostr')[0];
      fakes.nostr.sockets = {[url]: {readyState: 0}};

      expect(connection.status().find(c => c.family === 'nostr').alive).toBe(false);
    });

    it('relays в ответе — это адреса именно этого семейства, из relayUrlsFor', () => {
      const nostr = connection.status().find(c => c.family === 'nostr');
      expect(nostr.relays).toEqual(relayUrlsFor('nostr'));
    });
  });
});

// Переключатель семейств для диагностики: ?каналы=nostr или
// ?каналы=nostr,mqtt в адресе страницы (см. main.js). Разбор строки и
// отбор по имени — чистые функции, без браузера и без trystero.
describe('parseFamilyNames', () => {
  it('одно имя', () => {
    expect(parseFamilyNames('nostr')).toEqual(['nostr']);
  });

  it('несколько имён через запятую, с пробелами', () => {
    expect(parseFamilyNames('nostr, mqtt')).toEqual(['nostr', 'mqtt']);
  });

  it('параметра нет вовсе — пустой список', () => {
    expect(parseFamilyNames(null)).toEqual([]);
    expect(parseFamilyNames(undefined)).toEqual([]);
  });

  it('параметр есть, но пустой или из одних запятых — пустой список, а не список пустых строк', () => {
    expect(parseFamilyNames('')).toEqual([]);
    expect(parseFamilyNames(',,')).toEqual([]);
  });
});

describe('familiesFor', () => {
  const ALL = [{family: 'nostr'}, {family: 'mqtt'}];

  it('без имён — все семейства, как всегда', () => {
    expect(familiesFor([], ALL)).toBe(ALL);
  });

  it('с именем — только совпавшие', () => {
    expect(familiesFor(['nostr'], ALL)).toEqual([{family: 'nostr'}]);
  });

  it('несколько имён — сохраняют исходный порядок списка семейств, а не порядок в параметре', () => {
    expect(familiesFor(['mqtt', 'nostr'], ALL)).toEqual([{family: 'nostr'}, {family: 'mqtt'}]);
  });

  it('неизвестное имя молча отсеивается — это инструмент для своего эксперимента, не форма с проверкой', () => {
    expect(familiesFor(['nostr', 'неведомое'], ALL)).toEqual([{family: 'nostr'}]);
  });

  it('все имена неизвестны — пустой список семейств, а не полный набор по умолчанию', () => {
    expect(familiesFor(['неведомое'], ALL)).toEqual([]);
  });
});

// Пока библиотека молча не могла соединиться, экран показывал «Жду, когда
// зайдут» до скончания века — хотя собеседник был найден, описания
// соединения разошлись, и не сложился только прямой путь. Эти жалобы
// библиотека отдаёт третьим доводом joinRoom, и теперь они доходят наверх.
describe('публичные каналы: жалобы на неудачу', () => {
  let fakes;
  let handlers;
  let connection;

  const complain = (family, error, peerId = 'петя') =>
    fakes[family].callbacks.onJoinError({error, peerId, appId: 'sozvon', roomId: 'r'});

  beforeEach(() => {
    fakes = Object.fromEntries(FAMILY_NAMES.map(name => [name, createFakeRoom()]));
    const families = FAMILY_NAMES.map(family => ({
      family,
      join: (_config, _roomId, callbacks) => {
        fakes[family].callbacks = callbacks;
        return fakes[family].room;
      },
      getRelaySockets: () => fakes[family].sockets,
    }));
    handlers = {onPeerJoin: vi.fn(), onTrouble: vi.fn()};
    connection = joinPublicChannels({roomId: 'r', password: 'p', handlers, families});
  });

  const NO_PATH = 'could not connect to peer петя after exchanging SDP; configure TURN servers';

  it('жалоба доходит наверх опознанной', () => {
    complain('nostr', NO_PATH);

    expect(handlers.onTrouble).toHaveBeenCalledWith([{peerId: 'петя', kind: 'no-path'}]);
  });

  it('одна и та же беда от обоих семейств — одно сообщение, а не два', () => {
    complain('nostr', NO_PATH);
    complain('mqtt', NO_PATH);

    expect(handlers.onTrouble).toHaveBeenCalledTimes(1);
  });

  it('вошедший собеседник отменяет жалобу на себя', () => {
    complain('nostr', NO_PATH);
    handlers.onTrouble.mockClear();

    fakes.mqtt.join('петя');

    expect(handlers.onTrouble).toHaveBeenCalledWith([]);
  });

  it('на уже вошедшего не жалуемся: у него всё получилось', () => {
    fakes.nostr.join('петя');
    handlers.onTrouble.mockClear();

    complain('nostr', NO_PATH);

    expect(handlers.onTrouble).not.toHaveBeenCalled();
  });

  it('разные собеседники — разные жалобы', () => {
    complain('nostr', NO_PATH, 'петя');
    complain('nostr', 'handshake timed out after 15000ms', 'вася');

    expect(handlers.onTrouble).toHaveBeenLastCalledWith([
      {peerId: 'петя', kind: 'no-path'},
      {peerId: 'вася', kind: 'handshake'},
    ]);
  });

  it('ушедший собеседник уносит свою жалобу с собой', () => {
    fakes.nostr.join('петя');
    fakes.nostr.leave('петя');
    complain('nostr', NO_PATH);
    handlers.onTrouble.mockClear();

    fakes.nostr.join('петя');

    expect(handlers.onTrouble).toHaveBeenCalledWith([]);
    expect(connection.troubles()).toEqual([]);
  });
});

describe('ретранслятор доходит до библиотеки', () => {
  const собрать = turnConfig => {
    const настройки = [];
    const families = FAMILY_NAMES.map(family => ({
      family,
      join: config => {
        настройки.push(config);
        return createFakeRoom().room;
      },
      getRelaySockets: () => ({}),
    }));
    joinPublicChannels({roomId: 'r', password: 'p', handlers: {}, families, turnConfig});
    return настройки;
  };

  it('список ретрансляторов попадает в настройку каждого семейства', () => {
    const turnConfig = [{urls: 'turn:host:3478', username: 'u', credential: 'c'}];

    expect(собрать(turnConfig).map(c => c.turnConfig)).toEqual([turnConfig, turnConfig]);
  });

  it('без ретранслятора поля нет вовсе — библиотека берёт свои умолчания', () => {
    for (const config of собрать(undefined)) expect('turnConfig' in config).toBe(false);
    for (const config of собрать([])) expect('turnConfig' in config).toBe(false);
  });
});

// Дорожку, добавленную ПОСЛЕ того как соединение встало (человек включил
// микрофон уже внутри разговора), библиотека отдаёт через onPeerTrack, а не
// onPeerStream. Мы слушали только второе — и медиа собеседника доходило до
// соединения, но не доходило до экрана.
//
// Поток собеседника мы теперь держим свой и накопительный. Иначе выходит
// так: при пересогласовании (а оно случается на каждое включение микрофона
// или камеры) библиотека может отдать дорожку с ДРУГИМ объектом потока —
// и плитка мгновенно теряет всё, чего в новом потоке нет. На своей машине
// этого не видно, на живых устройствах видно сразу.
describe('поток собеседника собирается у нас, а не берётся как дали', () => {
  let fakes;
  let handlers;

  beforeEach(() => {
    fakes = Object.fromEntries(FAMILY_NAMES.map(name => [name, createFakeRoom()]));
    const families = FAMILY_NAMES.map(family => ({
      family,
      join: () => fakes[family].room,
      getRelaySockets: () => fakes[family].sockets,
    }));
    handlers = {onPeerJoin: vi.fn(), onPeerStream: vi.fn(), onPeerLeave: vi.fn()};
    joinPublicChannels({roomId: 'r', password: 'p', handlers, families});
  });

  const последний = () => handlers.onPeerStream.mock.calls.at(-1)[0];

  it('звук и картинка сходятся в один поток', () => {
    fakes.nostr.join('петя');
    const звук = fakeTrack('audio');
    const видео = fakeTrack('video');

    fakes.nostr.track(звук, {id: 'чужой-1'}, 'петя');
    fakes.nostr.track(видео, {id: 'чужой-1'}, 'петя');

    expect(последний().getTracks()).toEqual([звук, видео]);
  });

  it('дорожка с ДРУГИМ объектом потока не стирает уже собранное', () => {
    fakes.nostr.join('петя');
    const видео = fakeTrack('video');
    const звук = fakeTrack('audio');

    fakes.nostr.track(видео, {id: 'чужой-1'}, 'петя');
    // Собеседник включил микрофон, пересогласование дало новый объект.
    fakes.nostr.track(звук, {id: 'чужой-ДРУГОЙ'}, 'петя');

    expect(последний().getVideoTracks()).toEqual([видео]);
    expect(последний().getAudioTracks()).toEqual([звук]);
  });

  it('закончившаяся дорожка уходит из потока', () => {
    fakes.nostr.join('петя');
    const звук = fakeTrack('audio');
    const видео = fakeTrack('video');
    fakes.nostr.track(звук, {id: 'ч'}, 'петя');
    fakes.nostr.track(видео, {id: 'ч'}, 'петя');
    handlers.onPeerStream.mockClear();

    звук.end();

    expect(последний().getTracks()).toEqual([видео]);
  });

  it('ушедший собеседник уносит свой поток', () => {
    fakes.nostr.join('петя');
    fakes.nostr.track(fakeTrack('audio'), {id: 'ч'}, 'петя');
    fakes.nostr.leave('петя');
    handlers.onPeerStream.mockClear();

    fakes.nostr.join('петя');
    fakes.nostr.track(fakeTrack('video'), {id: 'ч2'}, 'петя');

    expect(последний().getTracks().map(t => t.kind)).toEqual(['video']);
  });
});

// Пересогласование случается на каждое включение микрофона или камеры, и
// каждый раз приезжает новая дорожка. Если складывать их все, в потоке
// копятся мёртвые, проигрыватель берёт первую из них — и вместо картинки
// человек видит пустоту. Ровно это и наблюдалось живьём.
describe('мёртвые дорожки не копятся', () => {
  let fakes;
  let handlers;

  beforeEach(() => {
    fakes = Object.fromEntries(FAMILY_NAMES.map(name => [name, createFakeRoom()]));
    const families = FAMILY_NAMES.map(family => ({
      family,
      join: () => fakes[family].room,
      getRelaySockets: () => fakes[family].sockets,
    }));
    handlers = {onPeerJoin: vi.fn(), onPeerStream: vi.fn(), onPeerLeave: vi.fn()};
    joinPublicChannels({roomId: 'r', password: 'p', handlers, families});
    fakes.nostr.join('петя');
  });

  const последний = () => handlers.onPeerStream.mock.calls.at(-1)[0];

  it('новая дорожка того же вида заменяет прежнюю', () => {
    const прежний = fakeTrack('audio');
    const новый = fakeTrack('audio');

    fakes.nostr.track(прежний, {}, 'петя');
    fakes.nostr.track(новый, {}, 'петя');

    expect(последний().getAudioTracks()).toEqual([новый]);
  });

  it('три круга включений оставляют ровно одну дорожку каждого вида', () => {
    for (let i = 0; i < 3; i++) {
      fakes.nostr.track(fakeTrack('audio'), {}, 'петя');
      fakes.nostr.track(fakeTrack('video'), {}, 'петя');
    }

    expect(последний().getTracks().map(t => t.kind)).toEqual(['audio', 'video']);
  });

  it('заглохшая дорожка остаётся в потоке, но объявляется заново', () => {
    const видео = fakeTrack('video');
    fakes.nostr.track(видео, {}, 'петя');
    handlers.onPeerStream.mockClear();

    видео.mute();

    expect(handlers.onPeerStream).toHaveBeenCalledTimes(1);
    expect(последний().getVideoTracks()).toEqual([видео]);
  });
});
