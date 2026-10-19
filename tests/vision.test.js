// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Подделка MediaPipe: настоящая нужна WebGL и десять мегабайт модели, а
// проверяются здесь решения обёртки — когда сдаться и о чём сказать.
const mp = vi.hoisted(() => ({
  face: {box: {originX: 320, originY: 180, width: 100, height: 100}, fail: false, calls: 0},
  gesture: {name: 'Thumb_Up', fail: false},
  failGpu: false,
  failAll: false,
}));

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: {forVisionTasks: async () => ({})},
  FaceDetector: {
    createFromOptions: async (_files, {baseOptions}) => {
      if (mp.failAll || (mp.failGpu && baseOptions.delegate === 'GPU')) throw new Error('нет');
      return {
        detectForVideo: () => {
          mp.face.calls += 1;
          if (mp.face.fail) throw new Error('кадр не прочитался');
          return {detections: mp.face.box ? [{boundingBox: mp.face.box}] : []};
        },
      };
    },
  },
  GestureRecognizer: {
    createFromOptions: async () => {
      if (mp.failAll) throw new Error('нет');
      return {
        recognizeForVideo: () => {
          if (mp.gesture.fail) throw new Error('кадр не прочитался');
          return {gestures: [[{categoryName: mp.gesture.name, score: 0.95}]]};
        },
      };
    },
  },
}));

const {createVision} = await import('../src/vision.js');

const живойПоток = () => ({getVideoTracks: () => [{readyState: 'live'}]});

// Страница в тестах не играет видео: подсовываем размеры и готовность, чтобы
// замер вообще начался.
const оживитьВидео = () => {
  const real = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(tag => {
    const el = real(tag);
    if (tag === 'video') {
      Object.defineProperty(el, 'readyState', {value: 4});
      Object.defineProperty(el, 'videoWidth', {value: 640});
      Object.defineProperty(el, 'videoHeight', {value: 360});
      el.play = () => Promise.resolve();
    }
    return el;
  });
};

const пройти = async мс => {
  await vi.advanceTimersByTimeAsync(мс);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  mp.face = {box: {originX: 270, originY: 130, width: 100, height: 100}, fail: false, calls: 0};
  mp.gesture = {name: 'Thumb_Up', fail: false};
  mp.failGpu = false;
  mp.failAll = false;
  оживитьВидео();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('распознавание', () => {
  it('нашло лицо — сообщает его положение долями кадра', async () => {
    const onFace = vi.fn();
    const vision = createVision({onFace});
    vision.setStream(живойПоток());
    vision.setWanted({face: true});

    await пройти(1000);

    expect(onFace).toHaveBeenCalled();
    const {x, y} = onFace.mock.calls[0][0];
    expect(x).toBeCloseTo(0.5, 2);
    expect(y).toBeCloseTo(0.5, 2);
    vision.stop();
  });

  it('удержанный жест становится одним мемом', async () => {
    const onGesture = vi.fn();
    const vision = createVision({onGesture});
    vision.setStream(живойПоток());
    vision.setWanted({gestures: true});

    await пройти(2000);

    expect(onGesture).toHaveBeenCalledTimes(1);
    expect(onGesture).toHaveBeenCalledWith('Thumb_Up');
    vision.stop();
  });

  it('видеокарты нет — считает процессором и работает', async () => {
    mp.failGpu = true;
    const onFace = vi.fn();
    const onFailed = vi.fn();
    const vision = createVision({onFace, onFailed});
    vision.setStream(живойПоток());
    vision.setWanted({face: true});

    await пройти(1000);

    expect(onFace).toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    vision.stop();
  });

  it('модель не загрузилась — говорит об этом один раз и не пытается дальше', async () => {
    mp.failAll = true;
    const onFailed = vi.fn();
    const vision = createVision({onFailed});
    vision.setStream(живойПоток());
    vision.setWanted({face: true});

    await пройти(3000);

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith('face', 'load');
    vision.stop();
  });

  it('замеры падают подряд — сдаётся и сообщает, не раньше двенадцатого', async () => {
    mp.face.fail = true;
    const onFailed = vi.fn();
    const vision = createVision({onFailed, fps: 10});
    vision.setStream(живойПоток());
    vision.setWanted({face: true});

    await пройти(900);
    expect(onFailed).not.toHaveBeenCalled();

    await пройти(1000);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith('face', 'run');
    vision.stop();
  });

  it('после сдачи замеры прекращаются', async () => {
    mp.face.fail = true;
    const vision = createVision({onFailed: () => {}, fps: 10});
    vision.setStream(живойПоток());
    vision.setWanted({face: true});
    await пройти(2000);
    const было = mp.face.calls;

    await пройти(2000);

    expect(mp.face.calls).toBe(было);
    vision.stop();
  });

  it('единичный сбой не считается: удачный замер сбрасывает счёт', async () => {
    const onFailed = vi.fn();
    const vision = createVision({onFailed, fps: 10});
    vision.setStream(живойПоток());
    vision.setWanted({face: true});

    for (let i = 0; i < 5; i++) {
      mp.face.fail = true;
      await пройти(500);
      mp.face.fail = false;
      await пройти(300);
    }

    expect(onFailed).not.toHaveBeenCalled();
    vision.stop();
  });

  it('камеру выключили — собеседникам сообщается, что лица нет', async () => {
    const onFace = vi.fn();
    const vision = createVision({onFace});
    vision.setStream(живойПоток());
    vision.setWanted({face: true});
    await пройти(1000);
    onFace.mockClear();

    vision.setStream(null);

    expect(onFace).toHaveBeenCalledWith(null);
    vision.stop();
  });

  it('без настроек и без камеры ничего не измеряет', async () => {
    const vision = createVision({});
    vision.setStream(живойПоток());
    await пройти(2000);

    expect(mp.face.calls).toBe(0);
    vision.stop();
  });
});
