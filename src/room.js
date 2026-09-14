// Состояние звонка: кто внутри, чьи потоки, какая ступень качества.
// Единственное место, где сходятся рукопожатие, камера и лестница.

import {createLadder, stepForPeers} from './ladder.js';
import {createMedia, setMaxBitrate} from './media.js';
import {connect} from './signal/index.js';
import {secretToLink} from './room-secret.js';
import {summarizeStats} from './stats.js';
import {createSpeakingTracker, levelFrom} from './speaking.js';

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

  const tracker = createSpeakingTracker();
  // Своя метка в счётчике говорящих. Намеренно не selfId из библиотеки:
  // там идентификатор для сети, а здесь — просто «это я».
  const SELF = 'я';
  let listener = null;
  let audio = null;

  // action() связи и AudioContext бывают недоступны — например, в тестовом
  // узловом окружении vitest (без jsdom) нет ни того, ни другого. Тогда
  // просто не измеряем и не рассылаем уровень звука: автоматика говорящего
  // останется неактивной, но звонок из-за необязательной части падать
  // не должен.
  if (typeof connection.action === 'function' && typeof AudioContext !== 'undefined') {
    const levels = connection.action('level');
    // Вторым аргументом приходит объект с полем peerId, а не сам идентификатор.
    levels.onMessage = (level, {peerId}) => tracker.report(peerId, level);

    // Свой уровень звука меряем локально и рассылаем остальным.
    audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    const listen = () => {
      analyser.getFloatTimeDomainData(samples);
      const level = levelFrom(samples);
      tracker.report(SELF, level);
      void levels.send(level);
    };
    listener = setInterval(listen, 300);
  }

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
    // На ступени «видео у говорящего» картинку шлёт только тот, кто говорит.
    // Вне проверки на смену ступени намеренно: говорящий меняется часто,
    // а ступень — редко. Внутри `if (changed)` решение пересматривалось бы
    // раз в несколько минут вместо каждого такта, и камера не успевала бы
    // за разговором.
    if (step.videoFor === 'speaker') media.setCamera(tracker.speaker() === SELF);
    else if (step.videoFor === 'all') media.setCamera(true);
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
      clearInterval(listener);
      void audio?.close();
      media.stop();
      await connection.leave();
    },
  };
};
