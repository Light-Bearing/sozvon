// Единственное место, где живёт знание о способе доставки.
// Всё остальное приложение работает через этот интерфейс и не знает,
// приехало рукопожатие трекером, релеем или руками человека.

import {deriveRoomId, derivePassword} from '../room-secret.js';
import {joinPublicChannels} from './public-channels.js';

// Сколько ждать хоть каких-то признаков жизни — собеседника или живого
// канала, — прежде чем сдаться. Дольше ждать бессмысленно: если за 45
// секунд не появилось ни того, ни другого, дело не в медлительности сети,
// а в том, что все трекеры, релеи и брокеры разом недоступны (корпоративная
// сеть, блокировки). Раньше ожидание ничем не было ограничено: createRoom
// спокойно завершался, экран звонка рисовался, и обе стороны бесконечно
// сидели на «жду, когда зайдут», не понимая, что дело безнадёжно.
export const WAIT_FOR_LIFE_MS = 45_000;
const POLL_EVERY_MS = 500;

const timeoutError = () =>
  Object.assign(new Error('Ни собеседника, ни живого канала не появилось за отведённое время'), {
    name: 'HandshakeTimeoutError',
  });

// Ждёт, пока alive() не станет истиной, опрашивая её каждые POLL_EVERY_MS.
// Отдельная функция ради теста: проверяет саму механику ожидания без
// настоящих каналов и настоящей криптографии.
export const waitUntilAlive = (alive, waitMs = WAIT_FOR_LIFE_MS) =>
  new Promise((resolve, reject) => {
    if (alive()) return resolve();

    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (alive()) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - startedAt >= waitMs) {
        clearInterval(poll);
        reject(timeoutError());
      }
    }, POLL_EVERY_MS);
  });

// families — необязательный параметр только для тестов, как и в
// joinPublicChannels(), которому он передаётся насквозь.
export const connect = async ({secret, handlers, families}) => {
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

  try {
    // peerSeen тоже считается жизнью: если собеседник уже нашёлся, неважно,
    // что в этот самый момент опроса говорит status() — исход и так ясен.
    await waitUntilAlive(() => peerSeen || connection.status().some(channel => channel.alive));
  } catch (error) {
    // Не встало — не оставляем за собой открытые сокеты и соединения.
    await connection.leave().catch(() => {});
    throw error;
  }

  return connection;
};
