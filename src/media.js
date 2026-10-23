// Камера и микрофон. Ступень качества приходит снаружи, из лестницы.

export const constraintsFor = step => ({
  audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
  video:
    step.videoFor === 'none'
      ? false
      : {
          width: {ideal: step.width},
          height: {ideal: step.height},
          frameRate: {ideal: 30},
        },
});

// Выбранное человеком устройство просим точно (exact), а не пожеланием:
// «пожелание» браузер молча пропустит мимо ушей и отдаст прежнее, и
// переключатель в настройках окажется украшением. Не выбрано ничего —
// ограничение остаётся как было, и устройство выбирает браузер.
export const withDevice = (constraint, deviceId) =>
  deviceId && constraint ? {...constraint, deviceId: {exact: deviceId}} : constraint;

// Подсказка кодеру, что за дорожка. Без неё браузер не знает, что шлёт, и
// при нехватке канала жертвует не тем: у экрана — чёткостью (текст
// расплывается), у голоса — разборчивостью. «detail» у экрана заодно
// говорит Chrome беречь разрешение, а не частоту кадров.
export const HINTS = {audio: 'speech', video: 'motion', screen: 'detail'};
export const hint = (track, kind) => {
  if (track && 'contentHint' in track) {
    try {
      track.contentHint = HINTS[kind];
    } catch {}
  }
  return track;
};

export const createMedia = ({
  getUserMedia = constraints => navigator.mediaDevices.getUserMedia(constraints),
  enumerateDevices = () => navigator.mediaDevices?.enumerateDevices?.() ?? Promise.resolve([]),
  // Chrome показывает приближение камеры, только если о нём попросили при
  // захвате, — и тогда спрашивает разрешение «управлять камерой». Просим
  // только на телефонах и планшетах: на компьютере приближать почти нечем,
  // а лишний вопрос пугает.
  askZoom = () =>
    Boolean(
      globalThis.matchMedia?.('(pointer: coarse)').matches &&
        globalThis.navigator?.mediaDevices?.getSupportedConstraints?.().zoom,
    ),
  getDisplayMedia = globalThis.navigator?.mediaDevices?.getDisplayMedia
    ? constraints => navigator.mediaDevices.getDisplayMedia(constraints)
    : undefined,
} = {}) => {
  let stream = null;

  // Экран живёт в СВОЁМ потоке, а не в общем. Иначе своя плитка показывала
  // бы первую попавшуюся видеодорожку — то есть иногда экран вместо лица, —
  // а выключатель камеры и лестница качества трогали бы обе картинки разом.
  let screenStream = null;

  // Что человек выбрал в настройках. Помним даже когда захвата ещё нет:
  // выбор, сделанный до включения микрофона, должен дожить до включения.
  const preferred = {audio: null, video: null};

  // Заменяет живую дорожку на дорожку с другого устройства. Отдаёт пару
  // (старая, новая) — вызывающему (room.js) нужно ещё переставить её на
  // соединениях через replaceTrack, иначе собеседники продолжат слушать
  // остановленную. Пока захвата нет, менять нечего: выбор запомнен, и
  // ближайший captureMicrophone/captureCamera возьмёт уже нужное.
  const swapTrack = async (kind, deviceId, constraint) => {
    preferred[kind] = deviceId || null;
    const tracks = kind === 'audio' ? stream?.getAudioTracks() : stream?.getVideoTracks();
    const [old] = tracks ?? [];
    if (!old) return null;

    const captured = await getUserMedia(
      kind === 'audio'
        ? {audio: withDevice(constraint, preferred.audio), video: false}
        : {audio: false, video: withZoom(withDevice(constraint, preferred.video))},
    );
    const [next] = kind === 'audio' ? captured.getAudioTracks() : captured.getVideoTracks();
    hint(next, kind);
    // Порядок важен: сначала забрать новую дорожку, потом гасить старую.
    // Наоборот — и при отказе захвата человек остался бы вообще без звука.
    old.stop();
    stream.removeTrack(old);
    stream.addTrack(next);
    if (kind === 'video') zoomWanted = null;
    return {old, next};
  };

  // Захват выбранного устройства. Выбранного может уже не быть: внешнюю
  // камеру отключили, iPhone-камера ушла вместе с телефоном, а Safari и
  // вовсе меняет номера устройств между сессиями. Тогда точное требование
  // проваливается, и кнопка молча отскакивала назад. Поэтому без выбранного
  // — берём то, что браузер даёт по умолчанию, и забываем выбор.
  const captureChosen = async (kind, constraint) => {
    const id = preferred[kind];
    const ask = deviceId => {
      const wanted = withDevice(constraint, deviceId);
      return getUserMedia(
        kind === 'audio' ? {audio: wanted, video: false} : {audio: false, video: withZoom(wanted)},
      );
    };
    try {
      return await ask(id);
    } catch (error) {
      const gone = error?.name === 'OverconstrainedError' || error?.name === 'NotFoundError';
      if (!id || !gone) throw error;
      preferred[kind] = null;
      return ask(null);
    }
  };

  const withZoom = video => (video && askZoom() ? {...video, zoom: true} : video);

  // Приближение, которое выбрал человек. Помним сами: смена ступени качества
  // перенастраивает камеру заново, и без напоминания приближение молча
  // сбрасывалось бы к единице.
  let zoomWanted = null;
  const cameraTrack = () => stream?.getVideoTracks()[0] ?? null;

  // Другая камера: на телефоне — передняя или задняя, на компьютере с двумя
  // камерами — следующая по списку. Как и выбор в настройках, отдаёт пару
  // дорожек для замены у собеседников; камера выключена — null.
  const flipCamera = async step => {
    const old = cameraTrack();
    const constraint = constraintsFor(step).video;
    if (!old || !constraint) return null;

    const facing = old.getSettings?.().facingMode;
    let want;
    if (facing === 'user' || facing === 'environment') {
      want = {...constraint, facingMode: {exact: facing === 'user' ? 'environment' : 'user'}};
    } else {
      const ids = (await enumerateDevices())
        .filter(d => d.kind === 'videoinput' && d.deviceId)
        .map(d => d.deviceId);
      const here = ids.indexOf(old.getSettings?.().deviceId);
      const next = ids[(here + 1) % ids.length];
      if (!next || ids.length < 2) return null;
      want = withDevice(constraint, next);
    }

    let captured;
    try {
      captured = await getUserMedia({audio: false, video: withZoom(want)});
    } catch (error) {
      // Многие телефоны не открывают вторую камеру, пока занята первая.
      // Тогда сначала гасим первую — на мгновение картинки не будет, зато
      // переключение сработает.
      if (error?.name !== 'NotReadableError') throw error;
      old.stop();
      try {
        captured = await getUserMedia({audio: false, video: withZoom(want)});
      } catch {
        // Не открылась и так — возвращаем прежнюю, чтобы человек не остался
        // без картинки из-за попытки её сменить.
        const back = old.getSettings?.().deviceId;
        captured = await getUserMedia({audio: false, video: withZoom(withDevice(constraint, back))});
      }
    }
    const [next] = captured.getVideoTracks();
    hint(next, 'video');
    old.stop();
    stream.removeTrack(old);
    stream.addTrack(next);
    // Выбор запоминаем, как выбор в настройках: выключил камеру и включил
    // снова — та же камера, а не снова передняя.
    preferred.video = next.getSettings?.().deviceId || preferred.video;
    zoomWanted = null;
    return {old, next};
  };

  return {
    flipCamera,
    facing: () => cameraTrack()?.getSettings?.().facingMode ?? null,
    cameraCount: async () =>
      (await enumerateDevices()).filter(d => d.kind === 'videoinput').length,

    // Приближение — только там, где камера умеет его сама (обычно задняя
    // камера телефона). Цифровое, растягиванием кадра, не делаем: оно
    // лишь размывает картинку, и собеседник видит то же самое, только хуже.
    zoom: () => {
      const track = cameraTrack();
      const range = track?.getCapabilities?.().zoom;
      if (!range || !(range.max > range.min)) return null;
      return {min: range.min, max: range.max, value: track.getSettings?.().zoom ?? range.min};
    },
    setZoom: async value => {
      const track = cameraTrack();
      const range = track?.getCapabilities?.().zoom;
      if (!range) return;
      zoomWanted = Math.min(range.max, Math.max(range.min, Number(value) || range.min));
      await track.applyConstraints({advanced: [{zoom: zoomWanted}]});
    },

    // Выбор устройства из настроек. Возвращает пару дорожек для замены на
    // соединениях либо null, если менять пока нечего.
    // Экран умеют не все: на телефонах getDisplayMedia нет вовсе, и кнопку
    // там показывать незачем.
    canShareScreen: () => typeof getDisplayMedia === 'function',

    // Картинка экрана ЗАМЕНЯЕТ картинку камеры, а не добавляется к ней.
    // Правило «одна картинка на человека» держит и приём (см. onPeerTrack в
    // src/signal/public-channels.js): показать сразу и лицо, и экран мы не
    // умеем, а молча слать обе дорожки значило бы, что у собеседника одна
    // из них пропадёт без объяснений.
    //
    // onStopped зовётся, когда человек прекращает показ самим браузером —
    // кнопкой в его полоске, а не нашей. Без этого приложение осталось бы
    // уверено, что экран ещё идёт.
    // Включает или выключает показ экрана. Камеру НЕ трогает: лицо и экран
    // идут вместе, каждое своей дорожкой со своей пометкой. Отдаёт дорожку,
    // которую надо разослать (added) или снять (removed).
    useScreen: async (on, _step, onStopped) => {
      if (on) {
        if (typeof getDisplayMedia !== 'function') return null;
        if (screenStream) return null; // уже показываем
        const captured = await getDisplayMedia({video: {frameRate: {ideal: 15}}, audio: false});
        const [next] = captured.getVideoTracks();
        if (!next) return null;
        hint(next, 'screen');
        if (onStopped) next.addEventListener('ended', onStopped);
        screenStream = captured;
        return {added: next, stream: captured};
      }

      if (!screenStream) return null;
      const [removed] = screenStream.getVideoTracks();
      screenStream.getTracks().forEach(t => t.stop());
      screenStream = null;
      return removed ? {removed} : null;
    },

    // Поток экрана — отдельный: плитка экрана показывает только его.
    screen: () => screenStream,

    useMicrophone: (deviceId, step) =>
      swapTrack('audio', deviceId, constraintsFor(step).audio),
    useCamera: (deviceId, step) => swapTrack('video', deviceId, constraintsFor(step).video),
    chosen: () => ({microphone: preferred.audio, camera: preferred.video}),

    start: async step => {
      stream = await getUserMedia(constraintsFor(step));
      return stream;
    },

    // Ужимаем существующую дорожку вместо повторного захвата: повторный
    // getUserMedia моргает камерой и пугает человека.
    //
    // Дорожку не включаем и не выключаем — enabled целиком в ведении
    // setCamera() ниже (единый хозяин — см. applyDesiredMedia() в
    // src/room.js). Раньше эта функция безусловно ставила enabled = true
    // перед перенастройкой камеры (100–600 мс на applyConstraints) — и если
    // человек только что выключил камеру, а в этот же такт сменилась
    // ступень, включение происходило прямо здесь, синхронно, до того как
    // room.js успевал хоть что-то поправить: поправка приходит только после
    // await этой функции, а к тому моменту живые кадры уже ушли всем
    // собеседникам. Значение по умолчанию (true) на момент создания
    // дорожки задаёт сам браузер при getUserMedia.
    applyStep: async step => {
      const [video] = stream?.getVideoTracks() ?? [];
      if (!video || step.videoFor === 'none') return;
      await video.applyConstraints({
        width: {ideal: step.width},
        height: {ideal: step.height},
        ...(zoomWanted !== null ? {advanced: [{zoom: zoomWanted}]} : {}),
      });
    },

    setMicrophone: on => stream?.getAudioTracks().forEach(t => (t.enabled = on)),
    setCamera: on => stream?.getVideoTracks().forEach(t => (t.enabled = on)),

    // Захват по требованию — отдельно от setMicrophone()/setCamera() выше.
    // Те двое ничего не захватывают, только гасят и зажигают уже имеющуюся
    // дорожку (ими распоряжается такт лестницы — applyDesiredMedia() в
    // src/room.js, и звать getUserMedia на каждом такте нельзя). Захват —
    // дело одного явного нажатия человека, поэтому у него свои методы.
    //
    // Каждый просит браузер ровно об одном — только звук или только
    // картинка, отдельным вызовом getUserMedia, — чтобы разрешение
    // спрашивалось только на то, что действительно нужно сейчас. Первый
    // захват в звонке отдаёт общий поток целиком, дальше в него дописывает
    // дорожки addTrack — новый getUserMedia пересоздавал бы уже идущую
    // дорожку и моргал бы устройством, которое и так работает.
    captureMicrophone: async step => {
      if (stream?.getAudioTracks().length) return null; // уже захвачен
      const captured = await captureChosen('audio', constraintsFor(step).audio);
      const [track] = captured.getAudioTracks();
      hint(track, 'audio');
      if (stream) stream.addTrack(track);
      else stream = captured;
      return track;
    },

    // На голосовой ступени видео не просит никто и никогда (см.
    // constraintsFor) — лестница здесь не включает камеру, а лишь не даёт
    // это сделать, даже если явно попросили.
    captureCamera: async step => {
      const video = constraintsFor(step).video;
      if (!video) return null;
      if (stream?.getVideoTracks().length) return null; // уже захвачена
      const captured = await captureChosen('video', video);
      const [track] = captured.getVideoTracks();
      hint(track, 'video');
      if (stream) stream.addTrack(track);
      else stream = captured;
      return track;
    },

    // Освобождение устройства — не «выключатель» выше (enabled = false), а
    // настоящий track.stop(): камера и микрофон гаснут по-настоящему, а не
    // только перестают слаться собеседникам. Отдают остановленные дорожки —
    // вызывающему (room.js) нужно ещё снять их с соединений.
    releaseMicrophone: () => {
      const tracks = stream?.getAudioTracks() ?? [];
      tracks.forEach(t => {
        t.stop();
        stream.removeTrack(t);
      });
      return tracks;
    },
    releaseCamera: () => {
      zoomWanted = null;
      const tracks = stream?.getVideoTracks() ?? [];
      tracks.forEach(t => {
        t.stop();
        stream.removeTrack(t);
      });
      return tracks;
    },

    stop: () => {
      stream?.getTracks().forEach(t => t.stop());
      stream = null;
      screenStream?.getTracks().forEach(t => t.stop());
      screenStream = null;
    },

    current: () => stream,
  };
};

export const setMaxBitrate = async (sender, bps) => {
  const params = sender.getParameters();
  if (!params.encodings?.length) return;
  params.encodings[0].maxBitrate = bps;
  await sender.setParameters(params);
};
