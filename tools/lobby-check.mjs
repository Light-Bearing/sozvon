// Комната ожидания: ждущему не уходит ничего, впустили — всё как обычно.
//
// Хозяин создаёт разговор с галкой «впускать по разрешению» и включает
// камеру со звуком. Гость входит — и, пока его не впустили, ему не должно
// прийти ни байта картинки и звука (проверяется по статистике соединений,
// а не по спрятанной плитке). Хозяин видит просьбу, впускает — гость видит и
// слышит хозяина. Третьему отказывают — он видит «вас не впустили».
//
// Запуск: дев-сервер должен работать (npm run dev), затем
//   node tools/lobby-check.mjs [адрес]

import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const APP = process.argv[2] ?? 'http://localhost:5180/';
const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9359;
const ВРЕМЯ_НА_СБОР = 90;

const ждать = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'sozvon-lobby-'));
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
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__соединения = []; const PC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends PC { constructor(...a) { super(...a); window.__соединения.push(this); } };`,
  });
  await send('Page.navigate', {url});
  // Настоящее нажатие: без жеста человека браузер не пускает звук.
  const нажать = async selector => {
    const box = await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el?.scrollIntoView({block: 'center', inline: 'center'});
      const r = el?.getBoundingClientRect();
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

const пришло = t => t.ev(`(async () => {
  let видео = 0, звук = 0;
  for (const pc of window.__соединения) {
    if (pc.connectionState === 'closed') continue;
    (await pc.getStats()).forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') видео += r.bytesReceived ?? 0;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') звук += r.bytesReceived ?? 0;
    });
  }
  return JSON.stringify({видео, звук});
})()`);
const экранГотов = async (t, экран) => {
  for (let i = 0; i < 40; i++) {
    if (await t.ev(`(() => { const e = document.querySelector('#screen-${экран}'); return Boolean(e && !e.hidden && e.querySelector('[data-name]')?.placeholder); })()`)) return;
    await ждать(250);
  }
};

const хозяин = await открыть(`${APP}?_=${Date.now()}`);
await экранГотов(хозяин, 'start');
await хозяин.ev(`document.querySelector('#lobby-start').checked = true; document.querySelector('#lobby-start').dispatchEvent(new Event('change')); 1`);
await хозяин.нажать('#start');
await ждать(2500);
await хозяин.нажать('#cam');
await хозяин.нажать('#mic');
const ссылка = await хозяин.ev(`document.querySelector('#link')?.textContent`);

const гость = await открыть(ссылка);
await экранГотов(гость, 'join');
await гость.ev(`(() => { const i = document.querySelector('#screen-join [data-name]'); i.value = 'Маша'; i.dispatchEvent(new Event('input')); return 1; })()`);
await гость.нажать('#join');

let просится = false;
for (let i = 0; i < 40 && !просится; i++) {
  await ждать(1000);
  просится = /Маша хочет войти/.test((await хозяин.ev(`document.querySelector('#knock')?.hidden ? '' : document.querySelector('#knock-list')?.textContent`)) ?? '');
}
отметить(просится, 'хозяин видит: «Маша хочет войти»');
await ждать(6000);
отметить((await гость.ev(`!document.querySelector('#lobby-wait').hidden`)) === true, 'гость видит «ждём, когда вас впустят»');
const доВпуска = JSON.parse((await пришло(гость)) ?? '{}');
отметить(доВпуска.видео === 0 && доВпуска.звук === 0, 'ждущему не пришло ни байта картинки и звука', JSON.stringify(доВпуска));
отметить((await хозяин.ev(`document.querySelectorAll('#tiles .tile').length`)) === 1, 'у хозяина плитки ждущего нет');

await хозяин.нажать('#knock-list .act--primary');
let видит = false;
for (let i = 0; i < 30 && !видит; i++) {
  await ждать(1000);
  видит = (await гость.ev(`(async () => {
    const v = document.querySelector('#tiles .tile:not([data-peer="self"]) video');
    const t0 = v?.currentTime ?? 0;
    await new Promise(r => setTimeout(r, 800));
    return (v?.videoWidth ?? 0) > 0 && (v?.currentTime ?? 0) > t0 && document.querySelector('#lobby-wait').hidden;
  })()`)) === true;
}
отметить(видит, 'впустили — гость видит движущуюся картинку хозяина');
const послеВпуска = JSON.parse((await пришло(гость)) ?? '{}');
отметить(послеВпуска.звук > 0, 'и звук хозяина до него дошёл', JSON.stringify(послеВпуска));
отметить((await хозяин.ev(`document.querySelectorAll('#tiles .tile').length`)) === 2, 'у хозяина появилась плитка гостя');

const третий = await открыть(ссылка);
await экранГотов(третий, 'join');
await третий.нажать('#join');
let третийПросится = false;
for (let i = 0; i < 40 && !третийПросится; i++) {
  await ждать(1000);
  третийПросится = (await хозяин.ev(`document.querySelectorAll('#knock-list li').length`)) === 1;
}
// Гость уже впущен — он тоже видит просьбу и тоже мог бы впустить.
отметить((await гость.ev(`document.querySelectorAll('#knock-list li').length`)) === 1, 'впущенный гость тоже видит, кто просится');
await хозяин.нажать('#knock-list .act:not(.act--primary)');
let отказ = false;
for (let i = 0; i < 15 && !отказ; i++) {
  await ждать(1000);
  отказ = (await третий.ev(`document.querySelector('#lobby-wait-title')?.textContent`)) === 'Вас не впустили';
}
отметить(отказ, 'третьему отказали — он видит «вас не впустили»');
const уТретьего = JSON.parse((await пришло(третий)) ?? '{}');
отметить(уТретьего.видео === 0 && уТретьего.звук === 0, 'и ему не пришло ни байта', JSON.stringify(уТретьего));

const провалов = итоги.filter(ok => !ok).length;
console.log(провалов ? `\nПровалено проверок: ${провалов} из ${итоги.length}` : `\nВсе ${итоги.length} проверок прошли`);
закончить(провалов ? 1 : 0);
