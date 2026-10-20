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

// ── настройка одной ссылкой ────────────────────────────────
//
// Вписывать адрес и ключ руками — работа, которой быть не должно. Ссылку
// с настройкой хозяин делает у себя на сервере (см. tools/turn/установка.md)
// и открывает один раз. Ключ при этом идёт с его машины прямо в его
// браузер, не проходя ни через чьи руки.
//
// Хвост ссылки браузер на сервер не отправляет, но сама ссылка — это ключ
// целиком. Поэтому приложение стирает её из адресной строки сразу, как
// прочитает, и пересылать её никому нельзя.

const RELAY_PREFIX = 'turn=';

// atob отдаёт строку байтов, а не текст: не-латиница в ключе без разбора
// UTF-8 молча превратилась бы в кракозябры, и ключ перестал бы подходить —
// без единого сообщения об ошибке.
const fromBase64Url = text => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
};

export const relayFromLink = href => {
  try {
    const hash = new URL(href).hash.slice(1);
    if (!hash.startsWith(RELAY_PREFIX)) return null;
    const {a, k} = JSON.parse(fromBase64Url(hash.slice(RELAY_PREFIX.length)));
    const address = String(a ?? '').trim();
    const secret = String(k ?? '').trim();
    return address && secret ? {address, secret} : null;
  } catch {
    // Испорченная или чужая ссылка — не повод падать: просто не настройка.
    return null;
  }
};

// ── пропуск в приглашении ──────────────────────────────────
//
// Ретранслятор был только у хозяина и закрывал только его пары. Пара двух
// гостей оставалась без защиты — ровно так в разговоре впятером две пары
// не видели друг друга, а хозяин видел всех.
//
// Поэтому в приглашение кладём ПРОПУСК — не ключ. Пропуск живёт полсуток и
// позволяет одно: пересылать пакеты через этот ретранслятор. Ключ, которым
// пропуска выписываются, остаётся в браузере хозяина, как и был.
//
// Цена честная: кто получит ссылку, тот полсуток может пользоваться
// ретранслятором. Но он и так может войти в разговор — ссылка ровно для
// этого и отдана.

const toBase64Url = text =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

// Пропуск для приглашения, выписанный ключом хозяина. Пусто — если
// ретранслятор не настроен: тогда и класть в ссылку нечего.
export const passFor = async ({address, secret, now} = {}) => {
  const clean = String(address ?? '').trim();
  if (!clean || !secret) return null;
  const {username, credential} = await mintTicket(secret, {now});
  return {address: clean, username, credential};
};

// Короткий вид — для самого частого случая: ретранслятор по адресу, имя
// пропуска стандартное. Байтами: вид (1), адрес (4), порт (2, ноль — «не
// указан»), срок (4), подпись (20). Выходит 31 байт, около сорока знаков в
// ссылке — против ста с лишним у текстового. Всё прочее (имя хоста вместо
// адреса, нестандартное имя) едет прежним текстовым видом.
const COMPACT = 1;
const IPV4 = /^(?:turns?:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$/i;

const bytesToBase64Url = bytes =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const base64UrlToBytes = text => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')), c => c.charCodeAt(0));
};

const packCompact = ({address, username, credential}) => {
  const ip = IPV4.exec(String(address).trim());
  const [until, name] = String(username).split(':');
  if (!ip || name !== 'sozvon' || !/^\d+$/.test(until)) return null;
  const octets = ip.slice(1, 5).map(Number);
  const port = Number(ip[5] ?? 0);
  if (octets.some(n => n > 255) || port > 65535) return null;
  let signature;
  try {
    signature = Uint8Array.from(atob(credential), c => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (signature.length !== 20) return null;
  const bytes = new Uint8Array(31);
  const view = new DataView(bytes.buffer);
  bytes[0] = COMPACT;
  bytes.set(octets, 1);
  view.setUint16(5, port);
  view.setUint32(7, Number(until));
  bytes.set(signature, 11);
  return bytesToBase64Url(bytes);
};

const unpackCompact = blob => {
  const bytes = base64UrlToBytes(blob);
  if (bytes.length !== 31 || bytes[0] !== COMPACT) return null;
  const view = new DataView(bytes.buffer);
  const port = view.getUint16(5);
  const ip = [...bytes.slice(1, 5)].join('.');
  return {
    a: port ? `${ip}:${port}` : ip,
    u: `${view.getUint32(7)}:sozvon`,
    c: toBase64(bytes.slice(11)),
  };
};

export const packPass = pass =>
  packCompact(pass) ??
  toBase64Url(JSON.stringify({a: pass.address, u: pass.username, c: pass.credential}));

// Срок пропуска записан в самом имени: «срок:кто». Просроченный отбрасываем
// сразу — ретранслятор его всё равно не примет, а попытка стоила бы
// времени на каждом соединении.
export const unpackPass = (blob, {now = Date.now()} = {}) => {
  try {
    const text = String(blob ?? '');
    // Текстовый вид — это JSON, а он в base64 всегда начинается с «ey».
    const {a, u, c} = text.startsWith('ey') ? JSON.parse(fromBase64Url(text)) : (unpackCompact(text) ?? {});
    const address = String(a ?? '').trim();
    const username = String(u ?? '');
    const credential = String(c ?? '');
    const until = Number(username.split(':')[0]);
    if (!address || !credential || !Number.isFinite(until)) return null;
    if (until * 1000 <= now) return null;
    return {address, username, credential};
  } catch {
    // Испорченный хвост ссылки — не повод падать: просто без ретранслятора.
    return null;
  }
};

export const serversFromPass = pass =>
  pass
    ? relayUrls(pass.address).map(urls => ({
        urls,
        username: pass.username,
        credential: pass.credential,
      }))
    : [];
