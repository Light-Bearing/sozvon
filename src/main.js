import {generateSecret, linkToSecret} from './room-secret.js';
import {createRoom} from './room.js';
import {familiesFor, parseFamilyNames} from './signal/public-channels.js';
import {renderCall} from './ui/call.js';
import {explainFailure, showScreen} from './ui/screens.js';
import {renderDiagnostics} from './ui/diagnostics.js';

const app = document.querySelector('#app');

let room = null;

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
      onChange: state =>
        renderCall(app.querySelector('#screen-call'), state, {
          toggleMicrophone: () => room.setMicrophone(!state.mic),
          toggleCamera: () => room.setCamera(!state.cam),
          hangUp: async () => {
            await room.leave();
            room = null;
            location.hash = '';
            showScreen(app, 'start');
          },
        }),
    });
  } catch (error) {
    fail(error);
  }
};

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
