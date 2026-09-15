// Состояние звонка: кто внутри, чьи потоки, какая ступень качества.
// Единственное место, где сходятся рукопожатие, камера и лестница.

import {createLadder, stepForPeers} from './ladder.js';
import {createMedia, setMaxBitrate} from './media.js';
import {connect} from './signal/index.js';
import {secretToLink} from './room-secret.js';
import {createStatsTracker} from './stats.js';
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

  // Намерение человека — и только человека: меняется исключительно из
  // setCamera()/setMicrophone() ниже, свежее на каждый новый звонок (это
  // локальные переменные createRoom, а не что-то живущее в main.js между
  // звонками). Единственная запись дорожек в media происходит в
  // applyDesiredMedia() — там же, где намерение сверяется со ступенью.
  // Раньше такт лестницы переписывал video.enabled сам, без оглядки на
  // то, что человек только что нажал «Камера», — через две секунды нажатие
  // тихо отменялось.
  let cameraWanted = true;
  let microphoneWanted = true;

  // Каналы рукопожатия долго молчат. Это подсказка человеку, а не отказ:
  // звонок продолжает попытки, просто перестаёт делать вид, что всё идёт
  // как надо.
  let quiet = false;

  const state = () => ({
    link: secretToLink(secret),
    quiet,
    step,
    self: media.current(),
    mic: microphoneWanted,
    cam: cameraWanted,
    peers: [...peers.entries()].map(([peerId, stream]) => ({peerId, stream})),
  });

  const announce = () => onChange(state());

  const stream = await media.start(step);

  // Камера и микрофон захвачены уже здесь, а подключение может не
  // состояться по другой причине. Если connectFn() отклонился, поток
  // надо погасить: media.stop() живёт только в leave(), а до leave()
  // дело не дойдёт — человек увидит экран неудачи, а лампочка камеры
  // будет гореть до закрытия вкладки.
  let connection;
  try {
    connection = await connectFn({
      secret,
      onQuiet: isQuiet => {
        if (quiet === isQuiet) return;
        quiet = isQuiet;
        announce();
      },
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
  } catch (error) {
    media.stop();
    throw error;
  }

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
    // Создаётся уже после await'ов выше — то есть вне жеста человека, а по
    // правилам браузеров такой AudioContext может родиться приостановленным.
    // Тогда анализатор молча читает нули, tracker.report(SELF, …) не
    // срабатывает, и на ступени «видео у говорящего» камера этого человека
    // будет выключена весь звонок — и никто не скажет почему.
    if (audio.state === 'suspended') await audio.resume();
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

  // Разрешает ли текущая ступень видео от ЭТОГО человека — без оглядки на
  // то, хочет ли он сам его показывать. 'all' — разрешает всем, 'speaker' —
  // только тому, кто сейчас говорит, 'none' (ступень 'voice') — никому и
  // никогда. Раньше эту ветку никто не обрабатывал вовсе, и камера на
  // 'voice' оставалась в том состоянии, в каком была до перехода.
  const cameraAllowed = () => {
    if (step.videoFor === 'all') return true;
    if (step.videoFor === 'speaker') return tracker.speaker() === SELF;
    return false;
  };

  // Единственное место, где решается, что в итоге происходит с камерой и
  // микрофоном. Раньше запись в media.setCamera() была рассыпана по
  // нескольким местам (кнопка человека, лестница качества, определение
  // говорящего) — писали трое, и итог зависел от того, кто писал последним.
  // Теперь пишет только эта функция, и итог всегда один и тот же расчёт:
  // микрофон — как хочет человек (ступень его не ограничивает, звук всегда
  // всем); камера — как хочет человек, и только если ступень это позволяет.
  const applyDesiredMedia = () => {
    media.setMicrophone(microphoneWanted);
    media.setCamera(cameraWanted && cameraAllowed());
  };

  const applyStep = async next => {
    const changed = next.name !== step.name;
    step = next;
    // Разрешение по ступени (ширина/высота) перенастраиваем и экран
    // перерисовываем только при настоящей смене ступени — иначе на каждом
    // такте (каждые 2 с) шло бы вхолостую.
    if (changed) await media.applyStep(step);
    await applyBitrateCeiling();
    // А вот итог по камере/микрофону пересчитываем каждый такт безусловно:
    // говорящий на ступени 'speaker' меняется часто, а ступень — редко.
    // Внутри `if (changed)` решение пересматривалось бы раз в несколько
    // минут вместо каждого такта, и камера не успевала бы за разговором.
    applyDesiredMedia();
    if (changed) announce();
  };

  // Живёт всё время звонка — приращение между тактами считается от
  // прошлого снимка этого же трекера, а не с нуля на каждый такт.
  const stats = createStatsTracker();

  const tick = async () => {
    // Группируем по собеседнику, а не сваливаем в один список: report.id
    // устойчив только внутри одного соединения и у разных собеседников
    // свободно совпадает — createStatsTracker в src/stats.js ключует
    // снимки парой (собеседник, report.id) именно поэтому.
    const peerReports = [];
    for (const [peerId, pc] of Object.entries(connection.getPeers())) {
      try {
        const reports = [];
        (await pc.getStats()).forEach(report => reports.push(report));
        peerReports.push({peerId, reports});
      } catch {
        // Один собеседник в плохом состоянии не должен останавливать такт
        // для всех остальных — просто пропускаем его в этот раз. Раз его не
        // было в этот такт, трекер сам забудет его прошлые снимки (см.
        // src/stats.js) — досчитывать через пропуск не придётся.
      }
    }
    const {loss, queueSeconds} = stats.summarize(peerReports);
    await applyStep(ladder.update({peerCount: peers.size + 1, loss, queueSeconds}));
  };

  const timer = setInterval(() => void tick(), STATS_EVERY_MS);

  return {
    state,
    // Единственное место, где cameraWanted/microphoneWanted меняются. Сразу
    // же применяем к дорожкам и объявляем новое состояние — человек должен
    // увидеть эффект нажатия немедленно, а не ждать ближайшего такта лестницы.
    setMicrophone: on => {
      microphoneWanted = on;
      applyDesiredMedia();
      announce();
    },
    setCamera: on => {
      cameraWanted = on;
      applyDesiredMedia();
      announce();
    },
    leave: async () => {
      clearInterval(timer);
      clearInterval(listener);
      void audio?.close();
      media.stop();
      await connection.leave();
    },
  };
};
