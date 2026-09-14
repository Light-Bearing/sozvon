import {generateSecret, linkToSecret} from './room-secret.js';
import {createRoom} from './room.js';
import {renderCall} from './ui/call.js';
import {explainFailure, showScreen} from './ui/screens.js';

const app = document.querySelector('#app');

let room = null;
let micOn = true;
let camOn = true;

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
app.querySelector('#retry').onclick = () => location.reload();

// Гость видит, кто зовёт, и жмёт кнопку. Камеру браузер спросит только
// после нажатия — если спросить при загрузке, половина людей уходит.
const invited = linkToSecret(location.href);
if (invited) {
  app.querySelector('#join').onclick = () => void enter(invited);
  showScreen(app, 'join');
} else {
  showScreen(app, 'start');
}
