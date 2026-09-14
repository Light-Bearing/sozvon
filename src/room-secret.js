// Всё, что выводится из секрета комнаты.
// Секрет живёт только в хэше ссылки: браузер хэш на сервер не отправляет.

const SECRET_BYTES = 16;

const toBase64Url = bytes =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export const generateSecret = () =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));

const digest = async (secret, purpose) =>
  new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret + purpose)),
  );

// Публичное имя комнаты. Уходит в открытый канал, секрет по нему не восстановить.
export const deriveRoomId = async secret =>
  toBase64Url((await digest(secret, ':room')).slice(0, 16));

// Ключ, которым Trystero шифрует рукопожатие. Наружу не попадает никогда.
export const derivePassword = async secret => toBase64Url(await digest(secret, ':key'));

export const secretToLink = (secret, base) =>
  `${base ?? location.origin + location.pathname}#${secret}`;

export const linkToSecret = href => {
  try {
    const hash = new URL(href).hash.slice(1);
    return /^[A-Za-z0-9_-]{22}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
};
