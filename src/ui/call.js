// Экран звонка. Пока никто не зашёл, главное на нём — ссылка, а своя
// камера служит фоном: комната не выглядит пустой, и сразу видно, что
// камера работает. Как только появился собеседник, фон уходит, плитки
// занимают экран, а ссылка сворачивается в кнопку у остальных.

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
  if (backdrop.srcObject !== state.self) backdrop.srcObject = state.self ?? null;

  container.querySelector('#tiles').replaceChildren(
    tile('self', state.self, 'Вы', true),
    ...state.peers.map(({peerId, stream}, i) =>
      tile(peerId, stream, nameFor(i, state.peers.length), false),
    ),
  );

  container.querySelector('#link').textContent = state.link;
  container.querySelector('#invite').hidden = !alone;
  container.querySelector('.ctl--copy').hidden = alone;

  // Каналы молчат — говорим об этом, но звонок не прерываем: попытки идут.
  container.querySelector('#waiting').hidden = Boolean(state.quiet);
  container.querySelector('#quiet').hidden = !state.quiet;

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
