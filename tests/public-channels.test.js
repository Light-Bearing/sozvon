import {beforeEach, describe, expect, it, vi} from 'vitest';
import {familiesFor, joinPublicChannels, parseFamilyNames} from '../src/signal/public-channels.js';
import {relayUrlsFor} from '../src/signal/relays.js';

const FAMILY_NAMES = ['torrent', 'nostr', 'mqtt'];

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
      join: () => fakes[family].room,
      // Читает fakes[family].sockets заново при каждом вызове — тест может
      // поменять его после того, как connection уже создан.
      getRelaySockets: () => fakes[family].sockets,
    }));
    handlers = {
      onPeerJoin: vi.fn(),
      onPeerLeave: vi.fn(),
      onPeerStream: vi.fn(),
    };
    connection = joinPublicChannels({roomId: 'r', password: 'p', handlers, families});
  });

  describe('addStream', () => {
    it('участник, известный двум семействам, получает поток один раз — в комнате владельца', () => {
      fakes.torrent.join('петя');
      fakes.nostr.join('петя');
      const stream = {id: 'stream-1'};

      connection.addStream(stream);

      expect(fakes.torrent.addStreamCalls).toEqual([{stream, target: 'петя'}]);
      expect(fakes.nostr.addStreamCalls).toEqual([]);
      expect(fakes.mqtt.addStreamCalls).toEqual([]);
    });

    it('поток, добавленный заранее, доразмечается новому участнику в комнате владельца', () => {
      const stream = {id: 'stream-1'};

      connection.addStream(stream);
      fakes.torrent.join('петя');
      fakes.nostr.join('петя');

      expect(fakes.torrent.addStreamCalls).toEqual([{stream, target: 'петя'}]);
      expect(fakes.nostr.addStreamCalls).toEqual([]);
    });
  });

  // Включение микрофона/камеры человеком после входа — addTrack()/
  // removeTrack() следуют тому же правилу «решает отправитель», что и
  // addStream() выше: своё медиа уходит адресно, только через канал
  // владельца, никогда широковещательно.
  describe('addTrack и removeTrack', () => {
    it('дорожка уходит только владельцу, адресно', () => {
      fakes.torrent.join('петя');
      fakes.nostr.join('петя');
      const track = {id: 'track-1'};
      const stream = {id: 'stream-1'};

      connection.addTrack(track, stream);

      expect(fakes.torrent.addTrackCalls).toEqual([{track, stream, target: 'петя'}]);
      expect(fakes.nostr.addTrackCalls).toEqual([]);
      expect(fakes.mqtt.addTrackCalls).toEqual([]);
    });

    it('несколько участников из разных семейств — каждому своя адресная дорожка', () => {
      fakes.torrent.join('аня');
      fakes.nostr.join('боря');
      const track = {id: 'track-1'};
      const stream = {id: 'stream-1'};

      connection.addTrack(track, stream);

      expect(fakes.torrent.addTrackCalls).toEqual([{track, stream, target: 'аня'}]);
      expect(fakes.nostr.addTrackCalls).toEqual([{track, stream, target: 'боря'}]);
    });

    it('дорожка, добавленная заранее, доразмечается новому участнику вместе с остальным потоком', () => {
      const track = {id: 'track-1'};
      const stream = {id: 'stream-1'};

      connection.addTrack(track, stream);
      fakes.torrent.join('петя');
      fakes.nostr.join('петя');

      // Как и у addStream() выше: localStream досылается новому участнику
      // целиком через onPeerJoin() — отдельного addTrackCalls «задним
      // числом» для позже подключившихся нет и не нужно.
      expect(fakes.torrent.addStreamCalls).toEqual([{stream, target: 'петя'}]);
      expect(fakes.nostr.addStreamCalls).toEqual([]);
    });

    it('removeTrack снимает дорожку только у владельца, тоже адресно', () => {
      fakes.torrent.join('петя');
      fakes.nostr.join('петя');
      const track = {id: 'track-1'};

      connection.removeTrack(track);

      expect(fakes.torrent.removeTrackCalls).toEqual([{track, target: 'петя'}]);
      expect(fakes.nostr.removeTrackCalls).toEqual([]);
      expect(fakes.mqtt.removeTrackCalls).toEqual([]);
    });
  });

  describe('action(namespace).send', () => {
    it('уходит адресно и сгруппировано по владельцу, а каналу без участников — ничего', async () => {
      fakes.torrent.join('аня');
      fakes.torrent.join('боря');
      fakes.nostr.join('вера');

      await connection.action('chat').send({text: 'привет'});

      expect(fakes.torrent.action('chat').calls).toEqual([
        {data: {text: 'привет'}, target: ['аня', 'боря']},
      ]);
      expect(fakes.nostr.action('chat').calls).toEqual([
        {data: {text: 'привет'}, target: ['вера']},
      ]);
      expect(fakes.mqtt.action('chat').calls).toEqual([]);
    });
  });

  describe('onPeerStream', () => {
    it('второй поток от уже принятого участника наверх не проходит', () => {
      fakes.torrent.join('петя');
      const stream1 = {id: 's1'};
      const stream2 = {id: 's2'};

      fakes.torrent.stream(stream1, 'петя');
      fakes.torrent.stream(stream2, 'петя');

      expect(handlers.onPeerStream).toHaveBeenCalledTimes(1);
      expect(handlers.onPeerStream).toHaveBeenCalledWith(stream1, 'петя');
    });

    it('принимается от любого семейства, не только от владельца', () => {
      fakes.torrent.join('петя');
      fakes.nostr.join('петя');
      const stream = {id: 's1'};

      fakes.nostr.stream(stream, 'петя');

      expect(handlers.onPeerStream).toHaveBeenCalledTimes(1);
      expect(handlers.onPeerStream).toHaveBeenCalledWith(stream, 'петя');
    });
  });

  describe('призрак', () => {
    it('ушёл владелец, но соседнее семейство ещё видит участника — наверх не сообщаем, участник остаётся в getPeers()', () => {
      fakes.torrent.join('петя');
      fakes.nostr.join('петя');

      fakes.torrent.leave('петя');

      expect(handlers.onPeerLeave).not.toHaveBeenCalled();
      expect(connection.getPeers()).toHaveProperty('петя');
    });

    it('живой поток переотправляется адресно в комнату нового владельца', () => {
      const stream = {id: 's1'};
      connection.addStream(stream);
      fakes.torrent.join('петя');
      fakes.nostr.join('петя');

      fakes.torrent.leave('петя');

      expect(fakes.nostr.addStreamCalls).toEqual([{stream, target: 'петя'}]);
    });

    it('ушёл последний — вот тогда сообщаем об уходе', () => {
      fakes.torrent.join('петя');
      fakes.nostr.join('петя');
      fakes.torrent.leave('петя');

      expect(handlers.onPeerLeave).not.toHaveBeenCalled(); // после первого ухода — тишина

      fakes.nostr.leave('петя');

      expect(handlers.onPeerLeave).toHaveBeenCalledTimes(1);
      expect(handlers.onPeerLeave).toHaveBeenCalledWith('петя');
      expect(connection.getPeers()).not.toHaveProperty('петя');
    });
  });

  describe('переподключение участника', () => {
    it('участник полностью ушёл, вернулся в той же сессии — его новый поток доходит наверх', () => {
      const stream1 = {id: 's1'};
      const stream2 = {id: 's2'};

      fakes.torrent.join('петя');
      fakes.torrent.stream(stream1, 'петя');
      expect(handlers.onPeerStream).toHaveBeenCalledTimes(1);
      expect(handlers.onPeerStream).toHaveBeenCalledWith(stream1, 'петя');

      handlers.onPeerStream.mockClear();
      fakes.torrent.leave('петя');
      expect(handlers.onPeerLeave).toHaveBeenCalledTimes(1);
      expect(handlers.onPeerLeave).toHaveBeenCalledWith('петя');

      fakes.torrent.join('петя');
      fakes.torrent.stream(stream2, 'петя');

      expect(handlers.onPeerStream).toHaveBeenCalledTimes(1);
      expect(handlers.onPeerStream).toHaveBeenCalledWith(stream2, 'петя');
    });
  });

  // Находка 5: раньше status() просто отдавал настроенный список адресов —
  // он ничего не говорил о том, жив ли канал прямо сейчас, и его никто не
  // читал. Теперь он честно смотрит на readyState сокетов из getRelaySockets().
  describe('status(): какие каналы живы прямо сейчас', () => {
    it('семейство без единого открытого сокета живым не считается', () => {
      const torrent = connection.status().find(c => c.family === 'torrent');
      expect(torrent.alive).toBe(false);
      expect(torrent.aliveCount).toBe(0);
    });

    it('семейство с открытым (readyState: OPEN) сокетом на своём адресе считается живым', () => {
      const url = relayUrlsFor('torrent')[0];
      fakes.torrent.sockets = {[url]: {readyState: 1}};

      const torrent = connection.status().find(c => c.family === 'torrent');
      expect(torrent.alive).toBe(true);
      expect(torrent.aliveCount).toBe(1);

      // Соседние семейства эта правка не задевает.
      expect(connection.status().find(c => c.family === 'nostr').alive).toBe(false);
    });

    it('сокет ещё подключается (readyState CONNECTING, не OPEN) — живым не считается', () => {
      const url = relayUrlsFor('torrent')[0];
      fakes.torrent.sockets = {[url]: {readyState: 0}};

      expect(connection.status().find(c => c.family === 'torrent').alive).toBe(false);
    });

    it('relays в ответе — это адреса именно этого семейства, из relayUrlsFor', () => {
      const torrent = connection.status().find(c => c.family === 'torrent');
      expect(torrent.relays).toEqual(relayUrlsFor('torrent'));
    });
  });
});

// Переключатель семейств для диагностики: ?каналы=nostr или
// ?каналы=torrent,mqtt в адресе страницы (см. main.js). Разбор строки и
// отбор по имени — чистые функции, без браузера и без trystero.
describe('parseFamilyNames', () => {
  it('одно имя', () => {
    expect(parseFamilyNames('nostr')).toEqual(['nostr']);
  });

  it('несколько имён через запятую, с пробелами', () => {
    expect(parseFamilyNames('torrent, mqtt')).toEqual(['torrent', 'mqtt']);
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
  const ALL = [{family: 'torrent'}, {family: 'nostr'}, {family: 'mqtt'}];

  it('без имён — все семейства, как всегда', () => {
    expect(familiesFor([], ALL)).toBe(ALL);
  });

  it('с именем — только совпавшие', () => {
    expect(familiesFor(['nostr'], ALL)).toEqual([{family: 'nostr'}]);
  });

  it('несколько имён — сохраняют исходный порядок списка семейств, а не порядок в параметре', () => {
    expect(familiesFor(['mqtt', 'torrent'], ALL)).toEqual([{family: 'torrent'}, {family: 'mqtt'}]);
  });

  it('неизвестное имя молча отсеивается — это инструмент для своего эксперимента, не форма с проверкой', () => {
    expect(familiesFor(['nostr', 'неведомое'], ALL)).toEqual([{family: 'nostr'}]);
  });

  it('все имена неизвестны — пустой список семейств, а не полный набор по умолчанию', () => {
    expect(familiesFor(['неведомое'], ALL)).toEqual([]);
  });
});
