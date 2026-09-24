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
import {createChatLog, isReaction, trimText} from './chat.js';
import {reviveOnDrop} from './revive.js';

const STATS_EVERY_MS = 2_000;

export const createRoom = async ({
  secret,
  onChange = () => {},
  connectFn = connect,
  media = createMedia(),
  ladder = createLadder(),
  families,
  name,
  // Пропуск к ретранслятору для приглашения (см. src/turn.js). Сам
  // ретранслятор соединениям раздаёт src/rtc.js, комната о нём не знает —
  // ей нужно лишь положить пропуск в ссылку.
  pass = null,
}) => {
  const peers = new Map();
  // Экраны собеседников — отдельно от лиц: это две разные картинки, и
  // показываются они двумя плитками.
  const screens = new Map();
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

  // Показ экрана. Отдельное намерение, а не разновидность камеры: человек
  // может показывать экран с выключенной камерой и наоборот.
  let screenWanted = false;

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
    link: secretToLink(secret, undefined, pass),
    quiet,
    troubles,
    flow,
    step,
    self: media.current(),
    mic: microphoneWanted,
    screen: screenWanted,
    canShareScreen: media.canShareScreen?.() ?? false,
    level,
    cam: cameraWanted,
    name: myName,
    speaking,
    messages: chat.all(),
    unread,
    reactions: new Map(reactions),
    devices: media.chosen?.() ?? {microphone: null, camera: null},
    peers: [...peers.entries()].map(([peerId, stream]) => ({
      peerId,
      stream,
      screen: screens.get(peerId) ?? null,
      name: names.get(peerId) ?? null,
      mic: peerMedia.get(peerId)?.mic ?? null,
      cam: peerMedia.get(peerId)?.cam ?? null,
    })),
    // Свой экран — чтобы человек видел, что именно показывает.
    selfScreen: media.screen?.() ?? null,
  });

  const announce = () => onChange(state());

  // Уровни приходят от всех по нескольку раз в секунду, но объявлять надо
  // только смену набора говорящих — иначе перерисовка станет постоянной.
  const refreshSpeaking = () => {
    const heard = tracker
      .speaking(SPEAKING_WINDOW_MS)
      .map(id => (id === SELF ? 'self' : id));
    const same =
      heard.length === speaking.length && heard.every(id => speaking.includes(id));
    if (same) return;
    speaking = heard;
    announce();
  };

  // Канал имён появится ниже, когда будет само подключение, — а нужен он
  // уже в обработчике onPeerJoin, который пишется выше него.
  let namesChannel = null;
  let chatChannel = null;
  let screensChannel = null;
  let mediaChannel = null;

  // Что у собеседника с микрофоном и камерой. Выводить это из дорожек
  // нельзя: выключенная дорожка приходит живой и просто молчит, и «он
  // выключил микрофон» выглядит точно так же, как «связь не встала». В
  // разговоре на пятерых это и есть главный вопрос — что именно сломалось.
  //
  // Пока собеседник не сказал о себе, не знаем: null, а не false. Соврать
  // «у него выключен микрофон» хуже, чем промолчать.
  const peerMedia = new Map();

  // Переписка. Живёт столько же, сколько соединение: канал данных требует
  // того же, что и звук. Зато когда связь есть, написать можно всегда.
  const chat = createChatLog();
  // Сколько сообщений пришло, пока панель переписки была закрыта.
  let unread = 0;

  // Реакции живут секунды: это жест, а не запись. Держим последнюю от
  // каждого и гасим по таймеру. Ключ — тот же, каким зовётся плитка:
  // 'self' для себя, идентификатор собеседника для остальных.
  const REACTION_MS = 4000;
  const reactions = new Map();
  const fading = new Map();

  const flash = (id, emoji) => {
    clearTimeout(fading.get(id));
    reactions.set(id, {emoji, at: Date.now()});
    fading.set(
      id,
      setTimeout(() => {
        fading.delete(id);
        reactions.delete(id);
        announce();
      }, REACTION_MS),
    );
  };

  const forgetReaction = id => {
    clearTimeout(fading.get(id));
    fading.delete(id);
    reactions.delete(id);
  };

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
      onQuiet: isQuiet => {
        if (quiet === isQuiet) return;
        quiet = isQuiet;
        announce();
      },
      handlers: {
        onTrouble: list => {
          // Раньше здесь оставались только виды бед, а с кем именно не
          // вышло — терялось. В разговоре на пятерых это и подвело: двое
          // не видели друг друга, а экран говорил ровно то же, что сказал
          // бы при одном недостижимом собеседнике.
          troubles = list.map(({peerId, kind}) => ({peerId, kind}));
          announce();
        },
        onPeerJoin: peerId => {
          peers.set(peerId, null);
          // Вошедший ещё не знает, как нас зовут: посылать имя при входе
          // должен тот, кто уже внутри, — сам новичок о нас не спросит.
          void namesChannel?.send(myName);
          // Показ мог идти ещё до его прихода — иначе он увидит дорожку,
          // но не будет знать, что это экран, а не забытая плитка.
          void screensChannel?.send(screenWanted);
          void mediaChannel?.send({mic: microphoneWanted, cam: cameraWanted});
          announce();
        },
        onPeerLeave: peerId => {
          peers.delete(peerId);
          screens.delete(peerId);
          names.delete(peerId);
          peerMedia.delete(peerId);
          forgetReaction(peerId);
          announce();
        },
        onPeerStream: (peerStream, peerId, role = 'camera') => {
          // У камеры и экрана правила разные, и это не небрежность.
          // Собеседник без картинки в разговоре остаётся — плитка темнеет,
          // но живёт. А плитка экрана существует только ради самого
          // экрана: нет дорожки — нечего и показывать.
          if (role === 'screen') {
            if (peerStream.getVideoTracks().length > 0) screens.set(peerId, peerStream);
            else screens.delete(peerId);
          } else {
            peers.set(peerId, peerStream);
          }
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

  chatChannel = typeof connection.action === 'function' ? connection.action('chat') : null;
  if (chatChannel) {
    chatChannel.onMessage = (raw, {peerId}) => {
      // Текст чужой, поэтому чистится ровно так же, как свой. На экран он
      // попадает только через textContent (см. src/ui/chat.js).
      if (!chat.add({text: raw, from: names.get(peerId) ?? null})) return;
      // Реакцию человек уже увидел над плиткой — будить ею счётчик
      // непрочитанного значит звать читать то, что читать нечего.
      if (isReaction(raw)) flash(peerId, trimText(raw));
      else unread += 1;
      announce();
    };
  }

  // Конец показа экрана приходится объявлять словами. Снятие дорожки у
  // отправителя даёт получателю не 'ended', а 'mute' — дорожка остаётся
  // живой, и отличить «показ кончился» от «кадр задержался на
  // пересогласовании» по её состоянию нельзя. Гадали бы — плитка либо
  // висела бы вечно после конца показа, либо моргала бы на каждом
  // пересогласовании.
  mediaChannel = typeof connection.action === 'function' ? connection.action('media') : null;
  if (mediaChannel) {
    mediaChannel.onMessage = (value, {peerId}) => {
      peerMedia.set(peerId, {mic: Boolean(value?.mic), cam: Boolean(value?.cam)});
      announce();
    };
  }

  screensChannel = typeof connection.action === 'function' ? connection.action('screen') : null;
  if (screensChannel) {
    screensChannel.onMessage = (on, {peerId}) => {
      if (on) return;
      screens.delete(peerId);
      announce();
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
      const measured = levelFrom(samples);
      tracker.report(SELF, measured);
      void levels.send(measured);
      // Объявляем только заметные изменения: глазу хватает два десятка
      // ступеней, а перерисовка ради неразличимой цифры не нужна никому.
      const step20 = Math.round(Math.min(1, Math.sqrt(measured) * 2.2) * 20);
      if (step20 === lastStep) return;
      lastStep = step20;
      level = measured;
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
  // О себе рассказываем сами: собеседнику иначе неоткуда узнать, выключен
  // микрофон или просто молчит.
  const tellMedia = () => void mediaChannel?.send({mic: microphoneWanted, cam: cameraWanted});

  const applyDesiredMedia = () => {
    media.setMicrophone(microphoneWanted);
    // Показ экрана лестнице не подчиняется: если человек показывает экран,
    // значит в нём весь смысл разговора, и гасить его из-за того, что
    // говорит кто-то другой, — вредительство.
    media.setCamera(screenWanted || (cameraWanted && cameraAllowed()));
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
  let screenSwitching = false;

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

  // За кем уже присматриваем. WeakSet, а не список: соединения создаёт и
  // выбрасывает библиотека, и держать их своим списком значило бы мешать
  // сборщику мусора.
  const watched = new WeakSet();

  const tick = async () => {
    // Группируем по собеседнику, а не сваливаем в один список: report.id
    // устойчив только внутри одного соединения и у разных собеседников
    // свободно совпадает — createStatsTracker в src/stats.js ключует
    // снимки парой (собеседник, report.id) именно поэтому.
    const peerReports = [];
    for (const [peerId, pc] of Object.entries(connection.getPeers())) {
      // Подписываемся здесь, а не на входе собеседника: такт всё равно
      // обходит все соединения, и ни одно не будет пропущено из-за того,
      // что в миг прихода его ещё не было в списке.
      if (!watched.has(pc)) {
        watched.add(pc);
        reviveOnDrop(pc);
      }
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
    // Заодно подметаем протухшие жалобы: иначе «прямого пути нет» висело
    // бы поверх работающего разговора.
    connection.troubles?.();
    flow = flowTracker.update(peerReports) ?? flow;
    const {loss, queueSeconds} = stats.summarize(peerReports);
    await applyStep(ladder.update({peerCount: peers.size + 1, loss, queueSeconds}));
  };

  const timer = setInterval(() => void tick(), STATS_EVERY_MS);

  const room = {
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
      tellMedia();
      announce();
      return on ? startMicrophone() : undefined;
    },
    // Показ экрана заменяет картинку камеры и возвращает её обратно, когда
    // показ окончен. Останавливает показ и сам браузер — своей полоской
    // «прекратить»; тогда сюда приходит onStopped, и состояние не врёт.
    setScreen: async on => {
      if (screenSwitching) return;
      screenSwitching = true;
      try {
        const change = await media.useScreen(on, step, () => {
          if (screenWanted) void room.setScreen(false);
        });
        screenWanted = on;
        // Пометка обязательна: по ней собеседник отличит экран от лица и
        // покажет их двумя плитками, а не выбросит одну из картинок.
        if (change?.added) {
          connection.addTrack(change.added, change.stream, {role: 'screen'});
        }
        if (change?.removed) connection.removeTrack(change.removed);
        void screensChannel?.send(on);
      } catch {
        // Человек передумал в окне выбора окна — это не поломка.
        screenWanted = false;
      } finally {
        screenSwitching = false;
        applyDesiredMedia();
        announce();
      }
    },

    setCamera: on => {
      cameraWanted = on;
      if (!on) stopCamera();
      applyDesiredMedia();
      tellMedia();
      announce();
      return on ? startCamera() : undefined;
    },
    // Написать можно всегда, пока есть соединение. Своё сообщение кладём
    // в ленту сразу, не дожидаясь ничего: человек должен видеть, что оно
    // отправлено, а не гадать.
    say: text => {
      const clean = trimText(text);
      if (!clean) return false;
      chat.add({text: clean, from: myName, mine: true});
      if (isReaction(clean)) flash('self', clean);
      void chatChannel?.send(clean);
      announce();
      return true;
    },

    // Страница снова видна. Пока её не было, телефон мог приостановить
    // AudioContext и отобрать дорожки — что именно он отберёт, зависит от
    // версии Android и от того, сколько страница пробыла скрытой. Поэтому
    // не гадаем, а проверяем каждую по отдельности и возвращаем только то,
    // чего человек и правда хочет.
    //
    // Кончившуюся дорожку не воскресить: её можно только снять и захватить
    // заново. Заглушённую (muted) трогать нельзя — она оживёт сама, а
    // перезахват ради неё дёрнул бы устройство впустую.
    wake: async () => {
      if (audio?.state === 'suspended') {
        try {
          await audio.resume();
        } catch {
          // Не вышло — уровень звука просто не покажется.
        }
      }
      const alive = kind =>
        (media.current()?.[kind]() ?? []).some(track => track.readyState !== 'ended');

      if (microphoneWanted && !alive('getAudioTracks')) {
        stopMicrophone();
        await startMicrophone();
      }
      if (cameraWanted && !alive('getVideoTracks')) {
        stopCamera();
        await startCamera();
      }
      announce();
    },

    // Панель переписки открыли — непрочитанного больше нет.
    readChat: () => {
      if (unread === 0) return;
      unread = 0;
      announce();
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
      for (const id of [...fading.keys()]) forgetReaction(id);
      stopLevelMeter();
      media.stop();
      await connection.leave();
    },
  };

  return room;
};
