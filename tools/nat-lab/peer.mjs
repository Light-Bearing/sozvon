// Одна сторона опыта. Умеет всё, что мы хотим проверить:
//   --сокетов N   сколько сокетов держим (веер с многих — главная надежда)
//   --веер W      ширина обстрела в портах
//   --база P      с какого порта обстреливать (по умолчанию — от замеров)
//   --ттл T       срок жизни пакетов веера: пройти свой транслятор и умереть
//                 по дороге, не испортив чужую таблицу
//   --стуков K    сколько раз постучать
//   --ждать МС    пауза перед веером (для опытов с порядком)
//
// Все сокеты живут от начала до конца: транслятор помнит отображение по
// внутреннему порту, и пересоздание сокета проверяло бы не то, что задумано.

import dgram from 'node:dgram';
import crypto from 'node:crypto';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';

const STUN = '172.30.2.10';
const STUN_PORTS = [3478, 3479, 3480, 3481];
const MAGIC = 0x2112a442;

const дов = (имя, поумолчанию) => {
  const i = process.argv.indexOf('--' + имя);
  return i < 0 ? поумолчанию : Number(process.argv[i + 1]);
};

const роль = process.argv[2];
const СОКЕТОВ = дов('сокетов', 1);
const ВЕЕР = дов('веер', 0);
const БАЗА = дов('база', 0);
const ТТЛ = дов('ттл', 0);
const СТУКОВ = дов('стуков', 20);
const ЖДАТЬ = дов('ждать', 0);

const пауза = ms => new Promise(r => setTimeout(r, ms));
const принято = [];

const завести = async () => {
  const s = dgram.createSocket('udp4');
  await new Promise(r => s.bind(0, r));
  const ждущие = new Map();
  s.on('message', (msg, from) => {
    if (msg.length >= 20 && msg.readUInt16BE(0) === 0x0101) {
      const ждёт = ждущие.get(msg.subarray(8, 20).toString('hex'));
      if (!ждёт) return;
      const port = msg.readUInt16BE(26) ^ (MAGIC >>> 16);
      const raw = (msg.readUInt32BE(28) ^ MAGIC) >>> 0;
      return ждёт({
        ip: [raw >>> 24 & 255, raw >>> 16 & 255, raw >>> 8 & 255, raw & 255].join('.'),
        port,
      });
    }
    принято.push(`${from.address}:${from.port} → ${msg.toString()}`);
    console.log('ПРИШЛО', from.address + ':' + from.port, msg.toString());
  });
  s.спросить = порт =>
    new Promise(resolve => {
      const tid = crypto.randomBytes(12);
      const buf = Buffer.alloc(20);
      buf.writeUInt16BE(0x0001, 0);
      buf.writeUInt32BE(MAGIC, 4);
      tid.copy(buf, 8);
      ждущие.set(tid.toString('hex'), resolve);
      setTimeout(() => resolve(null), 2500);
      s.send(buf, порт, STUN);
    });
  return s;
};

const ждатьФайл = async имя => {
  for (let i = 0; i < 300; i++) {
    if (existsSync(имя)) return JSON.parse(readFileSync(имя, 'utf8'));
    await пауза(100);
  }
  throw new Error('не дождался ' + имя);
};

const сокеты = [];
for (let i = 0; i < СОКЕТОВ; i++) сокеты.push(await завести());

// Замер: каждый сокет спрашивает все четыре сервера. Одинаковые внешние
// порты — отображение не зависит от получателя; разные — симметричный.
const мои = [];
for (const s of сокеты) {
  const порты = [];
  for (const p of STUN_PORTS) {
    const о = await s.спросить(p);
    if (о) {
      порты.push(о.port);
      мои.ip = о.ip;
    }
  }
  мои.push(порты);
}
const все = мои.flat();
const вид = мои.some(п => new Set(п).size > 1) ? 'симметричный' : 'обычный';
const моё = {ip: мои.ip, порты: мои, вид, низ: Math.min(...все), верх: Math.max(...все)};
console.log('Я', роль, JSON.stringify({вид, сокетов: СОКЕТОВ, окно: [моё.низ, моё.верх]}));

writeFileSync(`/work/${роль}.json`, JSON.stringify(моё));
const чужой = await ждатьФайл(`/work/${роль === 'a' ? 'b' : 'a'}.json`);
// Барьер: обе стороны стартуют примерно одновременно, как в настоящем ICE.
writeFileSync(`/work/готов-${роль}.json`, '{}');
await ждатьФайл(`/work/готов-${роль === 'a' ? 'b' : 'a'}.json`);

if (ЖДАТЬ) await пауза(ЖДАТЬ);

// Веер: с каждого сокета обстреливаем диапазон чужих портов. Пакеты туда
// не долетят — их дело открыть НАШ фильтр на обратный путь.
if (ВЕЕР > 0) {
  const база = БАЗА || чужой.низ;
  for (const s of сокеты) {
    if (ТТЛ) s.setTTL(ТТЛ);
    for (let i = 0; i < ВЕЕР; i++) s.send(Buffer.from('веер'), база + i, чужой.ip);
  }
  if (ТТЛ) for (const s of сокеты) s.setTTL(64);
  console.log('ВЕЕР', СОКЕТОВ, '×', ВЕЕР, 'от', база, 'до', база + ВЕЕР - 1, ТТЛ ? `ттл ${ТТЛ}` : '');
}

// Стук: с каждого сокета на каждый известный чужой порт, много раз.
const чужиеПорты = [...new Set(чужой.порты.flat())];
for (let k = 0; k < СТУКОВ; k++) {
  for (const [i, s] of сокеты.entries()) {
    for (const п of чужиеПорты) s.send(Buffer.from(`стук ${роль}${i}#${k}`), п, чужой.ip);
  }
  await пауза(300);
}

await пауза(2000);
console.log('ИТОГ', JSON.stringify({роль, принято: принято.length, первые: принято.slice(0, 3)}));
process.exit(0);
