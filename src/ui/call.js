// Плитки участников и три кнопки. Больше на этом экране ничего не нужно.

const tile = (id, stream, label) => {
  const box = document.createElement('div');
  box.className = 'tile';
  box.dataset.peer = id;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = label === 'Вы';
  if (stream) video.srcObject = stream;

  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = label;

  box.append(video, name);
  return box;
};

export const renderCall = (container, state, actions) => {
  const grid = container.querySelector('#tiles');
  grid.replaceChildren(
    tile('self', state.self, 'Вы'),
    ...state.peers.map(({peerId, stream}) => tile(peerId, stream, 'Собеседник')),
  );

  container.querySelector('#link').value = state.link;
  container.querySelector('#waiting').hidden = state.peers.length > 0;

  container.querySelector('#mic').onclick = actions.toggleMicrophone;
  container.querySelector('#cam').onclick = actions.toggleCamera;
  container.querySelector('#hangup').onclick = actions.hangUp;
  container.querySelector('#copy').onclick = () =>
    navigator.clipboard.writeText(state.link);
};
