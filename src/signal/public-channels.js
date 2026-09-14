import {joinRoom as joinTorrent} from '@trystero-p2p/torrent';
import {joinRoom as joinNostr} from '@trystero-p2p/nostr';
import {joinRoom as joinMqtt} from '@trystero-p2p/mqtt';
import {createPeerRegistry} from './dedupe.js';
import {relayUrlsFor} from './relays.js';

export const APP_ID = 'sozvon';

const FAMILIES = [
  {family: 'torrent', join: joinTorrent},
  {family: 'nostr', join: joinNostr},
  {family: 'mqtt', join: joinMqtt},
];

export const joinPublicChannels = ({roomId, password, handlers}) => {
  const registry = createPeerRegistry();

  const channels = FAMILIES.map(({family, join}) => {
    const relays = relayUrlsFor(family);
    const room = join(
      {appId: APP_ID, password, relayConfig: {urls: relays}},
      roomId,
    );

    room.onPeerJoin = peerId => {
      if (registry.claim(peerId, family)) handlers.onPeerJoin?.(peerId);
    };
    room.onPeerLeave = peerId => {
      if (registry.release(peerId, family)) handlers.onPeerLeave?.(peerId);
    };
    room.onPeerStream = (stream, peerId) => {
      if (registry.ownerOf(peerId) === family) handlers.onPeerStream?.(stream, peerId);
    };

    return {family, relays, room};
  });

  // Медиа уходит во все комнаты: какая из них владеет участником, решает
  // registry, а лишние соединения остаются без дорожек.
  const everyRoom = fn => channels.map(({room}) => fn(room));

  return {
    addStream: stream => everyRoom(room => room.addStream(stream)),
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
      const actions = everyRoom(room => room.makeAction(namespace));
      return {
        send: data => Promise.all(actions.map(a => a.send(data))),
        set onMessage(fn) {
          for (const a of actions) a.onMessage = fn;
        },
      };
    },
    status: () => channels.map(({family, relays}) => ({family, relays})),
    leave: () => Promise.all(everyRoom(room => room.leave())),
  };
};
