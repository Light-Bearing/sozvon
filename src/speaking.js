// Кто сейчас говорит. Нужно для ступени, где видео остаётся только
// у говорящего: каждый решает за себя, слать ли картинку.

export const SPEAKING = {
  threshold: 0.02,
  holdMs: 1_500,
};

// Среднеквадратичная громкость: знак не важен, важен размах.
export const levelFrom = samples => {
  if (!samples.length) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
};

export const createSpeakingTracker = ({
  now = () => Date.now(),
  hold = SPEAKING.holdMs,
  threshold = SPEAKING.threshold,
} = {}) => {
  const heard = new Map();

  return {
    report: (peerId, level) => {
      if (level >= threshold) heard.set(peerId, {level, at: now()});
    },

    // Все, кто говорит прямо сейчас, — для подсветки плиток. В отличие от
    // speaker() ниже, тут не «самый громкий», а все: говорить могут двое
    // разом, и показывать это надо честно. Окно короче, чем у ступени
    // качества: глаз ждёт, что контур погаснет вскоре после слова, а
    // камере переключаться так часто нельзя.
    speaking: (within = hold) => {
      const t = now();
      const итог = [];
      for (const [peerId, {at}] of heard) if (t - at <= within) итог.push(peerId);
      return итог;
    },

    // Держим говорящего сквозь паузы между словами, иначе картинка мигает.
    speaker: () => {
      const t = now();
      let best = null;
      for (const [peerId, {level, at}] of heard) {
        if (t - at > hold) {
          heard.delete(peerId);
          continue;
        }
        if (!best || level > best.level) best = {peerId, level};
      }
      return best?.peerId ?? null;
    },
  };
};
