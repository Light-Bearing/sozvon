// Экран звонка: плитки участников, номерок со ссылкой и три кнопки.
// Пока никто не зашёл, номерок висит крупно — его и надо отдать.
// Как только появился первый собеседник, он сжимается в карман к кнопкам.

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

// Кнопка ничего не помнит сама: её разметка выставляется из состояния
// комнаты на каждой перерисовке, а клик только просит комнату переключить
// намерение. Раньше кнопка сама решала, что показать после клика, — и на
// втором звонке подряд (или сразу после смены состояния комнатой) первое
// нажатие показывало ровно обратное тому, что происходило на самом деле.
const bindToggle = (button, pressed, act) => {
  button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  button.onclick = act;
};

const bindCopy = (container, link) => {
  for (const button of container.querySelectorAll('[data-copy]')) {
    button.onclick = async () => {
      await navigator.clipboard.writeText(link);
      const label = button.querySelector('.tag-label') ?? button.lastElementChild;
      const was = label.textContent;
      label.textContent = 'Скопировано';
      setTimeout(() => (label.textContent = was), 1600);
    };
  }
};

export const renderCall = (container, state, actions) => {
  const alone = state.peers.length === 0;

  const tiles = container.querySelector('#tiles');
  // Пока ты один, своя картинка — это зеркальце, а не стена:
  // главный предмет на этом экране номерок, а не собственное лицо.
  tiles.classList.toggle('tiles--alone', alone);
  tiles.replaceChildren(
    tile('self', state.self, 'Вы', true),
    ...state.peers.map(({peerId, stream}, i) =>
      tile(peerId, stream, nameFor(i, state.peers.length), false),
    ),
  );

  for (const slot of container.querySelectorAll('[data-link]')) {
    slot.textContent = state.link;
  }

  container.querySelector('#invite').hidden = !alone;
  container.querySelector('.tag--pocket').hidden = alone;

  bindCopy(container, state.link);
  bindToggle(container.querySelector('#mic'), state.mic, actions.toggleMicrophone);

  // На ступени без видео (state.step.videoFor === 'none', «голосовой режим»
  // при большом числе участников) камеру всё равно держит выключенной
  // лестница качества — кнопка, которая на вид работает, а на деле ничего
  // не меняет, и есть тихая ложь: недоступность честнее показать явно.
  const camButton = container.querySelector('#cam');
  camButton.disabled = state.step.videoFor === 'none';
  bindToggle(camButton, state.cam, actions.toggleCamera);

  container.querySelector('#hangup').onclick = actions.hangUp;
};
