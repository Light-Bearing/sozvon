// Одна сторона опыта. Обе стороны работают ОДНИМ сокетом от начала до
// конца: транслятор запоминает отображение по внутреннему порту, и стоит
// завести второй сокет — опыт проверяет не то, что задумано.
//
//   node peer.mjs a <ширина веера>   — сторона за обычным домашним NAT
//   node peer.mjs b                  — сторона за симметричным
//
// Договариваются через файлы в /work: сети между ними, кроме «интернета»,
// нет, а канал рукопожатия в этом опыте не проверяется.

import dgram from 'node:dgram';
import crypto from 'node:crypto';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';

const STUN = '172.30.0.10';
const STUN_PORTS = [3478, 3479, 3480, 3481];
const MAGIC = 0x2112a442;

const [, , роль, шириной = '0', ЛАД = 'up'] = process.argv;
const ШИРИНА = Number(шириной);

const socket = dgram.createSocket('udp4');
await new Promise(r => socket.bind(0, r));

const ждущие = new Map();
const принято = [];

socket.on('message', (msg, from) => {
  if (msg.length >= 20 && msg.readUInt16BE(0) === 0x0101) {
    const ключ = msg.subarray(8, 20).toString('hex');
    const ждёт = ждущие.get(ключ);
    if (!ждёт) return;
    ждущие.delete(ключ);
    const port = msg.readUInt16BE(26) ^ (MAGIC >>> 16);
    const raw = (msg.readUInt32BE(28) ^ MAGIC) >>> 0;
    const ip = [raw >>> 24 & 255, raw >>> 16 & 255, raw >>> 8 & 255, raw & 255].join('.');
    return ждёт({ip, port});
  }
  принято.push({от: `${from.address}:${from.port}`, что: msg.toString()});
  console.log('ПРИШЛО от', from.address + ':' + from.port, '—', msg.toString());
});

const спросить = порт =>
  new Promise(resolve => {
    const tid = crypto.randomBytes(12);
    const buf = Buffer.alloc(20);
    buf.writeUInt16BE(0x0001, 0);
    buf.writeUInt32BE(MAGIC, 4);
    tid.copy(buf, 8);
    ждущие.set(tid.toString('hex'), resolve);
    setTimeout(() => resolve(null), 2000);
    socket.send(buf, порт, STUN);
  });

const пауза = ms => new Promise(r => setTimeout(r, ms));

const ждатьФайл = async имя => {
  for (let i = 0; i < 200; i++) {
    if (existsSync(имя)) return JSON.parse(readFileSync(имя, 'utf8'));
    await пауза(100);
  }
  throw new Error('не дождался ' + имя);
};

// Замер: один сокет, четыре разных получателя. Одинаковые внешние порты —
// отображение не зависит от получателя (домашний случай). Разные —
// симметричный.
const замер = [];
for (const порт of STUN_PORTS) замер.push(await спросить(порт));
const порты = замер.filter(Boolean).map(з => з.port);
const вид = new Set(порты).size > 1 ? 'симметричный' : 'обычный';
const мой = {ip: замер.find(Boolean).ip, порты, вид};
console.log('МОЙ ВНЕШНИЙ', JSON.stringify(мой));

if (роль === 'b') {
  writeFileSync('/work/b.json', JSON.stringify(мой));
  const a = await ждатьФайл('/work/a.json');
  await ждатьФайл('/work/go.json');
  // Пишем на известный внешний адрес собеседника — ровно то, что делает
  // ICE. Транслятор выдаст на это новый порт, которого А не знает.
  // Стучим ПЕРВЫМИ и повторяем. Первый стук создаёт отображение в нашем
  // трансляторе и умирает на чужом фильтре — его дело закрепить за нами
  // порт. Дальше А раскрывает веер, и следующий стук уже проходит.
  //
  // Порядок здесь принципиален: если веер раскрыть раньше, чужие пакеты
  // займут порты в нашей таблице, и транслятор выдаст нам порт ВНЕ веера.
  // Именно это и происходило, пока стучали вторыми.
  for (let i = 0; i < 16; i++) {
    socket.send(Buffer.from('привет от Б #' + i), a.порты[0], a.ip);
    await пауза(400);
  }
  console.log('ОТСТУЧАЛ 16 раз на', a.ip + ':' + a.порты[0]);
} else {
  writeFileSync('/work/a.json', JSON.stringify(мой));
  const b = await ждатьФайл('/work/b.json');
  // Куда целить веер. «up» — вверх от последнего замера: так ведут себя
  // трансляторы со счётчиком, а их большинство. «around» — вокруг всего
  // замеченного облака: так приходится, когда порт берётся случайно из
  // окна, и по четырём замерам границ окна не узнать.
  const низ = Math.min(...b.порты);
  const верх = Math.max(...b.порты);
  const база = ЛАД === 'around'
    ? Math.max(1024, низ - Math.floor(ШИРИНА / 2))
    : верх + 1;
  // Ширина -1 — не слать вообще ничего. Нужна, чтобы увидеть, какой порт
  // выберет транслятор собеседника, когда мы его ничем не тревожим.
  const цели = ШИРИНА < 0
    ? []
    : ШИРИНА > 0
      ? Array.from({length: ШИРИНА}, (_, i) => база + i)
      : [b.порты.at(-1)];
  // Веер: пишем на весь предполагаемый диапазон. Пакеты до Б не дойдут —
  // их дело открыть НАШ фильтр на обратный путь.
  // Сначала отпускаем Б стучать, и только потом раскрываем веер: его
  // первый стук должен закрепить за ним порт ДО того, как мы займём
  // диапазон своими пакетами.
  writeFileSync('/work/go.json', '{}');
  await пауза(1200);
  for (const порт of цели) socket.send(Buffer.from('веер'), порт, b.ip);
  console.log('ВЕЕР', цели.length, 'портов', цели.length ? `от ${цели[0]} до ${цели.at(-1)}` : '(ничего не шлём)');
  await пауза(7000);
}

console.log('ИТОГ', JSON.stringify({роль, принято: принято.length, принято_от: принято}));
process.exit(0);
