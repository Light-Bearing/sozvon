// Состояние звонка: кто внутри, чьи потоки, какая ступень качества.
// Единственное место, где сходятся рукопожатие, камера и лестница.

import {createLadder, stepForPeers} from './ladder.js';
import {createMedia, setMaxBitrate} from './media.js';
import {connect} from './signal/index.js';
import {secretToLink} from './room-secret.js';
import {summarizeStats} from './stats.js';

const STATS_EVERY_MS = 2_000;

export const createRoom = async ({
  secret,
  onChange = () => {},
  connectFn = connect,
  media = createMedia(),
  ladder = createLadder(),
}) => {
  const peers = new Map();
  let step = stepForPeers(1);

  const state = () => ({
    link: secretToLink(secret),
    step,
    self: media.current(),
    peers: [...peers.entries()].map(([peerId, stream]) => ({peerId, stream})),
  });

  const announce = () => onChange(state());

  const stream = await media.start(step);

  const connection = await connectFn({
    secret,
    handlers: {
      onPeerJoin: peerId => {
        peers.set(peerId, null);
        announce();
      },
      onPeerLeave: peerId => {
        peers.delete(peerId);
        announce();
      },
      onPeerStream: (peerStream, peerId) => {
        peers.set(peerId, peerStream);
        announce();
      },
    },
  });

  connection.addStream(stream);
  announce();

  // Потолок битрейта — отдельно от смены ступени и без всяких условий:
  // проставляется всем текущим собеседникам на каждом пересчёте. Так он
  // доходит и при звонке вдвоём (где имя ступени не меняется никогда —
  // stepForPeers(1) и stepForPeers(2) обе дают 'full'), и до того, кто
  // подключился уже после последней настоящей смены ступени.
  const applyBitrateCeiling = async () => {
    for (const pc of Object.values(connection.getPeers())) {
      for (const sender of pc.getSenders()) {
        try {
          if (sender.track?.kind === 'video') await setMaxBitrate(sender, step.maxBitrate);
        } catch {
          // Соединение к этому собеседнику может закрываться — setParameters
          // выбросит InvalidStateError. Такого собеседника в этот такт пропускаем,
          // остальные получают потолок как обычно.
        }
      }
    }
  };

  const applyStep = async next => {
    const changed = next.name !== step.name;
    step = next;
    // Камеру перенастраиваем и экран перерисовываем только при настоящей
    // смене ступени — иначе на каждом такте (каждые 2 с) шло бы вхолостую.
    if (changed) await media.applyStep(step);
    await applyBitrateCeiling();
    if (changed) announce();
  };

  const tick = async () => {
    const reports = [];
    for (const pc of Object.values(connection.getPeers())) {
      try {
        (await pc.getStats()).forEach(report => reports.push(report));
      } catch {
        // Один собеседник в плохом состоянии не должен останавливать такт
        // для всех остальных — просто пропускаем его в этот раз.
      }
    }
    const {loss, queueSeconds} = summarizeStats(reports);
    await applyStep(ladder.update({peerCount: peers.size + 1, loss, queueSeconds}));
  };

  const timer = setInterval(() => void tick(), STATS_EVERY_MS);

  return {
    state,
    setMicrophone: on => media.setMicrophone(on),
    setCamera: on => media.setCamera(on),
    leave: async () => {
      clearInterval(timer);
      media.stop();
      await connection.leave();
    },
  };
};
