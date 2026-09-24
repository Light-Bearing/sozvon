// Пробник сети для P2P-звонков.
// Отвечает на два вопроса: встанет ли прямое соединение (тип NAT)
// и через что можно передать рукопожатие (доступность публичных каналов).

import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import os from 'node:os';

const MAGIC = 0x2112a442;

// --channels: только публичные каналы, без STUN. Так пробник гоняет сторож
// на GitHub (.github/workflows/channels.yml): тип NAT машины в дата-центре
// никому не интересен, а живы ли каналы — интересен всем.
const CHANNELS_ONLY = process.argv.includes('--channels');

const STUN_SERVERS = [
  ['stun.l.google.com', 19302],
  ['stun1.l.google.com', 19302],
  ['stun.cloudflare.com', 3478],
  ['stun.nextcloud.com', 3478],
  ['stun.miwifi.com', 3478],
  ['stun.sipnet.net', 3478],
];

// Каналы берём из самого приложения, а не держим свой список. Свой был, и
// он разошёлся с приложением: пробник годами мерил одни адреса, пока
// приложение ходило в другие, и живые каналы, которыми пользовались люди,
// не проверял ни разу.
const FAMILIES = [
  ['nostr', 'nostr-релей'],
  ['mqtt', 'mqtt-брокер'],
];

// mqtt поверх WebSocket обязан объявлять подпротокол «mqtt»: без него
// mosquitto и emqx рвут соединение сразу. Пробник, открывавший их без
// подпротокола, записывал живые брокеры в мёртвые — а приложение, которое
// подпротокол ставит, всё это время ими исправно пользовалось.
const SUBPROTOCOL = {mqtt: 'mqtt'};

// Одна неудача ничего не значит: снятый на миг релей отвечает со второго
// раза. Мёртвым считаем только то, что не ответило ни разу из стольких.
const ATTEMPTS = 2;

function bindingRequest() {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(MAGIC, 4);
  const tid = crypto.randomBytes(12);
  tid.copy(buf, 8);
  return { buf, tid };
}

function parseMapped(msg, tid) {
  if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101) return null;
  if (!msg.subarray(8, 20).equals(tid)) return null;
  const end = Math.min(20 + msg.readUInt16BE(2), msg.length);
  let off = 20, found = null;
  while (off + 4 <= end) {
    const type = msg.readUInt16BE(off);
    const len = msg.readUInt16BE(off + 2);
    const val = msg.subarray(off + 4, off + 4 + len);
    if (type === 0x0020 && val.length >= 8 && val.readUInt8(1) === 1) {
      const port = val.readUInt16BE(2) ^ (MAGIC >>> 16);
      const raw = val.readUInt32BE(4) ^ MAGIC;
      found = { ip: [raw >>> 24 & 255, raw >>> 16 & 255, raw >>> 8 & 255, raw & 255].join('.'), port };
      break;
    }
    if (type === 0x0001 && val.length >= 8 && val.readUInt8(1) === 1 && !found) {
      found = { ip: Array.from(val.subarray(4, 8)).join('.'), port: val.readUInt16BE(2) };
    }
    off += 4 + len + ((4 - (len % 4)) % 4);
  }
  return found;
}

function askStun(sock, ip, port, timeout = 2500) {
  return new Promise((resolve) => {
    const { buf, tid } = bindingRequest();
    const timer = setTimeout(() => { sock.off('message', onMsg); resolve(null); }, timeout);
    function onMsg(msg, rinfo) {
      if (rinfo.address !== ip) return;
      const mapped = parseMapped(msg, tid);
      if (!mapped) return;
      clearTimeout(timer);
      sock.off('message', onMsg);
      resolve(mapped);
    }
    sock.on('message', onMsg);
    sock.send(buf, port, ip, (err) => {
      if (err) { clearTimeout(timer); sock.off('message', onMsg); resolve(null); }
    });
  });
}

function tryWs(url, protocol, timeout = 7000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let ws;
    const done = (ok, note) => {
      try { ws && ws.close(); } catch {}
      resolve({ ok, ms: Date.now() - started, note });
    };
    const timer = setTimeout(() => done(false, 'молчит'), timeout);
    try { ws = protocol ? new WebSocket(url, protocol) : new WebSocket(url); }
    catch (e) { clearTimeout(timer); return done(false, e.message); }
    ws.onopen = () => { clearTimeout(timer); done(true, ''); };
    ws.onerror = (e) => { clearTimeout(timer); done(false, (e && e.message) || 'отказ'); };
    ws.onclose = (e) => { clearTimeout(timer); if (Date.now() - started < timeout) done(false, `закрыт ${e.code || ''}`.trim()); };
  });
}

function localIPv4() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || [])
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
}

(async () => {
  if (!CHANNELS_ONLY) await probeStun();

  await probeChannels();
})();

async function probeStun() {
  console.log('=== 1. STUN: виден ли я снаружи и какой у меня NAT ===\n');

  const resolved = [];
  for (const [host, port] of STUN_SERVERS) {
    try {
      const [ip] = await dns.resolve4(host);
      if (ip && !resolved.some((r) => r.ip === ip)) resolved.push({ host, ip, port });
    } catch { console.log(`  ${host} — имя не разрешается`); }
  }
  console.log(`  Разных адресов STUN получено: ${resolved.length}\n`);

  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, r));
  const localPort = sock.address().port;
  const localIp = localIPv4();
  console.log(`  Локально: ${localIp}:${localPort}\n`);

  const results = [];
  for (const s of resolved) {
    const m = await askStun(sock, s.ip, s.port);
    results.push({ ...s, mapped: m });
    console.log(m ? `  ✓ ${s.host.padEnd(24)} видит меня как ${m.ip}:${m.port}`
                  : `  ✗ ${s.host.padEnd(24)} не ответил`);
  }
  sock.close();

  const good = results.filter((r) => r.mapped);
  console.log('');
  if (good.length === 0) {
    console.log('  ИТОГ: ни один STUN не ответил. Похоже, UDP наружу закрыт.');
    console.log('        Прямое P2P в этой сети не построится вообще.');
  } else if (good.length === 1) {
    console.log('  ИТОГ: ответил только один сервер — типа NAT не определить.');
  } else {
    const ips = new Set(good.map((r) => r.mapped.ip));
    const ports = new Set(good.map((r) => r.mapped.port));
    console.log(`  Внешний адрес: ${[...ips].join(', ')}`);
    console.log(`  Внешние порты: ${[...ports].join(', ')}`);
    console.log('');
    if (good[0].mapped.ip === localIp) {
      console.log('  ИТОГ: NAT нет, адрес публичный. Соединения будут вставать всегда.');
    } else if (ips.size === 1 && ports.size === 1) {
      console.log('  ИТОГ: порт снаружи один и тот же для разных собеседников.');
      console.log('        Это «дружелюбный» NAT — прямое P2P будет работать.');
    } else if (ips.size === 1) {
      console.log('  ИТОГ: порт снаружи МЕНЯЕТСЯ от собеседника к собеседнику.');
      console.log('        Это симметричный NAT — прямое соединение с таким же');
      console.log('        собеседником не встанет, нужен ретранслятор.');
    } else {
      console.log('  ИТОГ: внешний адрес плавает — вероятно, несколько выходов в интернет.');
    }
  }

}

async function probeChannels() {
  console.log('\n=== 2. Публичные каналы для рукопожатия ===\n');
  const {candidatesFor, relayUrlsFor} = await import('../src/signal/relays.js');

  const tryHard = async (url, protocol) => {
    let last;
    for (let i = 0; i < ATTEMPTS; i++) {
      last = await tryWs(url, protocol);
      if (last.ok) return last;
    }
    return last;
  };

  let aliveInUse = 0;
  let inUse = 0;
  const summaryLines = ['## Публичные каналы «Созвона»', ''];
  const familiesAlive = [];
  for (const [family, label] of FAMILIES) {
    const used = new Set(relayUrlsFor(family));
    const all = candidatesFor(family);
    const results = await Promise.all(
      all.map(async (url) => ({url, used: used.has(url), ...(await tryHard(url, SUBPROTOCOL[family]))})),
    );

    console.log(`  ${label} — приложение держит ${used.size} из ${all.length} кандидатов:`);
    for (const r of results.filter((x) => x.used)) {
      console.log(`    ${r.ok ? '✓' : '✗'} ${r.url.padEnd(46)} ${r.ok ? `${r.ms} мс` : r.note}`);
    }
    const spare = results.filter((x) => !x.used && x.ok).sort((a, b) => a.ms - b.ms);
    const deadSpare = results.filter((x) => !x.used && !x.ok).length;
    console.log(`    запасных живых: ${spare.length}, запасных мёртвых: ${deadSpare}`);
    if (spare.length) console.log(`    самые быстрые запасные: ${spare.slice(0, 3).map((x) => x.url).join(', ')}`);
    console.log('');

    summaryLines.push(`### ${label}`, '', '| | канал | ответ |', '|---|---|---|');
    for (const r of results.filter((x) => x.used)) {
      summaryLines.push(`| ${r.ok ? '✓' : '✗'} | \`${r.url}\` | ${r.ok ? `${r.ms} мс` : r.note} |`);
    }
    summaryLines.push('', `Запасных живых: ${spare.length}` + (spare.length ? ` — самые быстрые: ${spare.slice(0, 3).map((x) => `\`${x.url}\``).join(', ')}` : ''), '');

    const aliveHere = results.filter((x) => x.used && x.ok).length;
    aliveInUse += aliveHere;
    inUse += used.size;
    if (aliveHere) familiesAlive.push(family);
  }

  console.log(`  ИТОГ: из каналов, которыми пользуется приложение, живых ${aliveInUse} из ${inUse};`);
  console.log(`        семейств, в которых есть хоть один живой, — ${familiesAlive.length} из ${FAMILIES.length}.`);
  if (aliveInUse < inUse) {
    console.log('        Мёртвые стоит заменить на быстрые запасные — список в src/signal/relays.js.');
  }

  // Мёртвый канал среди тех, которыми пользуется приложение, — провал:
  // сторож на GitHub покраснеет, и хозяину придёт письмо.
  if (aliveInUse < inUse) process.exitCode = 1;

  if (process.env.GITHUB_STEP_SUMMARY) {
    const {appendFileSync} = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLines.join('\n') + '\n');
  }
}
