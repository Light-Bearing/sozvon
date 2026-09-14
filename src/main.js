import {generateSecret, linkToSecret} from './room-secret.js';
import {createRoom} from './room.js';
import {renderCall} from './ui/call.js';

const app = document.querySelector('#app');
const screens = {
  start: app.querySelector('#screen-start'),
  call: app.querySelector('#screen-call'),
};

const show = name => {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
};

let room = null;
let micOn = true;
let camOn = true;

const enter = async secret => {
  location.hash = secret;
  show('call');
  room = await createRoom({
    secret,
    onChange: state =>
      renderCall(screens.call, state, {
        toggleMicrophone: () => room.setMicrophone((micOn = !micOn)),
        toggleCamera: () => room.setCamera((camOn = !camOn)),
        hangUp: async () => {
          await room.leave();
          location.hash = '';
          show('start');
        },
      }),
  });
};

screens.start.querySelector('#start').onclick = () => enter(generateSecret());

const invited = linkToSecret(location.href);
if (invited) void enter(invited);
else show('start');
