// Описание соединения в двести знаков вместо двух тысяч.
//
// При обмене вручную описание едет в ссылке через мессенджер, и полное —
// пусть и сжатое — выходило около двух тысяч знаков: столько мессенджер
// может и обрезать. Но первому рукопожатию нужен только канал данных, а у
// описания одного канала данных меняются лишь несколько полей: имя и
// пароль соединения, отпечаток ключа шифрования, кто начинает защищённое
// рукопожатие и адреса. Их и пишем — байтами. Остальное собеседник
// достраивает по шаблону, одинаковому для всех браузеров. Звук и картинка
// договариваются потом, по самому каналу данных, где длина не важна.

const VERSION = 2;
const SETUP = ['actpass', 'active', 'passive'];
const TYPES = ['host', 'srflx', 'relay', 'prflx'];
// Как браузеры сами расставляют приоритеты адресов: свой — выше всего,
// через ретранслятор — ниже всего.
const PRIORITY = {host: 2122260223, srflx: 1686052607, prflx: 1845501695, relay: 41885439};
const MAX_CANDIDATES = 8;

const ADDR_V4 = 0;
const ADDR_V6 = 1;
const ADDR_MDNS = 2;

const toBase64Url = bytes =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromBase64Url = text => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')), c =>
    c.charCodeAt(0),
  );
};

const hexToBytes = hex => Uint8Array.from(hex.match(/../g) ?? [], h => parseInt(h, 16));
const bytesToHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

const v6ToBytes = text => {
  const [head, tail = null] = text.split('::');
  const part = s => (s ? s.split(':') : []);
  const left = part(head);
  const right = tail === null ? [] : part(tail);
  const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = parseInt(g, 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 255;
  });
  return bytes;
};

const bytesToV6 = bytes =>
  Array.from({length: 8}, (_, i) => ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16)).join(':');

// Адрес кандидата → байты. Чужие виды адресов (имя хоста не из .local)
// пропускаем: в браузерах их не бывает.
const addressBytes = ip => {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) return [ADDR_V4, Uint8Array.from(v4.slice(1, 5).map(Number))];
  const mdns = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i.exec(ip);
  if (mdns) return [ADDR_MDNS, hexToBytes(mdns.slice(1).join(''))];
  if (ip.includes(':')) {
    const v6 = v6ToBytes(ip);
    if (v6) return [ADDR_V6, v6];
  }
  return null;
};

const addressText = (kind, bytes) => {
  if (kind === ADDR_V4) return [...bytes].join('.');
  if (kind === ADDR_V6) return bytesToV6(bytes);
  const h = bytesToHex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
};

const ADDRESS_LENGTH = {[ADDR_V4]: 4, [ADDR_V6]: 16, [ADDR_MDNS]: 16};

const field = (sdp, name) => new RegExp(`^a=${name}:(.+)$`, 'm').exec(sdp)?.[1]?.trim() ?? null;

// Только то, что выше: имя, пароль, отпечаток, кто начинает, адреса.
export const slimPack = ({sdp}) => {
  const ufrag = field(sdp, 'ice-ufrag');
  const pwd = field(sdp, 'ice-pwd');
  const fingerprint = /^a=fingerprint:sha-256 ([0-9A-F:]+)$/im.exec(sdp)?.[1];
  const setup = SETUP.indexOf(field(sdp, 'setup'));
  if (!ufrag || !pwd || !fingerprint || setup < 0) throw new Error('В описании нет нужного');

  const seen = new Set();
  const candidates = [];
  for (const [, line] of sdp.matchAll(/^a=candidate:(.+)$/gm)) {
    const [, component, protocol, , ip, port, , type] = line.trim().split(/\s+/);
    if (component !== '1' || protocol.toLowerCase() !== 'udp' || !TYPES.includes(type)) continue;
    const key = `${ip} ${port}`;
    if (seen.has(key)) continue;
    const address = addressBytes(ip);
    if (!address) continue;
    seen.add(key);
    candidates.push({type: TYPES.indexOf(type), address, port: Number(port)});
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  const text = s => new TextEncoder().encode(s);
  const parts = [
    Uint8Array.of(VERSION, setup),
    Uint8Array.of(text(ufrag).length),
    text(ufrag),
    Uint8Array.of(text(pwd).length),
    text(pwd),
    hexToBytes(fingerprint.replace(/:/g, '')),
    Uint8Array.of(candidates.length),
  ];
  for (const {type, address: [kind, bytes], port} of candidates) {
    parts.push(Uint8Array.of((type << 2) | kind), bytes, Uint8Array.of(port >> 8, port & 255));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return toBase64Url(out);
};

const fail = () => {
  throw new Error('Код испорчен или неполон');
};

export const isSlim = code => /^[A-Za-z0-9_-]+$/.test(code) && fromBase64Url(code.slice(0, 4))[0] === VERSION;

// Обратно — полное описание по шаблону канала данных. Шаблон один для
// Chrome, Firefox и Safari: строки в нём — те, что пишут они все.
export const slimUnpack = code => {
  if (!/^[A-Za-z0-9_-]+$/.test(String(code ?? ''))) fail();
  const bytes = fromBase64Url(code);
  let at = 0;
  const take = n => {
    if (at + n > bytes.length) fail();
    const slice = bytes.slice(at, at + n);
    at += n;
    return slice;
  };
  const [version, setupIndex] = take(2);
  if (version !== VERSION || !SETUP[setupIndex]) fail();
  const text = () => new TextDecoder().decode(take(take(1)[0]));
  const ufrag = text();
  const pwd = text();
  const fingerprint = [...take(32)].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
  const count = take(1)[0];
  const lines = [];
  for (let i = 0; i < count; i++) {
    const head = take(1)[0];
    const kind = head & 3;
    const type = TYPES[head >> 2];
    if (!type || !ADDRESS_LENGTH[kind]) fail();
    const ip = addressText(kind, take(ADDRESS_LENGTH[kind]));
    const [hi, lo] = take(2);
    const port = (hi << 8) | lo;
    // У адресов через сервер браузер ждёт «откуда» — настоящий нам не
    // нужен, связь проверяется по самому адресу.
    const related = type === 'host' ? '' : ' raddr 0.0.0.0 rport 0';
    lines.push(`a=candidate:${i + 1} 1 udp ${PRIORITY[type] - i} ${ip} ${port} typ ${type}${related}`);
  }
  if (at !== bytes.length) fail();

  const setup = SETUP[setupIndex];
  const sdp = [
    'v=0',
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...lines,
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
  return {type: setup === 'actpass' ? 'offer' : 'answer', sdp};
};
