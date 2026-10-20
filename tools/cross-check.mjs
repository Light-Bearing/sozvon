// Обмен кодами вручную между Chrome и Firefox — в обе стороны.
//
// Короткий код достраивается у собеседника по шаблону (src/signal/slim-sdp.js),
// и шаблон обязан подойти любому браузеру, а не только тому, в котором его
// писали. Здесь один собеседник в Chrome, другой в Firefox; потом наоборот.
// Проверяется: соединились, картинка и звук в обе стороны.
//
// Запуск: дев-сервер должен работать (npm run dev), затем
//   node tools/cross-check.mjs [адрес]
// Нужен Firefox в /Applications (или путь в FIREFOX).

import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const APP = process.argv[2] ?? 'http://localhost:5180/';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIREFOX = process.env.FIREFOX ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const CPORT = 9345;
const FPORT = 9346;
const ждать = ms => new Promise(r => setTimeout(r, ms));

const профили = [];
const процессы = [];
const закончить = code => {
  for (const p of процессы) p.kill();
  for (const d of профили) {
    try {
      rmSync(d, {recursive: true, force: true});
    } catch {}
  }
  process.exit(code);
};
process.on('exit', () => процессы.forEach(p => p.kill()));
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, error => {
    console.log(`✗ проверка упала сама: ${error?.message ?? error}`);
    закончить(2);
  });
}

const сокет = async url => {
  const ws = new WebSocket(url);
  await new Promise((ok, no) => {
    ws.onopen = ok;
    ws.onerror = no;
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  };
  return (method, params = {}) =>
    Promise.race([
      new Promise(ok => {
        const mine = ++id;
        waiting.set(mine, ok);
        ws.send(JSON.stringify({id: mine, method, params}));
      }),
      ждать(30000).then(() => ({timeout: true})),
    ]);
};

// ── Chrome ──────────────────────────────────────────────────
const chromeProfile = mkdtempSync(join(tmpdir(), 'sozvon-cross-c-'));
профили.push(chromeProfile);
процессы.push(
  spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CPORT}`, `--user-data-dir=${chromeProfile}`,
    '--no-first-run', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', 'about:blank'], {stdio: 'ignore'}),
);

const вChrome = async url => {
  let t = null;
  for (let i = 0; i < 40 && !t; i++) {
    await ждать(250);
    t = await fetch(`http://127.0.0.1:${CPORT}/json/new?about:blank`, {method: 'PUT'}).then(r => r.json(), () => null);
  }
  const send = await сокет(t.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.navigate', {url});
  return async expression =>
    (await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true})).result?.result?.value;
};

// ── Firefox ─────────────────────────────────────────────────
const firefoxProfile = mkdtempSync(join(tmpdir(), 'sozvon-cross-f-'));
профили.push(firefoxProfile);
writeFileSync(
  join(firefoxProfile, 'user.js'),
  [
    'user_pref("media.navigator.streams.fake", true);',
    'user_pref("media.navigator.permission.disabled", true);',
    'user_pref("media.autoplay.default", 0);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  ].join('\n'),
);
процессы.push(
  spawn(FIREFOX, ['--headless', '--remote-debugging-port', String(FPORT), '--profile', firefoxProfile, '--no-remote'], {stdio: 'ignore'}),
);

const вFirefox = async url => {
  let send = null;
  for (let i = 0; i < 60 && !send; i++) {
    await ждать(500);
    send = await сокет(`ws://127.0.0.1:${FPORT}/session`).catch(() => null);
  }
  if (!send) throw new Error('Firefox не поднялся');
  await send('session.new', {capabilities: {}});
  const tree = await send('browsingContext.getTree', {});
  const context = tree.result.contexts[0].context;
  await send('browsingContext.navigate', {context, url, wait: 'complete'});
  return async expression => {
    const r = await send('script.evaluate', {expression, target: {context}, awaitPromise: true, resultOwnership: 'none'});
    const v = r.result?.result;
    if (r.result?.type === 'exception' || r.error) return undefined;
    return v?.type === 'string' ? v.value : v?.type === 'boolean' ? v.value : v?.type === 'number' ? v.value : v?.value;
  };
};

// ── проверки ────────────────────────────────────────────────
const итоги = [];
const отметить = (ok, что, подробно = '') => {
  итоги.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${что}${подробно ? ` — ${подробно}` : ''}`);
};
const дождаться = async (условие, секунд) => {
  for (let i = 0; i < секунд * 2; i++) {
    if (await условие()) return true;
    await ждать(500);
  }
  return false;
};

const нажать = sel => `(() => { const b = document.querySelector(${JSON.stringify(sel)}); b?.click(); return Boolean(b); })()`;
// Экран показан и программа на нём ожила: у поля имени уже есть подсказка.
const готовЭкран = экран =>
  `(() => { const e = document.querySelector('#screen-${экран}'); return Boolean(e && !e.hidden && e.querySelector('[data-name], #name-input')?.placeholder); })()`;
const текстСсылки = `document.querySelector('#link')?.textContent ?? ''`;
const плиток = `document.querySelectorAll('#tiles .tile').length`;
const видитСобеседника = `(async () => {
  const чужая = document.querySelector('#tiles .tile:not([data-peer="self"])');
  const видео = чужая?.querySelector('video');
  const t0 = видео?.currentTime ?? 0;
  await new Promise(r => setTimeout(r, 1500));
  const дорожка = чужая?.querySelector('audio')?.srcObject?.getAudioTracks?.()[0];
  return JSON.stringify({картинка: (видео?.videoWidth ?? 0) > 0 && (видео?.currentTime ?? 0) > t0, звук: Boolean(дорожка && дорожка.readyState === 'live')});
})()`;

const разговор = async (имяХозяина, хозяин, имяГостя, открытьГостя) => {
  console.log(`\n${имяХозяина} зовёт, ${имяГостя} отвечает`);
  // Ждём не время, а готовность: с живого сайта страница грузится дольше,
  // чем с дев-сервера, и нажатие до загрузки уходило в пустоту.
  await дождаться(async () => (await хозяин(готовЭкран('start'))) === true, 20);
  await хозяин(нажать('#start'));
  await ждать(1500);
  await хозяин(нажать('#by-hand'));
  await дождаться(async () => /#m\./.test(await хозяин(текстСсылки)), 15);
  const ссылка = await хозяин(текстСсылки);
  отметить(/#m\./.test(ссылка), `${имяХозяина}: ссылка для обмена`, `${ссылка.length} знаков`);

  const гость = await открытьГостя(ссылка);
  await дождаться(async () => (await гость(готовЭкран('join'))) === true, 20);
  await гость(нажать('#join'));
  await дождаться(async () => /^[A-Za-z0-9_-]{40,}$/.test((await гость(текстСсылки)) ?? ''), 15);
  const ответ = await гость(текстСсылки);
  отметить(/^[A-Za-z0-9_-]{40,}$/.test(ответ ?? ''), `${имяГостя}: код ответа`, `${ответ?.length ?? 0} знаков`);

  await хозяин(`(() => { document.querySelector('#answer-text').value = ${JSON.stringify(ответ)}; document.querySelector('#answer-go').click(); return true; })()`);
  const ок = await дождаться(async () => (await хозяин(плиток)) >= 2 && (await гость(плиток)) >= 2, 30);
  отметить(ок, 'соединились');
  if (!ок) {
    console.log('  ошибка у хозяина:', await хозяин(`document.querySelector('#answer-error')?.textContent ?? ''`));
    return;
  }
  for (const t of [хозяин, гость]) {
    await t(нажать('#cam'));
    await t(нажать('#mic'));
  }
  await ждать(7000);
  for (const [имя, t] of [[имяХозяина, хозяин], [имяГостя, гость]]) {
    // Картинку даём дойти: на живом сайте договор о дорожках идёт через
    // настоящую сеть и иногда занимает дольше нескольких секунд.
    let v = {};
    for (let i = 0; i < 4 && !(v.картинка && v.звук); i++) {
      if (i) await ждать(2500);
      v = JSON.parse((await t(видитСобеседника)) ?? '{}');
    }
    const подробно = v.картинка && v.звук ? '' : (await t(`JSON.stringify({плиток: document.querySelectorAll('#tiles .tile').length, дорожки: document.querySelector('#tiles .tile:not([data-peer="self"]) video')?.srcObject?.getTracks().map(x => x.kind + ':' + x.readyState + (x.muted ? ':глухая' : '')) ?? null, тёмная: document.querySelector('#tiles .tile:not([data-peer="self"])')?.classList.contains('tile--dark')})`)) ?? 'скрипт не выполнился';
    отметить(v.картинка === true, `${имя} видит картинку собеседника`, v.картинка ? '' : подробно);
    отметить(v.звук === true, `${имя} получает звук собеседника`);
  }
};

const chromeХозяин = await вChrome(`${APP}?_=${Date.now()}`);
let firefoxВкладка = null;
await разговор('Chrome', chromeХозяин, 'Firefox', async url => (firefoxВкладка = await вFirefox(url)));

// Наоборот: Firefox зовёт, Chrome отвечает — в той же вкладке Firefox.
await firefoxВкладка(`(() => { document.querySelector('#hangup')?.click(); return true; })()`);
await ждать(1500);
await firefoxВкладка(`(() => { location.href = ${JSON.stringify(`${APP}?_=${Date.now()}`)}; return true; })()`);
await разговор('Firefox', firefoxВкладка, 'Chrome', url => вChrome(url));

const провалов = итоги.filter(ok => !ok).length;
console.log(провалов ? `\nПровалено проверок: ${провалов} из ${итоги.length}` : `\nВсе ${итоги.length} проверок прошли`);
закончить(провалов ? 1 : 0);
