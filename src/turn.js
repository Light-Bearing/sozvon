// Ретранслятор: свой, на своей машине.
//
// Нужен, когда прямой путь между собеседниками не складывается. Он
// перекладывает пакеты вслепую — шифрование живёт между браузерами, ключей
// от разговора у него нет и быть не может.
//
// Важно: ретранслятор достаточно иметь ОДНОМУ. Лёд соединяет пару, если
// достижим хоть один конец, — поэтому хозяину со своим ретранслятором
// дозвонится и гость, который ни о чём не настраивал и знать не знает.

const DEFAULT_PORT = 3478;
// Пропуск живёт полсуток: дольше — лишний риск, если ссылку переслали
// дальше; короче — разговор оборвётся посреди слова.
export const TICKET_SECONDS = 12 * 60 * 60;

// Человек вписывает адрес как умеет: «195.58.52.143», «turn:host:3478»,
// «host:3478». Приводим к паре адресов — обычному и по TCP: на сетях,
// которые режут UDP, проходит только второй.
export const relayUrls = address => {
  const clean = String(address ?? '')
    .trim()
    .replace(/^turns?:/i, '')
    .replace(/\?.*$/, '');
  if (!clean) return [];
  const port = /:\d+$/.test(clean) ? '' : `:${DEFAULT_PORT}`;
  return [`turn:${clean}${port}`, `turn:${clean}${port}?transport=tcp`];
};

const toBase64 = bytes => btoa(String.fromCharCode(...bytes));

// Короткий пропуск по правилу coturn: имя — «срок:кто», пароль — подпись
// имени ключом сервера. Считается целиком в браузере хозяина, поэтому
// отдельный сервер выдачи пропусков не нужен вовсе.
export const mintTicket = async (secret, {now = Date.now(), name = 'sozvon'} = {}) => {
  const username = `${Math.floor(now / 1000) + TICKET_SECONDS}:${name}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {name: 'HMAC', hash: 'SHA-1'},
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
  return {username, credential: toBase64(new Uint8Array(signature))};
};

// Готовый список для льда. Пустой — когда ретранслятор не настроен: тогда
// звонок идёт как раньше, только напрямую.
export const turnConfigFor = async ({address, secret, now} = {}) => {
  const urls = relayUrls(address);
  if (!urls.length || !secret) return [];
  const {username, credential} = await mintTicket(secret, {now});
  return urls.map(url => ({urls: url, username, credential}));
};
