// Состояние звонка: кто внутри, чьи потоки, какая ступень качества.
// Единственное место, где сходятся рукопожатие, камера и лестница.

import {createLadder, stepForPeers} from './ladder.js';
import {createMedia, setMaxBitrate} from './media.js';
import {connect} from './signal/index.js';
import {secretToLink} from './room-secret.js';
import {createStatsTracker} from './stats.js';
import {createSpeakingTracker, levelFrom} from './speaking.js';
import {makeName, trimName} from './names.js';
import {createFlowTracker} from './flow.js';

const STATS_EVERY_MS = 2_000;

export const createRoom = async ({
  secret,
  onChange = () => {},
  connectFn = connect,
  media = createMedia(),
  ladder = createLadder(),
  families,
  name,
  turnConfig,
}) => {
  const peers = new Map();
  // Своё имя и имена собеседников. Своё — то, что дали снаружи (main.js
  // помнит его между звонками), либо смешное, придуманное на месте.
  let myName = trimName(name) ?? makeName();
  const names = new Map();
  let step = stepForPeers(1);

  // Намерение человека — и только человека: меняется исключительно из
  // setCamera()/setMicrophone() ниже, свежее на каждый новый звонок (это
  // локальные переменные createRoom, а не что-то живущее в main.js между
  // звонками). Единственная запись дорожек в media происходит в
  // applyDesiredMedia() — там же, где намерение сверяется со ступенью.
  // Раньше такт лестницы переписывал video.enabled сам, без оглядки на
  // то, что человек только что нажал «Камера», — через две секунды нажатие
  // тихо отменялось.
  //
  // Начинаются с false и остаются такими, пока человек сам не нажмёт
  // «Микрофон» или «Камеру»: при входе браузер ни о чём не спрашивает,
  // слушать и видеть остальных это не мешает — соединение поднимается без
  // исходящих дорожек и прекрасно принимает входящие.
  let cameraWanted = false;
  let microphoneWanted = false;

  // Каналы рукопожатия долго молчат. Это подсказка человеку, а не отказ:
  // звонок продолжает попытки, просто перестаёт делать вид, что всё идёт
  // как надо.
  let quiet = false;

  // Виды бед, о которых сообщили каналы: собеседник найден, а соединиться
  // с ним не вышло (см. src/signal/trouble.js). Хранятся без повторов и без
  // имён участников — экрану нужно назвать причину, а не перечислить, у кого
  // именно она случилась.
  let troubles = [];

  // Сколько сейчас идёт звука и картинки. «Дорожка есть» и «звук идёт» —
  // разные вещи, и со стороны их не различить; пусть различает приложение.
  const flowTracker = createFlowTracker();
  let flow = null;

  // Свой уровень звука — чтобы человек видел, слышит ли его собственный
  // компьютер. Без этого «меня не слышно» неотличимо от «микрофон не
  // работает», и проверить нечем.
  let level = 0;
  let lastStep = -1;

  // Кто говорит прямо сейчас — для подсветки плиток. Окно короче, чем у
  // ступени качества: глаз ждёт, что контур погаснет вскоре после слова,
  // а камере переключаться так часто нельзя.
  const SPEAKING_WINDOW_MS = 700;
  let speaking = [];

  const state = () => ({
    link: secretToLink(secret),
    quiet,
    troubles,
    flow,
    step,
    self: media.current(),
    mic: microphoneWanted,
    level,
    cam: cameraWanted,
    name: myName,
    speaking,
    devices: media.chosen?.() ?? {microphone: null, camera: null},
    peers: [...peers.entries()].map(([peerId, stream]) => ({
      peerId,
      stream,
      name: names.get(peerId) ?? null,
    })),
  });

  const announce = () => onChange(state());

  // Уровни приходят от всех по нескольку раз в секунду, но объявлять надо
  // только смену набора говорящих — иначе перерисовка станет постоянной.
  const refreshSpeaking = () => {
    const сейчас = tracker
      .speaking(SPEAKING_WINDOW_MS)
      .map(id => (id === SELF ? 'self' : id));
    const тот_же =
      сейчас.length === speaking.length && сейчас.every(id => speaking.includes(id));
    if (тот_же) return;
    speaking = сейчас;
    announce();
  };

  // Канал имён появится ниже, когда будет само подключение, — а нужен он
  // уже в обработчике onPeerJoin, который пишется выше него.
  let namesChannel = null;

  // Ничего не захватываем: вход в разговор молчаливый. connectFn() поднимет
  // соединение без единой исходящей дорожки — оно прекрасно принимает
  // входящее медиа и без своего. media.stop() в catch — подстраховка на
  // случай, если что-то всё же успеет захватиться до отказа; сейчас это
  // всегда безопасный no-op (см. «выключатели до захвата не падают» в
  // tests/media.test.js), но дешевле оставить симметрично с leave().
  let connection;
  try {
    connection = await connectFn({
      secret,
      families,
      turnConfig,
      onQuiet: isQuiet => {
        if (quiet === isQuiet) return;
        quiet = isQuiet;
        announce();
      },
      handlers: {
        onTrouble: list => {
          troubles = [...new Set(list.map(({kind}) => kind))];
          announce();
        },
        onPeerJoin: peerId => {
          peers.set(peerId, null);
          // Вошедший ещё не знает, как нас зовут: посылать имя при входе
          // должен тот, кто уже внутри, — сам новичок о нас не спросит.
          void namesChannel?.send(myName);
          announce();
        },
        onPeerLeave: peerId => {
          peers.delete(peerId);
          names.delete(peerId);
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

  announce();

  const tracker = createSpeakingTracker();
  // Набор говорящих гаснет сам по себе, без всяких событий: перестал
  // человек говорить — сообщений больше не приходит. Значит пересчитывать
  // надо по времени, а не по приходу.
  const speakingTimer = setInterval(refreshSpeaking, 300);
  // Своя метка в счётчике говорящих. Намеренно не selfId из библиотеки:
  // там идентификатор для сети, а здесь — просто «это я».
  const SELF = 'я';
  let listener = null;
  let audio = null;

  // action() связи бывает недоступен — например, в тестовом узловом
  // окружении vitest (без jsdom) его нет. Тогда просто не участвуем в
  // обмене уровнями: автоматика говорящего останется неактивной, но звонок
  // из-за необязательной части падать не должен. Приём чужого уровня не
  // зависит от того, включил ли человек уже свой микрофон, — слушаем канал
  // сразу, с самого начала звонка.
  const levels = typeof connection.action === 'function' ? connection.action('level') : null;
  // Вторым аргументом приходит объект с полем peerId, а не сам идентификатор.
  if (levels) {
    levels.onMessage = (value, {peerId}) => {
      tracker.report(peerId, value);
      refreshSpeaking();
    };
  }

  namesChannel = typeof connection.action === 'function' ? connection.action('name') : null;
  if (namesChannel) {
    namesChannel.onMessage = (raw, {peerId}) => {
      // Имя приходит от собеседника, поэтому чистится ровно так же, как
      // своё: и в разметку оно попадает только текстом (см. src/ui/call.js).
      const next = trimName(raw);
      if (!next || names.get(peerId) === next) return;
      names.set(peerId, next);
      announce();
    };
  }

  // А вот измерение и рассылка СВОЕГО уровня возможны, только когда есть
  // живая дорожка микрофона, — включает их startMicrophone() ниже, а не
  // здесь: раньше AudioContext заводился безусловно при старте звонка,
  // потому что и микрофон захватывался безусловно. Теперь оба — по решению
  // человека, и вместе.
  const startLevelMeter = async micStream => {
    if (audio || !levels || typeof AudioContext === 'undefined') return;
    audio = new AudioContext();
    // Создаётся после await'ов внутри захвата — то есть вне жеста
    // человека, а по правилам браузеров такой AudioContext может родиться
    // приостановленным. Тогда анализатор молча читает нули,
    // tracker.report(SELF, …) не срабатывает, и на ступени «видео у
    // говорящего» камера этого человека будет выключена весь звонок — и
    // никто не скажет почему.
    if (audio.state === 'suspended') await audio.resume();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    audio.createMediaStreamSource(micStream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    const listen = () => {
      analyser.getFloatTimeDomainData(samples);
      const измерено = levelFrom(samples);
      tracker.report(SELF, измерено);
      void levels.send(измерено);
      // Объявляем только заметные изменения: глазу хватает два десятка
      // ступеней, а перерисовка ради неразличимой цифры не нужна никому.
      const ступень = Math.round(Math.min(1, Math.sqrt(измерено) * 2.2) * 20);
      if (ступень === lastStep) return;
      lastStep = ступень;
      level = измерено;
      announce();
      refreshSpeaking();
    };
    listener = setInterval(listen, 300);
  };

  // Выключение микрофона гасит и измерение — иначе анализатор слушает уже
  // остановленную дорожку и вместо честной тишины просто ничего не скажет
  // о том, что перестал работать.
  const stopLevelMeter = () => {
    clearInterval(listener);
    listener = null;
    // Микрофон выключен — полоска обязана погаснуть, а не замереть на
    // последнем значении.
    level = 0;
    lastStep = -1;
    void audio?.close();
    audio = null;
  };

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

  // Захват по требованию — реакция на явное нажатие человека, а не на такт
  // лестницы (тот лишь гасит/зажигает уже имеющуюся дорожку через
  // applyDesiredMedia() выше, каждые STATS_EVERY_MS; звать отсюда
  // getUserMedia нельзя — при ступени 'speaker' смена говорящего дёргала бы
  // устройство по нескольку раз в минуту). Захваченная дорожка рассылается
  // адресно, как и остальное медиа в этом файле, — решает отправитель.
  //
  // capturing-флаги защищают от второго клика, пока браузер ещё спрашивает
  // разрешение на первый: там же, где уже однажды было «трое писателей у
  // одной дорожки», второй параллельный getUserMedia — тот же риск заново.
  let microphoneCapturing = false;
  let cameraCapturing = false;

  const startMicrophone = async () => {
    if (microphoneCapturing) return;
    microphoneCapturing = true;
    try {
      const track = await media.captureMicrophone(step);
      if (!microphoneWanted) {
        // Человек успел выключить микрофон, пока браузер спрашивал
        // разрешение, — не держим устройство ради намерения, которого уже
        // нет (иначе кнопка «выключено», а огонёк горит).
        if (track) media.releaseMicrophone();
        return;
      }
      if (track) connection.addTrack(track, media.current());
      await startLevelMeter(media.current());
    } catch {
      // Браузер не пустил (или устройство недоступно) — звонок
      // продолжается, кнопка честно возвращается в «выключено».
      microphoneWanted = false;
    } finally {
      microphoneCapturing = false;
      applyDesiredMedia();
      announce();
    }
  };

  const stopMicrophone = () => {
    for (const track of media.releaseMicrophone()) connection.removeTrack(track);
    stopLevelMeter();
  };

  const startCamera = async () => {
    if (cameraCapturing) return;
    cameraCapturing = true;
    try {
      const track = await media.captureCamera(step);
      if (!cameraWanted) {
        if (track) media.releaseCamera();
        return;
      }
      if (track) connection.addTrack(track, media.current());
    } catch {
      cameraWanted = false;
    } finally {
      cameraCapturing = false;
      applyDesiredMedia();
      announce();
    }
  };

  const stopCamera = () => {
    for (const track of media.releaseCamera()) connection.removeTrack(track);
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
    flow = flowTracker.update(peerReports) ?? flow;
    const {loss, queueSeconds} = stats.summarize(peerReports);
    await applyStep(ladder.update({peerCount: peers.size + 1, loss, queueSeconds}));
  };

  const timer = setInterval(() => void tick(), STATS_EVERY_MS);

  return {
    state,
    // Единственное место, где cameraWanted/microphoneWanted меняются. Сразу
    // же применяем к дорожкам и объявляем новое состояние — человек должен
    // увидеть эффект нажатия немедленно, а не ждать ни ближайшего такта
    // лестницы, ни того, пока браузер спросит разрешение на захват.
    // Возвращают промис захвата (undefined при выключении, там снимать
    // нечего) — им пользуются тесты, чтобы дождаться итога, не гоняя
    // таймеры; кнопке в src/ui/call.js возвращаемое значение не нужно.
    setMicrophone: on => {
      microphoneWanted = on;
      if (!on) stopMicrophone();
      applyDesiredMedia();
      announce();
      return on ? startMicrophone() : undefined;
    },
    setCamera: on => {
      cameraWanted = on;
      if (!on) stopCamera();
      applyDesiredMedia();
      announce();
      return on ? startCamera() : undefined;
    },
    // Имя можно менять не выходя из звонка. Пустым оно не бывает: имя, под
    // которым человек согласился остаться, выбирает вызывающий (main.js
    // держит для этого подсказку на весь сеанс), а makeName здесь — только
    // страховка на случай, если не передали вообще ничего.
    setName: next => {
      const clean = trimName(next) ?? makeName();
      if (clean === myName) return myName;
      myName = clean;
      void namesChannel?.send(myName);
      announce();
      return myName;
    },

    // Выбор устройства в настройках. Пока захвата нет, выбор просто
    // запоминается (media.useMicrophone вернёт null) — и сработает, когда
    // человек включит микрофон или камеру.
    setMicrophoneDevice: async deviceId => {
      const swap = await media.useMicrophone(deviceId, step);
      if (swap) {
        connection.replaceTrack(swap.old, swap.next);
        // Анализатор уровня слушал остановленную дорожку — без этого
        // собеседники перестали бы видеть, что человек говорит.
        stopLevelMeter();
        await startLevelMeter(media.current());
      }
      applyDesiredMedia();
      announce();
    },

    setCameraDevice: async deviceId => {
      const swap = await media.useCamera(deviceId, step);
      if (swap) connection.replaceTrack(swap.old, swap.next);
      applyDesiredMedia();
      announce();
    },

    leave: async () => {
      clearInterval(timer);
      clearInterval(speakingTimer);
      stopLevelMeter();
      media.stop();
      await connection.leave();
    },
  };
};
