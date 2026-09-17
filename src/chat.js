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
