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

// Кнопка сама помнит своё состояние: обе стороны стартуют включёнными
// и переключаются в одном обработчике, так что разойтись не могут.
const bindToggle = (button, act) => {
  button.onclick = () => {
    act();
    button.setAttribute(
      'aria-pressed',
      button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true',
    );
  };
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
  bindToggle(container.querySelector('#mic'), actions.toggleMicrophone);
  bindToggle(container.querySelector('#cam'), actions.toggleCamera);
  container.querySelector('#hangup').onclick = actions.hangUp;
};
