// Настоящий разговор нескольких человек: все видят и слышат всех.
//
// call-check проверяет двоих, а чаще всего ломалось, когда людей больше:
// кто-то видел всех, а две пары друг друга не видели. Здесь N вкладок одного
// безголового Chrome с поддельной камерой и микрофоном входят по одной
// ссылке, включают камеру со звуком — и у каждой должны быть живые плитки
// всех остальных.
//
// Запуск: дев-сервер должен работать (npm run dev), затем
//   node tools/mesh-check.mjs [людей=4] [адрес]
// Нужны публичные каналы: люди находят друг друга через них, как в жизни.

import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const PEOPLE = Math.max(3, Number(process.argv[2]) || 4);
const APP = process.argv[3] ?? 'http://localhost:5180/';
const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9340;
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

if (собрались) {
  // Камера и микрофон — уже внутри разговора, на пути, где дорожки
  // однажды не доходили до экрана.
  for (const человек of люди) {
    await человек.нажать('#cam');
    await человек.нажать('#mic');
  }
  await ждать(8000);

  for (let i = 0; i < люди.length; i++) {
    const увиденное = await люди[i].ev(`(async () => {
      const чужие = [...document.querySelectorAll('#tiles .tile:not([data-peer="self"])')];
      const t0 = чужие.map(t => t.querySelector('video')?.currentTime ?? 0);
      await new Promise(r => setTimeout(r, 1500));
      return чужие.map((t, k) => {
        const видео = t.querySelector('video');
        const дорожка = t.querySelector('audio')?.srcObject?.getAudioTracks?.()[0];
        return {
          картинка: (видео?.videoWidth ?? 0) > 0 && (видео?.currentTime ?? 0) > t0[k],
          звук: Boolean(дорожка && дорожка.readyState === 'live'),
        };
      });
    })()`);
    const всеКартинки = увиденное?.length === PEOPLE - 1 && увиденное.every(x => x.картинка);
    const всеЗвуки = увиденное?.length === PEOPLE - 1 && увиденное.every(x => x.звук);
    const имя = i === 0 ? 'хозяин' : `гость ${i}`;
    отметить(всеКартинки, `${имя} видит движущуюся картинку каждого из ${PEOPLE - 1}`,
      всеКартинки ? '' : `картинок: ${увиденное?.filter(x => x.картинка).length ?? 0}`);
    отметить(всеЗвуки, `${имя} получает звук каждого`,
      всеЗвуки ? '' : `звуков: ${увиденное?.filter(x => x.звук).length ?? 0}`);
  }
}

const провалов = итоги.filter(ok => !ok).length;
console.log(провалов ? `\nПровалено проверок: ${провалов} из ${итоги.length}` : `\nВсе ${итоги.length} проверок прошли`);
закончить(провалов ? 1 : 0);
