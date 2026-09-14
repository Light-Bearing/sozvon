import {beforeEach, describe, expect, it, vi} from 'vitest';
import {joinPublicChannels} from '../src/signal/public-channels.js';

const FAMILY_NAMES = ['torrent', 'nostr', 'mqtt'];

// Поддельная комната вместо настоящего joinRoom из трёх пакетов trystero.
// Даёт ровно то, чем пользуется public-channels.js (onPeerJoin/onPeerLeave/
// onPeerStream, getPeers, addStream, replaceTrack, makeAction, leave) плюс
// тестовые хуки join/leave/stream для имитации событий библиотеки — саму
// библиотеку в тестах не открываем (живая проверка — задача 7).
const createFakeRoom = () => {
  const peers = new Map();
  const addStreamCalls = [];
  const actionsByNamespace = new Map();

  const room = {
    onPeerJoin: null,
    onPeerLeave: null,
    onPeerStream: null,
    getPeers: () => Object.fromEntries(peers),
    addStream: (stream, options = {}) =>
      addStreamCalls.push({stream, target: options.target}),
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
});
