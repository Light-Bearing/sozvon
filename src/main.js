import {generateSecret, linkToSecret, passFromLink} from './room-secret.js';
import {createRoom} from './room.js';
import {createAwake} from './awake.js';
import {familiesFor, parseFamilyNames} from './signal/public-channels.js';
import {forgetShift, renderCall} from './ui/call.js';
import {followScreens} from './focus.js';
import {explainFailure, showScreen} from './ui/screens.js';
import {renderDiagnostics} from './ui/diagnostics.js';
import {bindHotkeys} from './ui/hotkeys.js';
import {createSettings} from './ui/settings.js';
import {createChat} from './ui/chat.js';
import {makeName, trimName} from './names.js';
import {recall, remember} from './store.js';
import {packPass, passFor, relayFromLink, serversFromPass, unpackPass} from './turn.js';
import {relayInUse, useRelay} from './rtc.js';

const app = document.querySelector('#app');

let room = null;

// Имя и выбранные устройства переживают звонок: перезаходить в разговор и
// каждый раз называться заново — работа, которой быть не должно.
//
// Смешное имя — подсказка в пустом поле, а не вписанный в него текст:
// вписанное пришлось бы сначала стирать, чтобы назваться по-своему, и
// человек не отличил бы своё имя от придуманного за него. Пустое поле
// значит «зовите как придумали», и ровно это в нём и написано.
const HINT = makeName();
let given = trimName(recall('имя'));
let myName = given ?? HINT;
const picked = {
  microphone: recall('микрофон'),
  camera: recall('камера'),
  speaker: recall('звук'),
};

// Пустое поле — это отказ от своего имени, а не ошибка ввода: возвращаемся
// к подсказке и забываем сохранённое.
// Свой ретранслятор. Ключ живёт только здесь, в этом браузере, и наружу
// уходит лишь короткими пропусками — по одному на разговор.
const relay = {
  address: recall('ретранслятор') ?? '',
  secret: recall('ключ-ретранслятора') ?? '',
};

// Ссылка с настройкой — чтобы ничего не вписывать руками. Читается до
// всего остального и тут же стирается из адреса: в хвосте лежит ключ
// целиком, и ему незачем оставаться на виду и в истории браузера.
const fromLink = relayFromLink(location.href);
if (fromLink) {
  Object.assign(relay, fromLink);
  remember('ретранслятор', relay.address);
  remember('ключ-ретранслятора', relay.secret);
  history.replaceState(null, '', location.href.split('#')[0]);
}

// Зеркалить ли своё изображение. Чужих не зеркалим никогда, поэтому
// настройка про своё и только про своё.
let mirror = recall('зеркало') === 'да';
// Кого показывать крупно. Живёт здесь, а не в комнате: это взгляд одного
// человека на разговор, собеседникам о нём знать нечего. И не запоминается
// между звонками — участники в каждом свои.
let pinned = null;

const saveName = next => {
  given = trimName(next);
  myName = given ?? HINT;
  remember('имя', given);
  return myName;
};

const paintNameFields = () => {
  for (const input of app.querySelectorAll('[data-name]')) {
    input.placeholder = HINT;
    if (input.value !== (given ?? '')) input.value = given ?? '';
  }
};

for (const input of app.querySelectorAll('[data-name]')) {
  input.oninput = () => {
    saveName(input.value);
    room?.setName(myName);
  };
}
paintNameFields();

// Отладочный переключатель семейств каналов: ?каналы=nostr или
// ?каналы=nostr,mqtt ограничивает список для опыта «а если оставить
// одно семейство, связь встанет?» (см. README.md). Без параметра — все
// три, как обычно.
const families = familiesFor(
  parseFamilyNames(new URLSearchParams(location.search).get('каналы')),
);

// Роль узнаём один раз, при загрузке страницы, — до того, как enter()
// что-нибудь запишет в адрес. Дальше решаем по этому значению, а не по
// текущему адресу: после неудачной попытки хозяина в хвосте на мгновение
// остаётся секрет, который по виду не отличить от чужого приглашения
// (та же длина, тот же алфавит).
const invited = linkToSecret(location.href);
// Пропуск к ретранслятору, если его принесло приглашение. Читаем сразу, по
// той же причине, что и секрет: потом в адресе может оказаться что угодно.
const invitedPass = unpackPass(passFromLink(location.href));

// Одна точка отрисовки экрана звонка — ею пользуется и комната (на каждое
// изменение), и настройки, когда меняется то, чем комната не распоряжается.
// Вывод звука — как раз такое: он переключается у проигрывателя, а не у
// потока, поэтому дописывается к состоянию здесь, а не живёт в room.js.
// Чужой показ экрана сам становится крупным — правила и оговорки живут в
// src/focus.js, здесь только память между перерисовками.
let screensSeen = new Set();

const paint = state => {
  ({pinned, seen: screensSeen} = followScreens({
    peers: state.peers,
    selfScreen: state.selfScreen,
    pinned,
    seen: screensSeen,
  }));
  renderCall(
    app.querySelector('#screen-call'),
    // Готов ли ретранслятор — знает только страница: ключ живёт здесь.
    {
      ...state,
      speaker: picked.speaker,
      mirror,
      pinned,
      relayReady: relayInUse().length > 0,
    },
    {
      toggleMicrophone: () => room.setMicrophone(!state.mic),
      toggleCamera: () => room.setCamera(!state.cam),
      toggleScreen: () => void room.setScreen(!state.screen),
      togglePin: id => {
        pinned = pinned === id ? null : id;
        paint(room.state());
      },
      hangUp: async () => {
        await room.leave();
        await awake.stop();
        useRelay([]);
        room = null;
        pinned = null;
        screensSeen = new Set();
        forgetShift();
        settings.close();
        chat.close();
        location.hash = '';
        showScreen(app, 'start');
      },
    },
  );
};

const fail = error => {
  const {title, advice} = explainFailure(error);
  app.querySelector('#failed-title').textContent = title;
  app.querySelector('#failed-advice').textContent = advice;
  showScreen(app, 'failed');
};

// Пока идёт разговор, экрану гаснуть незачем: за погасшим экраном телефон
// замораживает страницу вместе с соединением. А если блокировку всё же не
// дали или человек погасил экран сам — возвращаем при пробуждении всё, что
// телефон успел отобрать.
const awake = createAwake({onWake: () => void room?.wake()});

const enter = async secret => {
  location.hash = secret;
  showScreen(app, 'call');
  try {
    // Пропуск к ретранслятору. У хозяина — свежий, выписанный своим ключом
    // на этот разговор (живёт полсуток). У гостя — тот, что пришёл в
    // приглашении. Нет ни того ни другого — звонок идёт напрямую, как раньше.
    const pass = (await passFor(relay)) ?? invitedPass;
    useRelay(serversFromPass(pass));
    const packed = pass ? packPass(pass) : null;
    // Пропуск остаётся и в адресе: перезагрузи гость страницу — и без него
    // он остался бы без ретранслятора посреди разговора. replaceState, а не
    // hash: это та же страница, лишний шаг «назад» тут ни к чему.
    if (packed) history.replaceState(null, '', `#${secret}.${packed}`);

    room = await createRoom({
      secret,
      families,
      pass: packed,
      // Намерение по микрофону/камере целиком живёт в room.js (createRoom
      // заводит его заново на каждый звонок) и приходит сюда через state —
      // отдельной копии в main.js больше нет, поэтому её нечему рассогласовать
      // с разметкой и нечего забыть сбросить между звонками.
      name: myName,
      onChange: paint,
    });
    await awake.start();
  } catch (error) {
    fail(error);
  }
};

const chat = createChat(app, {
  say: text => Boolean(room?.say(text)),
  read: () => room?.readChat(),
});

const settings = createSettings(app, {
  // Что человек вписал сам (пусто — значит согласился на подсказку) и что
  // будет написано, если он так ничего и не впишет.
  currentName: () => given ?? '',
  nameHint: () => HINT,
  currentDevices: () => picked,
  currentMirror: () => mirror,
  setMirror: on => {
    mirror = Boolean(on);
    remember('зеркало', mirror ? 'да' : null);
    if (room) paint(room.state());
  },
  currentRelay: () => relay,
  currentFlow: () => room?.state().flow ?? null,
  version: typeof __ВЕРСИЯ__ === 'string' ? __ВЕРСИЯ__ : '',
  setRelay: (field, value) => {
    relay[field] = value.trim();
    remember({address: 'ретранслятор', secret: 'ключ-ретранслятора'}[field], relay[field] || null);
  },
  setName: next => {
    room?.setName(saveName(next));
    paintNameFields();
  },
  setDevice: (kind, deviceId) => {
    picked[kind] = deviceId;
    remember({microphone: 'микрофон', camera: 'камера', speaker: 'звук'}[kind], deviceId);
    if (kind === 'microphone') void room?.setMicrophoneDevice(deviceId);
    if (kind === 'camera') void room?.setCameraDevice(deviceId);
    // Комната о выводе звука не знает и ничего не объявит — перерисовываем
    // сами, чтобы setSinkId дошёл до проигрывателей.
    if (kind === 'speaker' && room) paint(room.state());
  },
});

app.querySelector('#settings-open').onclick = () => void settings.open();

// Пробел — быстрый выключатель микрофона. Работает только на экране
// звонка и только когда там есть чем управлять.
bindHotkeys(document, {
  isReady: () => Boolean(room) && !app.querySelector('#screen-call').hidden,
  toggleMicrophone: () => room.setMicrophone(!room.state().mic),
});

app.querySelector('#start').onclick = () => void enter(generateSecret());
app.querySelector('#retry').onclick = () => {
  // Гостю хвост адреса трогать нельзя — это и есть его приглашение: если
  // стереть, после перезагрузки будет неоткуда собрать экран приглашения
  // заново. Хозяину, наоборот, нужно стереть — то, что осталось в хвосте,
  // это след его собственной неудачной попытки, а не чьё-то приглашение.
  if (!invited) location.hash = '';
  location.reload();
};

let screenBeforeDiagnostics = 'start';

for (const button of app.querySelectorAll('[data-diagnostics]')) {
  button.onclick = () => {
    screenBeforeDiagnostics = app.querySelector('#screen-failed').hidden ? 'start' : 'failed';
    showScreen(app, 'diagnostics');
    void renderDiagnostics(app.querySelector('#diagnostics-body'), relay);
  };
}

app.querySelector('#diagnostics-close').onclick = () =>
  showScreen(app, screenBeforeDiagnostics);

// Гость видит, кто зовёт, и жмёт кнопку — вход в разговор молчаливый,
// браузер пока ни о чём не спрашивает. Камеру и микрофон человек включит
// сам, уже внутри звонка, отдельным нажатием на нужную кнопку.
if (invited) {
  app.querySelector('#join').onclick = () => void enter(invited);
  showScreen(app, 'join');
} else {
  showScreen(app, 'start');
  if (fromLink) {
    const note = app.querySelector('#screen-start .note');
    note.textContent = 'Ретранслятор настроен. Дальше — просто ссылка.';
  }
}

// Регистрируем после загрузки страницы, чтобы не отвлекать браузер от
// первой отрисовки. Сам обработчик — в public/sw.js: сначала сеть, кэш
// только когда сети нет.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
