// Единственное место, где живёт знание о способе доставки.
// Всё остальное приложение работает через этот интерфейс и не знает,
// приехало рукопожатие трекером, релеем или руками человека.

import {deriveRoomId, derivePassword} from '../room-secret.js';
import {joinPublicChannels} from './public-channels.js';

// Через сколько молчания стоит сказать человеку, что дело, похоже, плохо.
// Это именно подсказка, а не приговор: звонок продолжает попытки.
export const QUIET_HINT_AFTER_MS = 20_000;
const POLL_EVERY_MS = 500;

// Наблюдает за признаками жизни и сообщает наверх, когда их долго нет.
//
// Раньше здесь стоял предел ожидания, который по истечении 45 секунд
// ОТКЛОНЯЛ подключение, и звонок падал на экран «Связь не установилась».
// Это была ошибка, и дорогая: проверка «канал жив» сверяет адреса строка
// в строку с тем, что отдаёт библиотека, и одно расхождение ключа делало
// alive навсегда ложным — а вместе с ним убивало совершенно исправный
// звонок, в том числе по одному Wi-Fi, где соединение обязано вставать
// сразу. Ожидание не должно иметь права ломать то, что работает: теперь
// оно только подсказывает, а решает человек.
export const watchForLife = (alive, onQuiet, quietAfterMs = QUIET_HINT_AFTER_MS) => {
  const startedAt = Date.now();
  let told = false;

  const poll = setInterval(() => {
    if (alive()) {
      told = false;
      onQuiet(false);
      return;
    }
    if (!told && Date.now() - startedAt >= quietAfterMs) {
      told = true;
      onQuiet(true);
    }
  }, POLL_EVERY_MS);

  return () => clearInterval(poll);
};

// families — необязательный параметр только для тестов, как и в
// joinPublicChannels(), которому он передаётся насквозь.
export const connect = async ({secret, handlers, families, onQuiet = () => {}}) => {
  const [roomId, password] = await Promise.all([
    deriveRoomId(secret),
    derivePassword(secret),
  ]);

  let peerSeen = false;
  const connection = joinPublicChannels({
    roomId,
    password,
    families,
    handlers: {
      ...handlers,
      onPeerJoin: peerId => {
        peerSeen = true;
        handlers.onPeerJoin?.(peerId);
      },
    },
  });

  // Подключение готово сразу — ждать тут нечего и незачем.
  const stopWatching = watchForLife(
    () => peerSeen || connection.status().some(channel => channel.alive),
    onQuiet,
  );

  const leave = connection.leave;
  return {
    ...connection,
    leave: () => {
      stopWatching();
      return leave();
    },
  };
};
