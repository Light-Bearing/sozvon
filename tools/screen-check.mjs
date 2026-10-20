// Показ экрана в разговоре: вошедший посреди показа видит экран, конец
// показа убирает плитку у всех, повторный показ возвращает её.
//
// Живьём сломалось и то и другое: вошедшему экран не приходил вовсе, а
// после конца показа плитка оставалась — заглохшая дорожка возвращала её.
//
// Запуск: дев-сервер должен работать (npm run dev), затем
//   node tools/screen-check.mjs [адрес]

import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const PEOPLE = 2;
const APP = process.argv[2] ?? 'http://localhost:5180/';
const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9349;
const ВРЕМЯ_НА_СБОР = 90;

const ждать = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'sozvon-mesh-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    '--use-fake-ui-for-media-stream',
    '--auto-accept-this-tab-capture',
    '--auto-select-desktop-capture-source=Entire screen',
    '--use-fake-device-for-media-stream',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    'about:blank',
  ],
  {stdio: 'ignore'},
);

// Упавшая проверка не должна оставлять Chrome на порту: следующий прогон
// молча подключился бы к нему, со старым состоянием.
const закончить = code => {
  chrome.kill();
  try {
    rmSync(profile, {recursive: true, force: true});
  } catch {}
  process.exit(code);
};
process.on('exit', () => chrome.kill());
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, error => {
    console.log(`✗ проверка упала сама: ${error?.message ?? error}`);
    закончить(2);
  });
}

let готов = false;
for (let i = 0; i < 40 && !готов; i++) {
  await ждать(250);
  готов = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false);
}
if (!готов) {
  console.log('✗ Chrome не поднялся');
  закончить(2);
}

const открыть = async url => {
  const t = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, {method: 'PUT'})
  ).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0;
  const waiting = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    Promise.race([
      new Promise(ok => {
        const mine = ++id;
        waiting.set(mine, ok);
        ws.send(JSON.stringify({id: mine, method, params}));
      }),
      new Promise(ok => setTimeout(() => ok({timeout: true}), 30000)),
    ]);
  const ev = async expression => {
    const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    return r.timeout ? undefined : r.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.navigate', {url});
  // Настоящее нажатие: без жеста человека браузер не пускает звук.
  const нажать = async selector => {
    const box = await ev(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return r ? {x: r.left + r.width / 2, y: r.top + r.height / 2} : null;
    })()`);
    if (!box) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {type, x: box.x, y: box.y, button: 'left', clickCount: 1});
    }
    return true;
  };
  return {ev, нажать};
};

const итоги = [];
const отметить = (ok, что, подробно = '') => {
  итоги.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${что}${подробно ? ` — ${подробно}` : ''}`);
};

// ── хозяин и гости по одной ссылке ──────────────────────────
const люди = [await открыть(`${APP}?_=${Date.now()}`)];
await ждать(2500);
await люди[0].нажать('#start');
await ждать(2500);
const ссылка = await люди[0].ev(`document.querySelector('#link')?.textContent`);
if (!ссылка) {
  отметить(false, 'хозяин не получил ссылку');
  закончить(1);
}
// Гости входят по очереди, как в жизни, а не все в одну секунду.
for (let i = 1; i < PEOPLE; i++) {
  const гость = await открыть(ссылка);
  await ждать(2500);
  await гость.нажать('#join');
  люди.push(гость);
  await ждать(1500);
}

const чужих = t => t.ev(`document.querySelectorAll('#tiles .tile:not([data-peer="self"])').length`);
const сколькихВидят = async () => Promise.all(люди.map(чужих));

let секунд = 0;
let видят = [];
while (секунд < ВРЕМЯ_НА_СБОР) {
  видят = await сколькихВидят();
  if (видят.every(n => n >= PEOPLE - 1)) break;
  await ждать(1000);
  секунд += 1;
}
const собрались = видят.every(n => n >= PEOPLE - 1);
отметить(
  собрались,
  `все ${PEOPLE} нашли друг друга`,
  собрались ? `за ~${секунд} с` : `у каждого плиток: ${видят.join(', ')} из ${PEOPLE - 1} за ${ВРЕМЯ_НА_СБОР} с`,
);


if (!собрались) закончить(1);
const [хозяин, первый] = люди;
await хозяин.нажать('#screen');
await ждать(4000);
const экранУ = t => t.ev(`(async () => { const tile = document.querySelector('#tiles .tile[data-peer$="|screen"]:not([data-peer^="self"])'); const v = tile?.querySelector('video'); const t0 = v?.currentTime ?? 0; await new Promise(r => setTimeout(r, 1200)); return JSON.stringify({плитка: Boolean(tile), ширина: v?.videoWidth ?? 0, идёт: (v?.currentTime ?? 0) > t0}); })()`);
const у1 = JSON.parse(await экранУ(первый));
отметить(у1.плитка && у1.ширина > 0 && у1.идёт, 'кто был в разговоре — видит экран');
const ссылка2 = await хозяин.ev(`document.querySelector('#link')?.textContent`);
const второй = await открыть(ссылка2);
await ждать(2500);
await второй.нажать('#join');
let вошёл = false;
for (let i = 0; i < 40 && !вошёл; i++) { await ждать(1000); вошёл = (await второй.ev(`document.querySelectorAll('#tiles .tile:not([data-peer="self"])').length`)) >= 2; }
await ждать(5000);
const у2 = JSON.parse(await экранУ(второй));
отметить(у2.плитка && у2.ширина > 0 && у2.идёт, 'вошедший во время показа видит экран');
await хозяин.нажать('#screen');
let ушла = false;
for (let i = 0; i < 16 && !ушла; i++) { await ждать(500); ушла = !JSON.parse(await экранУ(второй)).плитка; }
отметить(ушла, 'показ кончился — у вошедшего плитка экрана ушла');
отметить(!JSON.parse(await экранУ(первый)).плитка, 'и у того, кто был с начала, — тоже ушла');

await хозяин.нажать('#screen');
let снова = false;
for (let i = 0; i < 20 && !снова; i++) {
  await ждать(500);
  const a = JSON.parse(await экранУ(первый));
  const b = JSON.parse(await экранУ(второй));
  снова = a.плитка && a.ширина > 0 && b.плитка && b.ширина > 0;
}
отметить(снова, 'показ начали снова — экран вернулся у обоих');
const провалов = итоги.filter(ok => !ok).length;
console.log(провалов ? `\nПровалено проверок: ${провалов} из ${итоги.length}` : `\nВсе ${итоги.length} проверок прошли`);
закончить(провалов ? 1 : 0);
