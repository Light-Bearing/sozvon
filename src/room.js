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

  const applyStep = async next => {
    if (next.name === step.name) return;
    step = next;
    await media.applyStep(step);
    for (const pc of Object.values(connection.getPeers())) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === 'video') await setMaxBitrate(sender, step.maxBitrate);
      }
    }
    announce();
  };

  const tick = async () => {
    const reports = [];
    for (const pc of Object.values(connection.getPeers())) {
      (await pc.getStats()).forEach(report => reports.push(report));
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
