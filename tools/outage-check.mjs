// Сеть пропала надолго и вернулась — разговор снова находим.
//
// Каналы сигнализации переподключаются с удвоением паузы и примерно через
// минуту без сети библиотека бросала их насовсем: после этого собеседники
// друг друга больше не находили, пока кто-нибудь не перезагрузит страницу.
// Здесь хозяин один в разговоре, у него на OUTAGE секунд гаснут все
// каналы (сокеты закрыты, новые не открываются), сеть возвращается — и
// новый гость должен его найти.
//
// Запуск: дев-сервер должен работать (npm run dev), затем
//   node tools/outage-check.mjs [адрес]      (OUTAGE=секунды, по умолчанию 100)

import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const APP = process.argv[2] ?? 'http://localhost:5180/';
const OUTAGE = Number(process.env.OUTAGE) || 100;
const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9358;
const ВРЕМЯ_НА_СБОР = 90;

const ждать = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'sozvon-outage-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    '--use-fake-ui-for-media-stream',
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
  await send('Network.enable');
  await send('Page.enable');
  // Все сокеты страницы — под рукой, чтобы погасить их разом, как при
  // пропавшей сети.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__сокеты = []; const WS = window.WebSocket;
      window.WebSocket = class extends WS { constructor(...a) { super(...a); window.__сокеты.push(this); } };
      window.__соединения = []; const PC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends PC { constructor(...a) { super(...a); window.__соединения.push(this); } };`,
  });
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
  return {ev, нажать, send};
};

const итоги = [];
const отметить = (ok, что, подробно = '') => {
  итоги.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${что}${подробно ? ` — ${подробно}` : ''}`);
};

const хозяин = await открыть(`${APP}?_=${Date.now()}`);
await ждать(3000);
await хозяин.нажать('#start');
await ждать(4000);
const ссылка = await хозяин.ev(`document.querySelector('#link')?.textContent`);
const живых = () => хозяин.ev(`window.__сокеты.filter(s => s.url.startsWith('wss:') && s.readyState === 1).length`);
console.log('каналов открыто до обрыва:', await живых());

await хозяин.send('Network.setBlockedURLs', {urls: ['wss://*']});
// Только каналы: служебный сокет дев-сервера (ws://) не трогаем — потеряв
// его, дев-сервер перезагрузил бы страницу.
await хозяин.ev(`window.__сокеты.filter(s => s.url.startsWith('wss:')).forEach(s => s.close()); 1`);
console.log(`сеть пропала на ${OUTAGE} с`);
await ждать(OUTAGE * 1000);
await хозяин.send('Network.setBlockedURLs', {urls: []});
console.log('сеть вернулась');

let ожили = 0;
for (let i = 0; i < 30 && ожили === 0; i++) {
  await ждать(1000);
  ожили = await живых();
}
отметить(ожили > 0, 'каналы хозяина ожили сами', `открыто ${ожили}`);

const гость = await открыть(ссылка);
await ждать(3000);
await гость.нажать('#join');
let нашёл = false;
for (let i = 0; i < 45 && !нашёл; i++) {
  await ждать(1000);
  нашёл = (await хозяин.ev(`document.querySelectorAll('#tiles .tile').length`)) >= 2;
}
отметить(нашёл, 'новый гость нашёл хозяина после долгого обрыва');

// Смена сети посреди разговора: у гостя рвутся все соединения и надолго
// пропадают каналы. Разговор должен собраться сам, без перезахода.
if (нашёл) {
  await гость.send('Network.setBlockedURLs', {urls: ['wss://*']});
  await гость.ev(`window.__сокеты.filter(s => s.url.startsWith('wss:')).forEach(s => s.close());
    window.__соединения.forEach(pc => pc.close()); 1`);
  let разошлись = false;
  for (let i = 0; i < 30 && !разошлись; i++) {
    await ждать(1000);
    разошлись = (await хозяин.ev(`document.querySelectorAll('#tiles .tile').length`)) < 2;
  }
  console.log(`у гостя сменилась сеть на ${Math.round(OUTAGE * 0.7)} с; хозяин заметил: ${разошлись}`);
  await ждать(OUTAGE * 700);
  await гость.send('Network.setBlockedURLs', {urls: []});
  let снова = false;
  let секунд = 0;
  for (; секунд < 60 && !снова; секунд++) {
    await ждать(1000);
    снова =
      (await хозяин.ev(`document.querySelectorAll('#tiles .tile').length`)) >= 2 &&
      (await гость.ev(`document.querySelectorAll('#tiles .tile').length`)) >= 2;
  }
  отметить(снова, 'после смены сети разговор собрался сам, без перезахода', снова ? `за ~${секунд} с` : 'за 60 с не собрался');
}

const провалов = итоги.filter(ok => !ok).length;
console.log(провалов ? `\nПровалено проверок: ${провалов} из ${итоги.length}` : `\nВсе ${итоги.length} проверок прошли`);
закончить(провалов ? 1 : 0);
