// Экран звонка. Пока никто не зашёл, главное на нём — ссылка, а своя
// камера служит фоном: комната не выглядит пустой, и сразу видно, что
// камера работает. Как только появился собеседник, фон уходит, плитки
// занимают экран, а ссылка сворачивается в кнопку у остальных.
//
// Вход в разговор молчаливый — камеры может не быть вовсе, пока человек
// сам её не включит. Фон и плитка это не прячут и не подделывают: без
// картинки плитка темнеет и показывает инициал (см. hasPicture() ниже и
// .tile--dark в style.css), а фон остаётся своим спокойным градиентом.

import {explainTrouble} from './screens.js';

const hasPicture = stream => stream?.getVideoTracks().some(track => track.enabled);

const tile = (id, stream, label, isSelf) => {
  const box = document.createElement('div');
  box.className = isSelf ? 'tile tile--self' : 'tile';
  box.dataset.peer = id;

  if (!hasPicture(stream)) {
    box.classList.add('tile--dark');
    box.dataset.initial = label.slice(0, 1);
  }

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // Себя слушать не надо — иначе эхо и вой.
  video.muted = isSelf;
  if (stream) video.srcObject = stream;

  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = label;

  box.append(video, name);
  return box;
};

const nameFor = (index, total) =>
  total > 1 ? `Собеседник ${index + 1}` : 'Собеседник';

// Кнопка ничего не помнит сама: её вид выставляется из состояния комнаты
// на каждой перерисовке, а клик только просит комнату переключить
// намерение. Когда кнопка решала сама, на втором звонке подряд первое
// нажатие показывало ровно обратное тому, что происходило на деле.
const bindToggle = (button, pressed, act) => {
  button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  button.onclick = act;
};

const bindCopy = (container, link) => {
  for (const button of container.querySelectorAll('[data-copy]')) {
    button.onclick = async () => {
      await navigator.clipboard.writeText(link);
      const label = button.querySelector('[data-copy-label]');
      const was = label?.textContent;
      if (label) label.textContent = 'Скопировано';
      button.classList.add('is-done');
      setTimeout(() => {
        button.classList.remove('is-done');
        if (label) label.textContent = was;
      }, 1800);
    };
  }
};

export const renderCall = (container, state, actions) => {
  const alone = state.peers.length === 0;
  container.dataset.busy = alone ? 'no' : 'yes';

  const backdrop = container.querySelector('#backdrop');
  // Без камеры (её ещё не включили, или поток без единой видеодорожки)
  // фону нечего показывать — гасим srcObject явно, а не полагаемся на то,
  // как браузер отрисует пустой или беззвучный-без-картинки поток. Фон
  // тогда остаётся собственным спокойным градиентом из style.css, а не
  // чёрной дырой.
  const backdropSource = hasPicture(state.self) ? state.self : null;
  if (backdrop.srcObject !== backdropSource) backdrop.srcObject = backdropSource;

  container.querySelector('#tiles').replaceChildren(
    tile('self', state.self, 'Вы', true),
    ...state.peers.map(({peerId, stream}, i) =>
      tile(peerId, stream, nameFor(i, state.peers.length), false),
    ),
  );

  // Беда с соединением — единственное, что может вывести карточку обратно
  // на экран, когда собеседники уже есть: если к кому-то не достучаться,
  // ссылка нужна тут же, под объяснением.
  const trouble = state.troubles?.[0];

  container.querySelector('#link').textContent = state.link;
  container.querySelector('#invite').hidden = !alone && !trouble;
  container.querySelector('.ctl--copy').hidden = alone;

  const troubleBox = container.querySelector('#trouble');
  troubleBox.hidden = !trouble;
  if (trouble) {
    const {title, advice} = explainTrouble(trouble);
    container.querySelector('#trouble-title').textContent = title;
    container.querySelector('#trouble-advice').textContent = advice;
  }

  // Каналы молчат — говорим об этом, но звонок не прерываем: попытки идут.
  // Названная беда важнее обоих: она объясняет ровно то, чего ждать уже
  // бессмысленно.
  container.querySelector('#waiting').hidden = Boolean(state.quiet || trouble);
  container.querySelector('#quiet').hidden = !state.quiet || Boolean(trouble);

  bindCopy(container, state.link);
  bindToggle(container.querySelector('#mic'), state.mic, actions.toggleMicrophone);

  // В голосовом режиме камеру всё равно держит выключенной лестница
  // качества. Кнопка, которая на вид работает, а на деле ничего не меняет,
  // и есть тихая ложь — недоступность честнее показать явно.
  const camButton = container.querySelector('#cam');
  camButton.disabled = state.step.videoFor === 'none';
  bindToggle(camButton, state.cam, actions.toggleCamera);

  container.querySelector('#hangup').onclick = actions.hangUp;
};
