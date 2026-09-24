// Настоящий звонок двух браузеров — проверка того, чего не видят тесты.
//
// Все поломки звука и картинки за неделю живых проверок нашлись только
// глазами: дорожки не доходили до экрана, плитки моргали, значок прятался
// под заглушкой. Ни один модульный тест их не ловил — они проверяют
// поддельные соединения, а ломалось как раз настоящее.
//
// Здесь два человека в одном безголовом Chrome с поддельной камерой и
// микрофоном: хозяин с выдуманным ретранслятором и гость по его ссылке.
// Проверяется то, что видит человек: соединились, картинка идёт, звук
// доходит, ретранслятор достаётся только отвечающим.
//
// Запуск: дев-сервер должен работать (npm run dev), затем
//   node tools/call-check.mjs [адрес]      — по умолчанию http://localhost:5180/
// Нужны публичные каналы: люди находят друг друга через них, как в жизни.

import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const APP = process.argv[2] ?? 'http://localhost:5180/';
const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9339;

const ждать = ms => new Promise(r => setTimeout(r, ms));
const base64url = s =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── свой Chrome на время проверки ──────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'sozvon-call-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    // Поддельные камера и микрофон и согласие на них без окна вопроса.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    // Две вкладки одного браузера иначе прячут друг от друга адреса за
    // именами .local — на живых устройствах этого нет, здесь только мешает.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    'about:blank',
  ],
  {stdio: 'ignore'},
);

// Упади проверка на полпути — её Chrome остался бы висеть на том же порту,
// и следующий прогон молча подключился бы к нему, со старыми флагами и
// старым состоянием. Так однажды и вышло: полчаса искал поломку, которой не
// было. Поэтому браузер убираем при любом исходе.
process.on('exit', () => chrome.kill());
process.on('uncaughtException', error => {
  console.log(`✗ проверка упала сама: ${error?.message ?? error}`);
  закончить(2);
});
process.on('unhandledRejection', error => {
  console.log(`✗ проверка упала сама: ${error?.message ?? error}`);
  закончить(2);
});

const закончить = code => {
  chrome.kill();
  try {
    rmSync(profile, {recursive: true, force: true});
  } catch {}
  process.exit(code);
};

let готов = false;
for (let i = 0; i < 40 && !готов; i++) {
  await ждать(250);
  готов = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false);
}
if (!готов) {
  console.log('✗ Chrome не поднялся');
  закончить(2);
}

// ── вкладка ─────────────────────────────────────────────────
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
    if (r.timeout) return undefined;
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  // Счётчик ставится ДО загрузки: соединения библиотека создаёт сразу.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__описания = [];
      const sld = RTCPeerConnection.prototype.setLocalDescription;
      RTCPeerConnection.prototype.setLocalDescription = function (...args) {
        const turn = (this.getConfiguration().iceServers || [])
          .some(s => [].concat(s.urls).some(u => /^turns?:/.test(u)));
        // Вид описания — по состоянию переговоров, а не по тому, пришло ли
        // что-то от собеседника. На живом соединении ответ от него пришёл
        // давно, и прежний счётчик записывал в «ответы» повторное
        // предложение при включении камеры — у которого ретранслятора и не
        // должно быть. Проверка из-за этого то проходила, то падала, смотря
        // кто в паре отвечал первым.
        const явный = args[0]?.type;
        const kind =
          явный === 'rollback' ? 'rollback'
          : явный ?? (this.signalingState === 'have-remote-offer' ? 'answer' : 'offer');
        // Первое предложение — до всякого ответа собеседника: это и есть
        // заготовки библиотеки. Повторные — переговоры на живом соединении.
        const first = kind === 'offer' && !this.remoteDescription;
        window.__описания.push({kind, turn, first});
        return sld.apply(this, args);
      };`,
  });
  await send('Page.navigate', {url});

  // Нажатие настоящее, а не el.click(): браузер отличает жест человека от
  // вызова из сценария и без жеста не пускает звук.
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

  const закрыть = () => fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
  // Падение страницы — как обрыв связи: попрощаться ей нечем.
  const уронить = () => Promise.race([send('Page.crash'), ждать(1500)]);

  return {ev, нажать, закрыть, уронить};
};

// ── проверки ────────────────────────────────────────────────
const итоги = [];
const отметить = (ok, что, подробно = '') => {
  итоги.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${что}${подробно ? ` — ${подробно}` : ''}`);
};

// Выдуманный ретранслятор на закрытом порту: выделение провалится сразу, а
// проверяется лишь то, кому он был дан. Ключ тоже выдуманный.
const настройка = base64url(JSON.stringify({a: '127.0.0.1:9', k: 'ключ-проверки'}));

const хозяин = await открыть(`${APP}?_=${Date.now()}#turn=${настройка}`);
await ждать(2500);
await хозяин.нажать('#start');
await ждать(2500);

const ссылка = await хозяин.ev(`document.querySelector('#link')?.textContent`);
отметить(/#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/.test(ссылка ?? ''), 'в приглашении есть пропуск к ретранслятору');
отметить(!/turn=/.test((await хозяин.ev('location.href')) ?? ''), 'ключ стёрт из адреса хозяина');

const гость = await открыть(ссылка);
await ждать(2500);
await гость.нажать('#join');

const плиток = t => t.ev(`document.querySelectorAll('#tiles .tile').length`);
let секунд = 0;
while (секунд < 40 && !((await плиток(хозяин)) >= 2 && (await плиток(гость)) >= 2)) {
  await ждать(1000);
  секунд += 1;
}
отметить(секунд < 40, 'соединились', секунд < 40 ? `за ~${секунд + 1} с` : 'за 40 с так и не вышло');

if (секунд < 40) {
  // Хозяин включает камеру и микрофон — уже внутри разговора. Это ровно тот
  // путь, на котором дорожки однажды не доходили до экрана.
  await хозяин.нажать('#cam');
  await хозяин.нажать('#mic');
  await ждать(6000);

  const увиденное = await гость.ev(`(async () => {
    const чужая = [...document.querySelectorAll('#tiles .tile')].find(t => t.dataset.peer !== 'self');
    const видео = чужая?.querySelector('video');
    const звук = чужая?.querySelector('audio');
    const t0 = видео?.currentTime ?? 0;
    await new Promise(r => setTimeout(r, 1500));
    const дорожка = звук?.srcObject?.getAudioTracks?.()[0];
    return {
      ширина: видео?.videoWidth ?? 0,
      идёт: (видео?.currentTime ?? 0) > t0,
      тёмная: чужая?.classList.contains('tile--dark') ?? true,
      звукЖив: Boolean(дорожка && дорожка.readyState === 'live'),
      звукИграет: Boolean(звук && !звук.paused),
    };
  })()`);
  отметить(увиденное?.ширина > 0, 'гость видит картинку хозяина', `${увиденное?.ширина ?? 0} пикс. в ширину`);
  отметить(увиденное?.идёт === true, 'картинка движется, а не застыла');
  отметить(увиденное?.тёмная === false, 'плитка не затемнена поверх живой картинки');
  отметить(увиденное?.звукЖив === true, 'звук хозяина дошёл до гостя');
  отметить(увиденное?.звукИграет === true, 'звук играет, браузер его не заблокировал');
}

// ── уход: сам или обрыв ─────────────────────────────────────
// Раньше плитка ушедшего исчезала молча, и «положил трубку» было не
// отличить от «пропала связь».
const строкаХозяина = () => хозяин.ev(`document.querySelector('#notice')?.hidden ? '' : document.querySelector('#notice')?.textContent`);
const дождатьсяСтроки = async () => {
  for (let i = 0; i < 12; i++) {
    const текст = await строкаХозяина();
    if (текст) return текст;
    await ждать(500);
  }
  return '';
};

if (секунд < 40) {
  await гость.нажать('#hangup');
  const послеТрубки = await дождатьсяСтроки();
  отметить(/больше не в разговоре$/.test(послеТрубки), 'гость положил трубку — хозяин видит «больше не в разговоре»', послеТрубки || 'строки нет');

  // Второй гость входит и просто закрывает вкладку — это тоже уход сам.
  await ждать(5500);
  const второй = await открыть(ссылка);
  await ждать(2500);
  await второй.нажать('#join');
  let вошёл = false;
  for (let i = 0; i < 40 && !вошёл; i++) {
    await ждать(1000);
    вошёл = (await плиток(хозяин)) >= 2 && (await плиток(второй)) >= 2;
  }
  if (вошёл) {
    await ждать(2000);
    await второй.закрыть();
    const послеЗакрытия = await дождатьсяСтроки();
    отметить(
      /больше не в разговоре$/.test(послеЗакрытия),
      'гость закрыл вкладку — это тоже «больше не в разговоре»',
      послеЗакрытия || 'строки нет',
    );
  } else {
    отметить(false, 'второй гость не вошёл — закрытие вкладки не проверено');
  }

  // Третий входит, и его страница падает. Прощания нет — значит, обрыв.
  await ждать(5500);
  const третий = await открыть(ссылка);
  await ждать(2500);
  await третий.нажать('#join');
  let вошёлТретий = false;
  for (let i = 0; i < 40 && !вошёлТретий; i++) {
    await ждать(1000);
    вошёлТретий = (await плиток(хозяин)) >= 2 && (await плиток(третий)) >= 2;
  }
  if (вошёлТретий) {
    await ждать(2000);
    await третий.уронить();
    // Обрыв замечается не сразу: соединение гаснет за десяток секунд.
    let послеОбрыва = '';
    for (let i = 0; i < 40 && !послеОбрыва; i++) {
      await ждать(500);
      послеОбрыва = await строкаХозяина();
    }
    отметить(
      /— связь прервалась$/.test(послеОбрыва),
      'страница гостя упала — хозяин видит «связь прервалась»',
      послеОбрыва || 'строки нет за 20 с',
    );
  } else {
    отметить(false, 'третий гость не вошёл — обрыв не проверен');
  }
}

const описания = async t => (await t.ev('window.__описания')) ?? [];
const уХозяина = await описания(хозяин);
const уГостя = await описания(гость);
const заготовки = [...уХозяина, ...уГостя].filter(x => x.first);
const ответы = [...уХозяина, ...уГостя].filter(x => x.kind === 'answer');
отметить(
  заготовки.length > 0 && заготовки.every(x => !x.turn),
  'заготовки без ретранслятора',
  `с ретранслятором ${заготовки.filter(x => x.turn).length} из ${заготовки.length}`,
);
отметить(
  ответы.length > 0 && ответы.every(x => x.turn),
  'отвечающие получают ретранслятор',
  `${ответы.filter(x => x.turn).length} из ${ответы.length}`,
);

const провалов = итоги.filter(ok => !ok).length;
console.log(провалов ? `\nПровалено проверок: ${провалов} из ${итоги.length}` : `\nВсе ${итоги.length} проверок прошли`);
закончить(провалов ? 1 : 0);
