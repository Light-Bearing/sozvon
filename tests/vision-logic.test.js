import {describe, expect, it} from 'vitest';
import {
  MEMES,
  cleanFace,
  cleanMeme,
  createFaceReporter,
  createGestureGate,
  faceMoved,
  panFor,
} from '../src/vision-logic.js';

describe('когда жест считать жестом', () => {
  const жест = (name, score = 0.9) => ({name, score});

  it('один кадр — не жест: рука, проходящая мимо, на миг похожа на палец вверх', () => {
    const gate = createGestureGate({hold: 2});

    expect(gate.feed(жест('Thumb_Up'), 0)).toBe(null);
    expect(gate.feed(жест('None'), 100)).toBe(null);
  });

  it('продержался два замера подряд — мем', () => {
    const gate = createGestureGate({hold: 2});

    gate.feed(жест('Thumb_Up'), 0);

    expect(gate.feed(жест('Thumb_Up'), 170)).toBe('Thumb_Up');
  });

  it('неуверенная догадка модели мемом не становится', () => {
    const gate = createGestureGate({hold: 2, minScore: 0.6});

    gate.feed(жест('Thumb_Up', 0.4), 0);

    expect(gate.feed(жест('Thumb_Up', 0.4), 170)).toBe(null);
  });

  it('удерживаемый жест — один мем, а не очередь', () => {
    const gate = createGestureGate({hold: 2, cooldownMs: 3000});
    gate.feed(жест('Thumb_Up'), 0);
    gate.feed(жест('Thumb_Up'), 170);

    const дальше = [340, 1000, 5000, 9000].map(t => gate.feed(жест('Thumb_Up'), t));

    expect(дальше).toEqual([null, null, null, null]);
  });

  it('опустил руку и поднял снова — снова мем, но не раньше паузы', () => {
    const gate = createGestureGate({hold: 2, cooldownMs: 3000});
    gate.feed(жест('Thumb_Up'), 0);
    gate.feed(жест('Thumb_Up'), 170);
    gate.feed(жест('None'), 400);

    gate.feed(жест('Thumb_Up'), 600);
    expect(gate.feed(жест('Thumb_Up'), 770)).toBe(null);

    gate.feed(жест('None'), 3100);
    gate.feed(жест('Thumb_Up'), 3300);
    expect(gate.feed(жест('Thumb_Up'), 3470)).toBe('Thumb_Up');
  });

  it('незнакомый жест не проходит', () => {
    const gate = createGestureGate({hold: 1});

    expect(gate.feed(жест('Unknown_Sign'), 0)).toBe(null);
  });
});

describe('чужие данные из сети', () => {
  it('мем — только из знакомых', () => {
    // Иначе собеседник мог бы прислать что угодно, и оно оказалось бы на
    // экране под видом мема.
    expect(cleanMeme('Thumb_Up')).toBe('Thumb_Up');
    expect(cleanMeme('<img src=x onerror=alert(1)>')).toBe(null);
    expect(cleanMeme('__proto__')).toBe(null);
    expect(cleanMeme(42)).toBe(null);
  });

  it('лицо — числа от 0 до 1, мусор отбрасывается', () => {
    expect(cleanFace({x: 0.3, y: 0.4})).toEqual({x: 0.3, y: 0.4});
    expect(cleanFace({x: -2, y: 7})).toEqual({x: 0, y: 1});
    expect(cleanFace({x: 'a', y: 0.1})).toBe(null);
    expect(cleanFace(null)).toBe(null);
  });

  it('у каждого мема есть значок и подпись', () => {
    for (const {emoji, caption} of Object.values(MEMES)) {
      expect(emoji).toMatch(/\S/);
      expect(caption).toMatch(/\S/);
    }
  });
});

describe('когда говорить собеседникам, где лицо', () => {
  it('мелкая дрожь — молчим, заметный сдвиг — говорим', () => {
    expect(faceMoved({x: 0.5, y: 0.5}, {x: 0.51, y: 0.49})).toBe(false);
    expect(faceMoved({x: 0.5, y: 0.5}, {x: 0.6, y: 0.5})).toBe(true);
  });

  it('лицо появилось или пропало — говорим', () => {
    expect(faceMoved(null, {x: 0.5, y: 0.5})).toBe(true);
    expect(faceMoved({x: 0.5, y: 0.5}, null)).toBe(true);
    expect(faceMoved(null, null)).toBe(false);
  });
});

describe('куда сдвинуть кадр, чтобы лицо встало в центр', () => {
  // Кадр 16:9 в высокой узкой плитке: обрезаются бока — вот их и двигаем.
  const широкийВУзкой = {videoWidth: 1280, videoHeight: 720, boxWidth: 300, boxHeight: 400};

  it('лицо в центре кадра — обрезка по центру', () => {
    expect(panFor({face: {x: 0.5, y: 0.5}, ...широкийВУзкой})).toEqual({x: 50, y: 50});
  });

  it('лицо сбоку — обрезка сдвигается к нему и ставит его в центр', () => {
    const сдвиг = panFor({face: {x: 0.35, y: 0.5}, ...широкийВУзкой});
    // Проверяем по сути: где окажется лицо на плитке.
    const scale = 400 / 720;
    const ширина = 1280 * scale;
    const лицоНаПлитке = 0.35 * ширина - (ширина - 300) * (сдвиг.x / 100);
    expect(лицоНаПлитке).toBeCloseTo(150, 0);
  });

  it('лицо у самого края — дальше края не уходим', () => {
    expect(panFor({face: {x: 0.02, y: 0.5}, ...широкийВУзкой}).x).toBe(0);
    expect(panFor({face: {x: 0.99, y: 0.5}, ...широкийВУзкой}).x).toBe(100);
  });

  it('по оси, где лишнего кадра нет, двигать нечего', () => {
    // В узкой плитке кадр 16:9 вписан по высоте целиком — сверху и снизу
    // ничего не обрезано, вертикаль остаётся посередине.
    expect(panFor({face: {x: 0.5, y: 0.1}, ...широкийВУзкой}).y).toBe(50);
  });

  it('размеров ещё не знаем — не трогаем', () => {
    expect(panFor({face: {x: 0.3, y: 0.3}, videoWidth: 0, videoHeight: 0, boxWidth: 300, boxHeight: 400})).toBe(null);
    expect(panFor({face: null, ...широкийВУзкой})).toBe(null);
  });
});

describe('что сообщать собеседникам о своём лице', () => {
  const лицо = (x = 0.3, y = 0.4) => ({x, y});

  it('нашлось лицо — сообщаем сразу', () => {
    const r = createFaceReporter();

    expect(r.feed(лицо(), 0)).toEqual({send: true, face: лицо()});
  });

  it('на миг пропало — молчим: иначе кадр у собеседников дёргался бы', () => {
    const r = createFaceReporter({graceMs: 2000});
    r.feed(лицо(), 0);

    expect(r.feed(null, 100)).toEqual({send: false});
    expect(r.feed(null, 1500)).toEqual({send: false});
    // Вернулось на том же месте — и говорить нечего.
    expect(r.feed(лицо(), 1700)).toEqual({send: false});
  });

  it('пропало надолго — «лица нет», один раз', () => {
    const r = createFaceReporter({graceMs: 2000});
    r.feed(лицо(), 0);
    r.feed(null, 100);

    expect(r.feed(null, 2200)).toEqual({send: true, face: null});
    expect(r.feed(null, 5000)).toEqual({send: false});
  });

  it('неподвижное лицо напоминаем — для вошедших позже', () => {
    const r = createFaceReporter({remindMs: 2000});
    r.feed(лицо(), 0);

    expect(r.feed(лицо(), 1000)).toEqual({send: false});
    expect(r.feed(лицо(), 2100)).toEqual({send: true, face: лицо()});
  });

  it('заметно сдвинулось — сообщаем, не дожидаясь напоминания', () => {
    const r = createFaceReporter();
    r.feed(лицо(0.3), 0);

    expect(r.feed(лицо(0.5), 200)).toEqual({send: true, face: лицо(0.5)});
  });

  it('сброс говорит, было ли что сбрасывать', () => {
    const r = createFaceReporter();
    expect(r.reset()).toBe(false);
    r.feed(лицо(), 0);
    expect(r.reset()).toBe(true);
  });
});
