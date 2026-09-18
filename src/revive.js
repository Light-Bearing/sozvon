// Мигание сети не должно стоить разговора.
//
// Когда путь между собеседниками ломается — телефон сменил вышку, Wi-Fi
// сменился на мобильный, у роутера истекло сопоставление, — соединение
// уходит в `disconnected`. Библиотека ждёт пять секунд и закрывает его
// совсем. Дальше собеседники ищут друг друга заново через публичные каналы
// (объявление раз в 5,3 секунды) и строят соединение с нуля: ещё столько
// же тишины плюс новое рукопожатие. Итого секунд десять-двадцать на
// проблему, которая могла длиться полсекунды.
//
// Между тем в самом WebRTC есть средство ровно на этот случай.
// `restartIce()` заново ищет путь, **не разрывая ни поток, ни канал
// данных**: собеседник не исчезает с экрана, переписка не теряется. Мы
// его и зовём — библиотека пользуется перезапуском только для запасных
// предложений, на живом соединении никогда.
//
// Ждём GRACE_MS перед попыткой: короткие провалы залечиваются сами, и
// дёргать перезапуск на каждом — лишняя пересылка на ровном месте.

export const GRACE_MS = 1200;

const stateOf = pc => pc.connectionState ?? pc.iceConnectionState;

export const reviveOnDrop = (pc, {grace = GRACE_MS} = {}) => {
  let pending = null;
  // Одна попытка на один провал: если перезапуск не помог, дальше пусть
  // работает прежний путь — закрытие и поиск заново. Иначе мы бы слали
  // предложения раз в секунду в уже мёртвое соединение.
  let tried = false;

  const cancel = () => {
    clearTimeout(pending);
    pending = null;
  };

  const look = () => {
    const state = stateOf(pc);

    if (state === 'connected' || state === 'completed') {
      cancel();
      tried = false;
      return;
    }
    if (state === 'closed' || state === 'failed') {
      cancel();
      return;
    }
    if (state !== 'disconnected' || pending || tried) return;

    pending = setTimeout(() => {
      pending = null;
      // За время ожидания могло полегчать — тогда и делать нечего.
      if (stateOf(pc) !== 'disconnected') return;
      tried = true;
      try {
        pc.restartIce?.();
      } catch {
        // Не вышло — всё останется как было: библиотека закроет соединение
        // по своему таймеру, а собеседники найдут друг друга заново.
      }
    }, grace);
  };

  pc.addEventListener?.('connectionstatechange', look);
  pc.addEventListener?.('iceconnectionstatechange', look);
  look();

  return () => {
    cancel();
    pc.removeEventListener?.('connectionstatechange', look);
    pc.removeEventListener?.('iceconnectionstatechange', look);
  };
};
