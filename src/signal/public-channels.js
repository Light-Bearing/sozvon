import {joinRoom as joinTorrent, getRelaySockets as torrentSockets} from '@trystero-p2p/torrent';
import {joinRoom as joinNostr, getRelaySockets as nostrSockets} from '@trystero-p2p/nostr';
import {joinRoom as joinMqtt, getRelaySockets as mqttSockets} from '@trystero-p2p/mqtt';
import {createPeerRegistry} from './dedupe.js';
import {relayUrlsFor} from './relays.js';

export const APP_ID = 'sozvon';

// Числовое значение WebSocket.OPEN — берём его как литерал, а не через
// глобальный WebSocket, чтобы status() не зависел от окружения (в тестах
// глобального WebSocket может не быть вовсе).
const SOCKET_OPEN = 1;

const FAMILIES = [
  {family: 'torrent', join: joinTorrent, getRelaySockets: torrentSockets},
  {family: 'nostr', join: joinNostr, getRelaySockets: nostrSockets},
  {family: 'mqtt', join: joinMqtt, getRelaySockets: mqttSockets},
];

// families — необязательный параметр только для тестов: подсовывает
// поддельные {family, join} вместо трёх настоящих пакетов. Вызывающие из
// приложения его не передают и получают FAMILIES по умолчанию.
export const joinPublicChannels = ({roomId, password, handlers, families = FAMILIES}) => {
  const registry = createPeerRegistry();

  // Участники, чей поток уже пропущен наверх. Второй и далее поток от
  // того же участника отбрасываем — неважно, каким семейством он пришёл:
  // на приёме мы не привередничаем, откуда, лишь бы не повторялось.
  const streamedPeers = new Set();

  // Поток, который раздаёт приложение. Храним, чтобы отправить его и
  // новым участникам (при claim), и участнику, у которого сменился
  // владелец (см. «призрак» в onPeerLeave).
  let localStream = null;

  const channels = families.map(({family, join, getRelaySockets = () => ({})}) => {
    const relays = relayUrlsFor(family);
    const room = join(
      {appId: APP_ID, password, relayConfig: {urls: relays}},
      roomId,
    );

    room.onPeerJoin = peerId => {
      if (!registry.claim(peerId, family)) return;
      if (localStream) room.addStream(localStream, {target: peerId});
      handlers.onPeerJoin?.(peerId);
    };
    room.onPeerLeave = peerId => {
      if (!registry.release(peerId, family)) return;

      // Призрак: соединение владельца пропало, но другое семейство того
      // же участника ещё живо. Молча переносим владение туда — наверх об
      // уходе не сообщаем, а живой поток переотправляем по новому адресу.
      const ghost = channels.find(
        c => c.family !== family && Object.hasOwn(c.room.getPeers(), peerId),
      );
      if (ghost) {
        registry.claim(peerId, ghost.family);
        if (localStream) ghost.room.addStream(localStream, {target: peerId});
        streamedPeers.delete(peerId);
        return;
      }

      streamedPeers.delete(peerId);
      handlers.onPeerLeave?.(peerId);
    };
    room.onPeerStream = (stream, peerId) => {
      if (streamedPeers.has(peerId)) return;
      streamedPeers.add(peerId);
      handlers.onPeerStream?.(stream, peerId);
    };

    return {family, relays, room, getRelaySockets};
  });

  const roomOf = family => channels.find(c => c.family === family).room;

  // Эти две операции по-прежнему обходят все комнаты без разбора:
  // replaceTrack безопасно проходит мимо соединений без нужной дорожки
  // (peer.mjs ничего не делает, если трек не найден), а leave обязан
  // закрыть вообще все соединения, а не только соединение владельца.
  const everyRoom = fn => channels.map(({room}) => fn(room));

  return {
    // Раздаём каждому участнику только через комнату его владельца.
    // Лишние соединения (у остальных семейств) существуют, но дорожек не
    // получают — именно потому, что мы шлём адресно, а не потому что их
    // кто-то фильтрует на приёме.
    addStream: stream => {
      localStream = stream;
      for (const peerId of registry.peers()) {
        roomOf(registry.ownerOf(peerId)).addStream(stream, {target: peerId});
      }
    },
    replaceTrack: (oldTrack, newTrack) =>
      everyRoom(room => room.replaceTrack(oldTrack, newTrack)),
    getPeers: () =>
      Object.fromEntries(
        channels.flatMap(({family, room}) =>
          Object.entries(room.getPeers()).filter(
            ([peerId]) => registry.ownerOf(peerId) === family,
          ),
        ),
      ),
    action: namespace => {
      const actions = new Map(
        channels.map(({family, room}) => [family, room.makeAction(namespace)]),
      );
      return {
        // Адресуем и группируем по владельцу: каждому каналу — один вызов
        // send со списком его участников. Каналу, чьих участников сейчас
        // нет, не отправляем вообще ничего.
        send: data => {
          const targetsByOwner = new Map();
          for (const peerId of registry.peers()) {
            const owner = registry.ownerOf(peerId);
            if (!targetsByOwner.has(owner)) targetsByOwner.set(owner, []);
            targetsByOwner.get(owner).push(peerId);
          }
          return Promise.all(
            [...targetsByOwner].map(([family, targets]) =>
              actions.get(family).send(data, {target: targets}),
            ),
          );
        },
        // Фильтр не нужен: отправитель уже гарантировал единственность
        // сообщения, поэтому onMessage вешаем на все три семейства как
        // есть.
        set onMessage(fn) {
          for (const action of actions.values()) action.onMessage = fn;
        },
      };
    },
    // Живость семейства — по сокетам его собственных адресов из relays, а
    // не по одному только факту, что список адресов настроен: настроенный
    // адрес ничего не говорит о том, отвечает ли он сейчас. getRelaySockets()
    // библиотека отдаёт как {url: WebSocket} — считаем семейство живым, если
    // хоть один из НАШИХ адресов сейчас в состоянии OPEN.
    status: () =>
      channels.map(({family, relays, getRelaySockets}) => {
        const sockets = getRelaySockets();
        const aliveCount = relays.filter(url => sockets[url]?.readyState === SOCKET_OPEN).length;
        return {family, relays, aliveCount, alive: aliveCount > 0};
      }),
    leave: () => Promise.all(everyRoom(room => room.leave())),
  };
};
