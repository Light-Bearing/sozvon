// Перезагрузил страницу посреди разговора — вернулся, а не пропал.
//
// Живьём: собеседник перезагружал страницу, остальные видели «связь
// прервалась», призрачную плитку и табличку «прямого пути нет». Прощание
// с перезагружаемой вкладки не успевает уйти, а номер в сети после
// перезагрузки новый. Здесь двое в разговоре, второй перезагружается и
// входит снова: у первого должна быть строка «… снова в разговоре» с
// прежним именем, две плитки и ни одного призрака.
//
// Запуск: дев-сервер должен работать (npm run dev), затем
//   node tools/reload-check.mjs [адрес]

import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const PEOPLE = 2;
const APP = process.argv[2] ?? 'http://localhost:5180/';
const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9348;
const ВРЕМЯ_НА_СБОР = 90;

const ждать = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'sozvon-reload-'));
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
  return {ev, нажать, send};
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
const [a, b] = люди;
const имяДо = await a.ev(`document.querySelector('#tiles .tile:not([data-peer="self"]) .tile-name')?.textContent`);
await b.send('Page.reload', {});
const t0 = Date.now();
let joined = false;
const строки = new Set();
while (Date.now() - t0 < 25_000) {
  if (!joined) {
    const scr = await b.ev(`[...document.querySelectorAll('[id^=screen-]')].find(s => !s.hidden)?.id`);
    if (scr === 'screen-join' && (await b.ev(`Boolean(document.querySelector('#screen-join [data-name]')?.placeholder)`))) {
      await b.нажать('#join');
      joined = true;
    }
  }
  const r = JSON.parse(await a.ev(`JSON.stringify({notice: document.querySelector('#notice').hidden ? null : document.querySelector('#notice').textContent})`));
  if (r.notice) строки.add(r.notice);
  await ждать(500);
}
const вернулся = [...строки].find(x => /снова в разговоре$/.test(x));
отметить(Boolean(вернулся), 'перезагрузивший назван вернувшимся', [...строки].join(' | '));
отметить(Boolean(вернулся?.startsWith(имяДо ?? '?')), 'под прежним именем', имяДо ?? '');
const плиток = await a.ev(`document.querySelectorAll('#tiles .tile').length`);
отметить(плиток === 2, 'призрачной плитки не осталось', `плиток ${плиток}`);
отметить(
  (await a.ev(`document.querySelector('#trouble').hidden`)) === true,
  'табличка «прямого пути нет» не всплыла',
);

const провалов = итоги.filter(ok => !ok).length;
console.log(провалов ? `\nПровалено проверок: ${провалов} из ${итоги.length}` : `\nВсе ${итоги.length} проверок прошли`);
закончить(провалов ? 1 : 0);
