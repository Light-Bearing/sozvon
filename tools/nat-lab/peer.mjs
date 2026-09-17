// Одна сторона опыта. Умеет всё, что мы хотим проверить:
//   --сокетов N   сколько сокетов держим (веер с многих — главная надежда)
//   --веер W      ширина обстрела в портах
//   --base P      с какого порта обстреливать (по умолчанию — от замеров)
//   --ттл T       срок жизни пакетов веера: пройти own транслятор и умереть
//                 по дороге, не испортив чужую таблицу
//   --стуков K    сколько раз постучать
//   --ждать МС    wait перед веером (для опытов с порядком)
//
// Все sockets живут от начала до конца: транслятор помнит отображение по
// внутреннему порту, и пересоздание сокета проверяло бы не то, что задумано.

import dgram from 'node:dgram';
import crypto from 'node:crypto';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';

const STUN = '172.30.2.10';
const STUN_PORTS = [3478, 3479, 3480, 3481];
const MAGIC = 0x2112a442;

const flag = (имя, поумолчанию) => {
  const i = process.argv.indexOf('--' + имя);
  return i < 0 ? поумолчанию : Number(process.argv[i + 1]);
};

const role = process.argv[2];
const СОКЕТОВ = flag('сокетов', 1);
const ВЕЕР = flag('веер', 0);
const БАЗА = flag('база', 0);
const ТТЛ = flag('ттл', 0);
const СТУКОВ = flag('стуков', 20);
const ЖДАТЬ = flag('ждать', 0);

const wait = ms => new Promise(r => setTimeout(r, ms));
const received = [];

const makeSocket = async () => {
  const s = dgram.createSocket('udp4');
  await new Promise(r => s.bind(0, r));
  const pending = new Map();
  s.on('message', (msg, from) => {
    if (msg.length >= 20 && msg.readUInt16BE(0) === 0x0101) {
      const waiter = pending.get(msg.subarray(8, 20).toString('hex'));
      if (!waiter) return;
      const port = msg.readUInt16BE(26) ^ (MAGIC >>> 16);
      const raw = (msg.readUInt32BE(28) ^ MAGIC) >>> 0;
      return waiter({
        ip: [raw >>> 24 & 255, raw >>> 16 & 255, raw >>> 8 & 255, raw & 255].join('.'),
        port,
      });
    }
    received.push(`${from.address}:${from.port} → ${msg.toString()}`);
    console.log('ПРИШЛО', from.address + ':' + from.port, msg.toString());
  });
  s.ask = port =>
    new Promise(resolve => {
      const tid = crypto.randomBytes(12);
      const buf = Buffer.alloc(20);
      buf.writeUInt16BE(0x0001, 0);
      buf.writeUInt32BE(MAGIC, 4);
      tid.copy(buf, 8);
      pending.set(tid.toString('hex'), resolve);
      setTimeout(() => resolve(null), 2500);
      s.send(buf, port, STUN);
    });
  return s;
};

const waitForFile = async имя => {
  for (let i = 0; i < 300; i++) {
    if (existsSync(имя)) return JSON.parse(readFileSync(имя, 'utf8'));
    await wait(100);
  }
  throw new Error('не дождался ' + имя);
};

const sockets = [];
for (let i = 0; i < СОКЕТОВ; i++) sockets.push(await makeSocket());

// Замер: каждый сокет спрашивает allPorts четыре сервера. Одинаковые внешние
// ports — отображение не зависит от получателя; разные — симметричный.
const mine = [];
for (const s of sockets) {
  const ports = [];
  for (const p of STUN_PORTS) {
    const answer = await s.ask(p);
    if (answer) {
      ports.push(answer.port);
      mine.ip = answer.ip;
    }
  }
  mine.push(ports);
}
const allPorts = mine.flat();
const kind = mine.some(п => new Set(п).size > 1) ? 'симметричный' : 'обычный';
const self = {ip: mine.ip, ports: mine, kind, низ: Math.min(...allPorts), верх: Math.max(...allPorts)};
console.log('Я', role, JSON.stringify({kind, сокетов: СОКЕТОВ, окно: [self.низ, self.верх]}));

writeFileSync(`/work/${role}.json`, JSON.stringify(self));
const peer = await waitForFile(`/work/${role === 'a' ? 'b' : 'a'}.json`);
// Барьер: обе стороны стартуют примерно одновременно, как в настоящем ICE.
writeFileSync(`/work/готов-${role}.json`, '{}');
await waitForFile(`/work/готов-${role === 'a' ? 'b' : 'a'}.json`);

if (ЖДАТЬ) await wait(ЖДАТЬ);

// Веер: с каждого сокета обстреливаем диапазон чужих портов. Пакеты туда
// не долетят — их дело открыть НАШ фильтр на обратный путь.
if (ВЕЕР > 0) {
  const base = БАЗА || peer.низ;
  for (const s of sockets) {
    if (ТТЛ) s.setTTL(ТТЛ);
    for (let i = 0; i < ВЕЕР; i++) s.send(Buffer.from('веер'), base + i, peer.ip);
  }
  if (ТТЛ) for (const s of sockets) s.setTTL(64);
  console.log('ВЕЕР', СОКЕТОВ, '×', ВЕЕР, 'от', base, 'до', base + ВЕЕР - 1, ТТЛ ? `ттл ${ТТЛ}` : '');
}

// Стук: с каждого сокета на каждый известный peer port, много раз.
const peerPorts = [...new Set(peer.ports.flat())];
for (let k = 0; k < СТУКОВ; k++) {
  for (const [i, s] of sockets.entries()) {
    for (const п of peerPorts) s.send(Buffer.from(`стук ${role}${i}#${k}`), п, peer.ip);
  }
  await wait(300);
}

await wait(2000);
console.log('ИТОГ', JSON.stringify({role, received: received.length, первые: received.slice(0, 3)}));
process.exit(0);
