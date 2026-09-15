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

export const createMedia = ({
  getUserMedia = constraints => navigator.mediaDevices.getUserMedia(constraints),
} = {}) => {
  let stream = null;

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
        : {audio: false, video: withDevice(constraint, preferred.video)},
    );
    const [next] = kind === 'audio' ? captured.getAudioTracks() : captured.getVideoTracks();
    // Порядок важен: сначала забрать новую дорожку, потом гасить старую.
    // Наоборот — и при отказе захвата человек остался бы вообще без звука.
    old.stop();
    stream.removeTrack(old);
    stream.addTrack(next);
    return {old, next};
  };

  return {
    // Выбор устройства из настроек. Возвращает пару дорожек для замены на
    // соединениях либо null, если менять пока нечего.
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
      const captured = await getUserMedia({
        audio: withDevice(constraintsFor(step).audio, preferred.audio),
        video: false,
      });
      const [track] = captured.getAudioTracks();
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
      const captured = await getUserMedia({audio: false, video: withDevice(video, preferred.video)});
      const [track] = captured.getVideoTracks();
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
