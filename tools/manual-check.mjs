// Разговор без публичных каналов: обмен кодами вручную.
//
// Обе вкладки не могут открыть ни одного канала — все защищённые сокеты
// наружу заблокированы, как в сети, где их режет провайдер. Хозяин
// переходит на обмен вручную, гость открывает его ссылку и отдаёт ответ,
// хозяин вставляет ответ — и дальше обычный разговор: картинка, звук,
// включение камеры посреди разговора, уход.
//
// Запуск: дев-сервер должен работать (npm run dev), затем
//   node tools/manual-check.mjs [адрес]

import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const APP = process.argv[2] ?? 'http://localhost:5180/';
const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9342;

const ждать = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'sozvon-hand-'));
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
  // Ни одного публичного канала: все они — защищённые сокеты наружу.
  await send('Network.enable');
  await send('Network.setBlockedURLs', {urls: ['wss://*']});
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


const плиток = t => t.ev(`document.querySelectorAll('#tiles .tile').length`);
const ссылкаИз = t => t.ev(`document.querySelector('#link')?.textContent`);
const дождаться = async (условие, секунд) => {
  for (let i = 0; i < секунд * 2; i++) {
    if (await условие()) return true;
    await ждать(500);
  }
  return false;
};

const хозяин = await открыть(`${APP}?_=${Date.now()}`);
await ждать(2500);
await хозяин.нажать('#start');
await ждать(1500);
// Кнопка появляется, когда каналы помолчат двадцать секунд, — не ждём их.
await хозяин.ev(`document.querySelector('#by-hand').click()`);
const естьСсылка = await дождаться(async () => /#m\./.test((await ссылкаИз(хозяин)) ?? ''), 15);
const ссылка = await ссылкаИз(хозяин);
отметить(естьСсылка, 'хозяин получил ссылку для обмена вручную', естьСсылка ? `${ссылка.length} знаков` : (ссылка ?? 'пусто'));
отметить(
  (await хозяин.ev(`!document.querySelector('#answer').hidden`)) === true,
  'у хозяина есть поле для ответа',
);
if (!естьСсылка) закончить(1);

const гость = await открыть(ссылка);
await ждать(2500);
await гость.нажать('#join');
const естьОтвет = await дождаться(async () => /^[A-Za-z0-9_-]{40,}$/.test((await ссылкаИз(гость)) ?? ''), 15);
const ответ = await ссылкаИз(гость);
отметить(естьОтвет, 'гость получил код ответа', естьОтвет ? `${ответ.length} знаков` : (ответ ?? 'пусто'));
if (!естьОтвет) закончить(1);

// Вставляем, как человек: с приветствием вокруг кода.
await хозяин.ev(`(() => {
  const поле = document.querySelector('#answer-text');
  поле.value = 'Привет! Вот мой ответ: ${ответ} — жду';
  document.querySelector('#answer-go').click();
})()`);
const соединились = await дождаться(async () => (await плиток(хозяин)) >= 2 && (await плиток(гость)) >= 2, 30);
отметить(соединились, 'соединились без единого канала');
отметить(
  (await хозяин.ev(`document.querySelector('#answer-error').hidden`)) === true,
  'ответ с приветствием вокруг принят',
);

if (соединились) {
  for (const человек of [хозяин, гость]) {
    await человек.нажать('#cam');
    await человек.нажать('#mic');
  }
  await ждать(6000);
  for (const [имя, t] of [['хозяин', хозяин], ['гость', гость]]) {
    const увиденное = await t.ev(`(async () => {
      const чужая = document.querySelector('#tiles .tile:not([data-peer="self"])');
      const видео = чужая?.querySelector('video');
      const t0 = видео?.currentTime ?? 0;
      await new Promise(r => setTimeout(r, 1500));
      const дорожка = чужая?.querySelector('audio')?.srcObject?.getAudioTracks?.()[0];
      return {
        картинка: (видео?.videoWidth ?? 0) > 0 && (видео?.currentTime ?? 0) > t0,
        звук: Boolean(дорожка && дорожка.readyState === 'live'),
        имя: чужая?.querySelector('.tile-name')?.textContent ?? '',
      };
    })()`);
    отметить(увиденное?.картинка === true, `${имя} видит движущуюся картинку собеседника`);
    отметить(увиденное?.звук === true, `${имя} получает звук собеседника`);
    отметить(Boolean(увиденное?.имя) && увиденное.имя !== 'собеседник', `${имя} видит имя собеседника`, увиденное?.имя);
  }

  // Выключил камеру — у собеседника плитка темнеет, а не держит последний кадр.
  await хозяин.нажать('#cam');
  const потемнела = await дождаться(
    async () => (await гость.ev(`document.querySelector('#tiles .tile:not([data-peer="self"])')?.classList.contains('tile--dark')`)) === true,
    5,
  );
  отметить(потемнела, 'хозяин выключил камеру — у гостя плитка темнеет');
  await хозяин.нажать('#cam');

  // Сообщение по тому же каналу, по которому договаривались.
  await гость.ev(`(() => { const t = document.querySelector('#chat-text'); t.value = 'проверка связи'; document.querySelector('#chat-form').requestSubmit(); })()`);
  await ждать(1500);
  отметить(
    (await хозяин.ev(`[...document.querySelectorAll('#chat-log .msg')].some(m => m.textContent.includes('проверка связи'))`)) === true,
    'сообщение гостя дошло до хозяина',
  );

  await гость.нажать('#hangup');
  const строка = await дождаться(
    async () => /больше не в разговоре$/.test((await хозяин.ev(`document.querySelector('#notice')?.textContent`)) ?? ''),
    6,
  );
  отметить(строка, 'гость положил трубку — хозяин видит «больше не в разговоре»');
}

const провалов = итоги.filter(ok => !ok).length;
console.log(провалов ? `\nПровалено проверок: ${провалов} из ${итоги.length}` : `\nВсе ${итоги.length} проверок прошли`);
закончить(провалов ? 1 : 0);
