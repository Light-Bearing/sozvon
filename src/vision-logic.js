// Всё, что решается по итогам распознавания, — без самого распознавания.
// Отдельно, чтобы проверять тестами: модели в тестовой среде нет, а ошибки
// тут как раз в решениях — когда жест считать жестом, куда сдвинуть кадр.

// Жест → мем. Жесты — ровно те, что знает модель MediaPipe. Подписи —
// крупными буквами, как на мемах; слова короткие, чтобы читались и на
// маленькой плитке.
export const MEMES = {
  Thumb_Up: {emoji: '👍', caption: 'Годится'},
  Thumb_Down: {emoji: '👎', caption: 'Не-не-не'},
  Victory: {emoji: '✌️', caption: 'Победа'},
  ILoveYou: {emoji: '🤟', caption: 'Люблю вас'},
  Open_Palm: {emoji: '✋', caption: 'Минуточку'},
  Pointing_Up: {emoji: '☝️', caption: 'Есть идея'},
  Closed_Fist: {emoji: '✊', caption: 'Давим'},
};

// Название жеста приходит из сети — пускаем только знакомые. Иначе
// собеседник мог бы прислать что угодно, и это что-то оказалось бы на
// экране под видом мема.
export const cleanMeme = name =>
  typeof name === 'string' && Object.hasOwn(MEMES, name) ? name : null;

// Когда жест считать жестом. Модель видит руку по нескольку раз в секунду и
// ошибается на отдельных кадрах: рука, проходящая мимо камеры, на миг
// выглядит как «палец вверх». Поэтому жест должен продержаться несколько
// замеров подряд с уверенностью не ниже порога. И после мема — пауза:
// иначе удерживаемый палец вверх сыпал бы мемами без остановки.
export const createGestureGate = ({hold = 2, cooldownMs = 3000, minScore = 0.6} = {}) => {
  let current = null;
  let streak = 0;
  let quietUntil = 0;
  let fired = null;

  return {
    feed: ({name, score} = {}, now = Date.now()) => {
      const known = cleanMeme(name) && score >= minScore ? name : null;
      if (known !== current) {
        current = known;
        streak = 0;
        // Рука опустилась — тот же жест снова станет новым мемом.
        if (!known) fired = null;
      }
      if (!known) return null;
      streak += 1;
      if (streak < hold || now < quietUntil || fired === known) return null;
      fired = known;
      quietUntil = now + cooldownMs;
      return known;
    },
  };
};

// Лицо в кадре — доли ширины и высоты от 0 до 1. Из сети приходят числа
// откуда угодно: зажимаем и отбрасываем мусор.
export const cleanFace = value => {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const clamp = v => Math.min(1, Math.max(0, v));
  return {x: clamp(x), y: clamp(y)};
};

// Сдвинулось ли лицо настолько, чтобы сказать об этом собеседникам. Мелкая
// дрожь — нет: иначе сообщения шли бы на каждом замере, а кадр у получателя
// подёргивался.
export const faceMoved = (previous, next, threshold = 0.04) =>
  !previous !== !next ||
  (Boolean(next) &&
    (Math.abs(previous.x - next.x) > threshold || Math.abs(previous.y - next.y) > threshold));

// Куда сдвинуть обрезку, чтобы лицо встало в центр плитки.
//
// Кадр вписан с обрезкой (object-fit: cover), и object-position p% ставит
// точку p% картинки на точку p% плитки. Лицо на доле f картинки окажется в
// центре плитки при p = (f·w − box/2) / (w − box), где w — ширина картинки
// после масштабирования. За края не уходим: там, где лишнего кадра нет,
// двигать нечего, и центр остаётся центром.
export const panFor = ({face, videoWidth, videoHeight, boxWidth, boxHeight}) => {
  if (!face || !(videoWidth > 0) || !(videoHeight > 0) || !(boxWidth > 0) || !(boxHeight > 0)) {
    return null;
  }
  const scale = Math.max(boxWidth / videoWidth, boxHeight / videoHeight);
  const axis = (f, image, box) => {
    const extra = image * scale - box;
    if (extra < 1) return 50;
    const p = (f * image * scale - box / 2) / extra;
    return Math.round(Math.min(1, Math.max(0, p)) * 1000) / 10;
  };
  return {
    x: axis(face.x, videoWidth, boxWidth),
    y: axis(face.y, videoHeight, boxHeight),
  };
};

// Когда и что сообщать собеседникам о своём лице. Лицо пропадает из кадра
// то и дело — человек отвернулся, закрыл его рукой, чихнул, — и если на
// каждый такой миг возвращать обрезку к обычной, кадр у собеседников
// дёргается туда и обратно. Поэтому «лица нет» говорим, только когда его
// нет дольше grace. А найденное лицо напоминаем раз в remind — для тех, кто
// вошёл позже.
export const createFaceReporter = ({graceMs = 2000, remindMs = 2000, threshold = 0.04} = {}) => {
  let told = null;
  let toldAt = -Infinity;
  let missingSince = null;

  return {
    feed: (face, now = Date.now()) => {
      if (!face) {
        if (!told) return {send: false};
        missingSince ??= now;
        if (now - missingSince < graceMs) return {send: false};
        told = null;
        toldAt = now;
        return {send: true, face: null};
      }
      missingSince = null;
      if (faceMoved(told, face, threshold) || now - toldAt >= remindMs) {
        told = face;
        toldAt = now;
        return {send: true, face};
      }
      return {send: false};
    },
    // Камеру выключили или наводку сняли — сказать сразу, без ожидания.
    reset: () => {
      const had = Boolean(told);
      told = null;
      toldAt = -Infinity;
      missingSince = null;
      return had;
    },
  };
};
