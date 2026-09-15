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

export const createMedia = ({
  getUserMedia = constraints => navigator.mediaDevices.getUserMedia(constraints),
} = {}) => {
  let stream = null;

  return {
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
