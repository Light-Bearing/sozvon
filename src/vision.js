// Лицо и жесты распознаются здесь, в браузере, по своему же кадру. Наружу не
// уходит ни одного кадра — только выводы: где лицо и какой жест показан.
// Что с ними делать, решают room.js (рассказать собеседникам) и
// src/vision-logic.js (когда жест считать жестом, куда сдвинуть обрезку).
//
// Распознавание стоит времени процессора и двенадцати мегабайт загрузки,
// поэтому включается только настройкой и только пока камера включена.
// Модели лежат рядом с сайтом, а не на серверах Google: иначе каждый, кто
// включит мемы, отдавал бы Google свой адрес.

import {createFaceReporter, createGestureGate} from './vision-logic.js';

// Шесть замеров в секунду: жест успевает продержаться два замера за треть
// секунды, а процессор почти не замечает работы.
const FPS = 6;

const MODELS = {
  face: './models/blaze_face_short_range.tflite',
  gestures: './models/gesture_recognizer.task',
};

// Библиотеку и её среду исполнения грузим один раз на страницу и только
// когда настройку впервые включили.
let runtime = null;
const loadRuntime = () =>
  (runtime ??= import('@mediapipe/tasks-vision').then(async mp => ({
    mp,
    files: await mp.FilesetResolver.forVisionTasks('./mediapipe'),
  })));

const createTask = async kind => {
  const {mp, files} = await loadRuntime();
  const make = delegate =>
    kind === 'face'
      ? mp.FaceDetector.createFromOptions(files, {
          runningMode: 'VIDEO',
          baseOptions: {modelAssetPath: MODELS.face, delegate},
        })
      : mp.GestureRecognizer.createFromOptions(files, {
          runningMode: 'VIDEO',
          numHands: 1,
          baseOptions: {modelAssetPath: MODELS.gestures, delegate},
        });
  // Видеокарту дают не везде — тогда считаем процессором, медленнее, но
  // тоже годится при шести замерах в секунду.
  try {
    return await make('GPU');
  } catch {
    return make('CPU');
  }
};

export const createVision = ({onFace, onGesture, onFailed, fps = FPS} = {}) => {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;

  let stream = null;
  const wanted = {face: false, gestures: false};
  const tasks = {face: null, gestures: null};
  let timer = null;
  let busy = false;
  // Что и когда говорить о лице — правило в src/vision-logic.js: короткие
  // пропажи лица переждать, неподвижное напоминать.
  const reporter = createFaceReporter();
  const gate = createGestureGate();

  const forgetFace = () => {
    if (reporter.reset()) onFace?.(null);
  };

  const ensure = kind => {
    if (tasks[kind]) return;
    tasks[kind] = createTask(kind).catch(() => {
      // Не загрузилось — выключаем именно эту половину и говорим об этом,
      // чтобы переключатель в настройках не врал, будто всё работает.
      wanted[kind] = false;
      tasks[kind] = null;
      onFailed?.(kind, 'load');
      return null;
    });
  };

  // Неудачи подряд. Отдельный неудачный замер ничего не значит, а две
  // секунды подряд — значит, распознавание на этом устройстве работать не
  // может. Так бывает, например, когда браузеру не дали WebGL: MediaPipe
  // читает кадр через него даже при счёте на процессоре, и падает на каждом
  // замере. Тогда не притворяемся включёнными — выключаем и говорим.
  const STRIKES = 12;
  const strikes = {face: 0, gestures: 0};

  const attempt = async (kind, run) => {
    if (!wanted[kind] || !tasks[kind]) return;
    try {
      const task = await tasks[kind];
      if (task) run(task);
      strikes[kind] = 0;
    } catch {
      strikes[kind] += 1;
      if (strikes[kind] < STRIKES) return;
      strikes[kind] = 0;
      wanted[kind] = false;
      tasks[kind] = null;
      if (kind === 'face') forgetFace();
      onFailed?.(kind, 'run');
      refresh();
    }
  };

  const tick = async () => {
    // Замер ещё идёт — следующий пропускаем, а не копим в очередь.
    if (busy || !stream || video.readyState < 2 || !video.videoWidth) return;
    busy = true;
    const now = performance.now();

    await attempt('face', detector => {
      const box = detector.detectForVideo(video, now).detections?.[0]?.boundingBox;
      const face = box
        ? {
            x: (box.originX + box.width / 2) / video.videoWidth,
            y: (box.originY + box.height / 2) / video.videoHeight,
          }
        : null;
      const {send, face: told} = reporter.feed(face);
      if (send) onFace?.(told);
    });

    await attempt('gestures', recognizer => {
      const top = recognizer.recognizeForVideo(video, now).gestures?.[0]?.[0];
      const fired = gate.feed({name: top?.categoryName, score: top?.score ?? 0});
      if (fired) onGesture?.(fired);
    });

    busy = false;
  };

  const refresh = () => {
    const needed = Boolean(stream) && (wanted.face || wanted.gestures);
    if (needed && !timer) {
      timer = setInterval(() => void tick(), 1000 / fps);
    } else if (!needed && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    // Свой поток с камерой. Без видеодорожки — смотреть не на что.
    setStream: next => {
      const usable = next?.getVideoTracks?.().some(t => t.readyState === 'live') ? next : null;
      if (usable !== stream) {
        stream = usable;
        video.srcObject = usable;
        if (usable) void video.play().catch(() => {});
        // Камеру выключили — лицо пропало: пусть собеседники вернут обычную
        // обрезку, а не держат кадр сдвинутым к месту, где лица больше нет.
        if (!usable) forgetFace();
      }
      refresh();
    },

    setWanted: ({face = wanted.face, gestures = wanted.gestures} = {}) => {
      const hadFace = wanted.face;
      wanted.face = Boolean(face);
      if (hadFace && !wanted.face) forgetFace();
      wanted.gestures = Boolean(gestures);
      if (wanted.face) ensure('face');
      if (wanted.gestures) ensure('gestures');
      refresh();
    },

    stop: () => {
      clearInterval(timer);
      timer = null;
      stream = null;
      video.srcObject = null;
      reporter.reset();
    },
  };
};
