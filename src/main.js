import {generateSecret, linkToSecret} from './room-secret.js';
import {createRoom} from './room.js';
import {renderCall} from './ui/call.js';
import {explainFailure, showScreen} from './ui/screens.js';

const app = document.querySelector('#app');

let room = null;
let micOn = true;
let camOn = true;

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
  // Сбрасываем на каждый новый звонок: иначе состояние переживает предыдущий
  // разговор, и первое нажатие «Микрофон»/«Камера» может тайно переключить
  // устаревшее false → true вместо настоящего выключения.
  micOn = true;
  camOn = true;
  location.hash = secret;
  showScreen(app, 'call');
  try {
    room = await createRoom({
      secret,
      onChange: state =>
        renderCall(app.querySelector('#screen-call'), state, {
          toggleMicrophone: () => room.setMicrophone((micOn = !micOn)),
          toggleCamera: () => room.setCamera((camOn = !camOn)),
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

// Гость видит, кто зовёт, и жмёт кнопку. Камеру браузер спросит только
// после нажатия — если спросить при загрузке, половина людей уходит.
if (invited) {
  app.querySelector('#join').onclick = () => void enter(invited);
  showScreen(app, 'join');
} else {
  showScreen(app, 'start');
}
