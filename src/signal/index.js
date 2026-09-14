// Единственное место, где живёт знание о способе доставки.
// Всё остальное приложение работает через этот интерфейс и не знает,
// приехало рукопожатие трекером, релеем или руками человека.

import {deriveRoomId, derivePassword} from '../room-secret.js';
import {joinPublicChannels} from './public-channels.js';

export const connect = async ({secret, handlers}) => {
  const [roomId, password] = await Promise.all([
    deriveRoomId(secret),
    derivePassword(secret),
  ]);
  return joinPublicChannels({roomId, password, handlers});
};
