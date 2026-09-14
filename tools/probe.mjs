// Пробник сети для P2P-звонков.
// Отвечает на два вопроса: встанет ли прямое соединение (тип NAT)
// и через что можно передать рукопожатие (доступность публичных каналов).

import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import os from 'node:os';

const MAGIC = 0x2112a442;

const STUN_SERVERS = [
  ['stun.l.google.com', 19302],
  ['stun1.l.google.com', 19302],
  ['stun.cloudflare.com', 3478],
  ['stun.nextcloud.com', 3478],
  ['stun.miwifi.com', 3478],
  ['stun.sipnet.net', 3478],
];

const WS_TARGETS = [
  ['торрент-трекер', 'wss://tracker.openwebtorrent.com'],
  ['торрент-трекер', 'wss://tracker.webtorrent.dev'],
  ['торрент-трекер', 'wss://tracker.btorrent.xyz'],
  ['торрент-трекер', 'wss://tracker.files.fm:7073/announce'],
  ['nostr-релей', 'wss://relay.damus.io'],
  ['nostr-релей', 'wss://nos.lol'],
  ['nostr-релей', 'wss://relay.nostr.band'],
  ['nostr-релей', 'wss://relay.snort.social'],
  ['mqtt-брокер', 'wss://broker.emqx.io:8084/mqtt'],
  ['mqtt-брокер', 'wss://test.mosquitto.org:8081/mqtt'],
  ['mqtt-брокер', 'wss://broker.hivemq.com:8884/mqtt'],
];

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

function tryWs(url, timeout = 7000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let ws;
    const done = (ok, note) => {
      try { ws && ws.close(); } catch {}
      resolve({ ok, ms: Date.now() - started, note });
    };
    const timer = setTimeout(() => done(false, 'молчит'), timeout);
    try { ws = new WebSocket(url); } catch (e) { clearTimeout(timer); return done(false, e.message); }
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

  console.log('\n=== 2. Публичные каналы для рукопожатия ===\n');
  const wsResults = await Promise.all(WS_TARGETS.map(async ([kind, url]) => {
    const r = await tryWs(url);
    return { kind, url, ...r };
  }));
  for (const r of wsResults) {
    const mark = r.ok ? '✓' : '✗';
    const tail = r.ok ? `${r.ms} мс` : r.note;
    console.log(`  ${mark} ${r.kind.padEnd(16)} ${r.url.padEnd(46)} ${tail}`);
  }

  const byKind = {};
  for (const r of wsResults) (byKind[r.kind] ||= []).push(r.ok);
  console.log('');
  for (const [kind, arr] of Object.entries(byKind)) {
    const n = arr.filter(Boolean).length;
    console.log(`  ${kind}: живых ${n} из ${arr.length}`);
  }
  const alive = wsResults.filter((r) => r.ok).length;
  const kindsAlive = Object.values(byKind).filter((a) => a.some(Boolean)).length;
  console.log('');
  console.log(`  ИТОГ: живых каналов ${alive}, независимых семейств ${kindsAlive} из ${Object.keys(byKind).length}.`);
})();
