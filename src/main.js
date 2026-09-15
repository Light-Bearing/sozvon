import {generateSecret, linkToSecret} from './room-secret.js';
import {createRoom} from './room.js';
import {familiesFor, parseFamilyNames} from './signal/public-channels.js';
import {renderCall} from './ui/call.js';
import {explainFailure, showScreen} from './ui/screens.js';
import {renderDiagnostics} from './ui/diagnostics.js';
import {bindHotkeys} from './ui/hotkeys.js';
import {createSettings} from './ui/settings.js';
import {makeName, trimName} from './names.js';
import {recall, remember} from './store.js';

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
// ?каналы=torrent,mqtt ограничивает список для опыта «а если оставить
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

// Одна точка отрисовки экрана звонка — ею пользуется и комната (на каждое
// изменение), и настройки, когда меняется то, чем комната не распоряжается.
// Вывод звука — как раз такое: он переключается у проигрывателя, а не у
// потока, поэтому дописывается к состоянию здесь, а не живёт в room.js.
const paint = state =>
  renderCall(app.querySelector('#screen-call'), {...state, speaker: picked.speaker}, {
    toggleMicrophone: () => room.setMicrophone(!state.mic),
    toggleCamera: () => room.setCamera(!state.cam),
    hangUp: async () => {
      await room.leave();
      room = null;
      settings.close();
      location.hash = '';
      showScreen(app, 'start');
    },
  });

const fail = error => {
  const {title, advice} = explainFailure(error);
  app.querySelector('#failed-title').textContent = title;
  app.querySelector('#failed-advice').textContent = advice;
  showScreen(app, 'failed');
};

const enter = async secret => {
  location.hash = secret;
  showScreen(app, 'call');
  try {
    room = await createRoom({
      secret,
      families,
      // Намерение по микрофону/камере целиком живёт в room.js (createRoom
      // заводит его заново на каждый звонок) и приходит сюда через state —
      // отдельной копии в main.js больше нет, поэтому её нечему рассогласовать
      // с разметкой и нечего забыть сбросить между звонками.
      name: myName,
      onChange: paint,
    });
  } catch (error) {
    fail(error);
  }
};

const settings = createSettings(app, {
  // Что человек вписал сам (пусто — значит согласился на подсказку) и что
  // будет написано, если он так ничего и не впишет.
  currentName: () => given ?? '',
  nameHint: () => HINT,
  currentDevices: () => picked,
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
    void renderDiagnostics(app.querySelector('#diagnostics-body'));
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
}

// Регистрируем после загрузки страницы, чтобы не отвлекать браузер от
// первой отрисовки. Сам обработчик — в public/sw.js: сначала сеть, кэш
// только когда сети нет.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
