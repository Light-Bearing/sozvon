// Переписка в разговоре.
//
// Идёт по тому же каналу данных, что и уровни звука с именами, — значит
// живёт ровно столько, сколько живо соединение. Спасти разговор, который
// не сложился, она не может: канал данных требует того же соединения, что
// и звук. Зато когда связь есть, написать можно всегда — в том числе когда
// говорить неудобно.

export const MAX_TEXT = 2000;
// Сколько сообщений держим. Разговор — не архив: старое уезжает.
export const MAX_KEPT = 200;

export const trimText = raw =>
  (typeof raw === 'string' ? raw : '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT) || null;

// Реакция — сообщение из одних значков, не длиннее трёх. Такое пишут не
// чтобы прочитали, а чтобы увидели: оно всплывает крупно над плиткой того,
// кто послал, и не будит счётчик непрочитанного. В ленте всё равно
// остаётся — разговор должен помнить, что в нём было.
//
// Emoji_Component намеренно не в наборе: туда входят обычные цифры, и «12»
// сошло бы за реакцию.
const ONLY_PICTURES =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f)+$/u;

// Значок из нескольких кодовых точек (семья, флаг, тон кожи) — это один
// знак для глаза, и считать надо именно так.
const graphemes =
  typeof Intl?.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, {granularity: 'grapheme'})
    : null;

export const MAX_REACTION = 3;

export const isReaction = raw => {
  const clean = trimText(raw);
  if (!clean || !ONLY_PICTURES.test(clean)) return false;
  const count = graphemes ? [...graphemes.segment(clean)].length : [...clean].length;
  return count <= MAX_REACTION;
};

export const createChatLog = ({limit = MAX_KEPT} = {}) => {
  let messages = [];

  return {
    all: () => messages,

    // Возвращает true, если сообщение и вправду добавилось: пустое или
    // мусорное не добавляется, и наверх объявлять нечего.
    add: ({text, from, mine = false, at = Date.now()}) => {
      const clean = trimText(text);
      if (!clean) return false;
      messages = [...messages, {text: clean, from, mine, at}].slice(-limit);
      return true;
    },

    forget: () => {
      messages = [];
    },
  };
};

// Часы для строки сообщения. Секунды не нужны: в переписке они не значат
// ничего, а глаз цепляют.
export const timeOf = (at, locale = 'ru-RU') =>
  new Date(at).toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'});
