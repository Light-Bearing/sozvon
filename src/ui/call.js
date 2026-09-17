// Экран звонка. Пока никто не зашёл, главное на нём — ссылка, а своя
// камера служит фоном: комната не выглядит пустой, и сразу видно, что
// камера работает. Как только появился собеседник, фон уходит, плитки
// занимают экран, а ссылка сворачивается в кнопку у остальных.
//
// Вход в разговор молчаливый — камеры может не быть вовсе, пока человек
// сам её не включит. Фон и плитка это не прячут и не подделывают: без
// картинки плитка темнеет и показывает инициал (см. hasPicture() ниже и
// .tile--dark в style.css), а фон остаётся своим спокойным градиентом.

import {playThrough} from '../devices.js';
import {explainTrouble} from './screens.js';

// Картинка есть, когда дорожка жива и не погашена хозяином.
//
// Про muted намеренно НЕ спрашиваем, хотя соблазн велик. У чужой дорожки
// этот признак означает «прямо сейчас нет данных» и сам собой включается
// при пересогласовании — а кадры при этом идут. Один раз я на это купился
// и затемнил плитку поверх работающего видео.
//
// Выключенная камера собеседника сюда доходит другим путём, надёжным:
// дорожка снимается с соединения, кончается, и мы убираем её из потока
// (см. onPeerTrack в src/signal/public-channels.js).
const hasPicture = stream =>
  stream?.getVideoTracks().some(track => track.enabled && track.readyState !== 'ended');

// Плитку НЕ пересоздаём, если она уже есть. Раньше весь список собирался
// заново на каждое изменение состояния — а их в разговоре много: чужая
// дорожка, чужое имя, своё нажатие, такт лестницы. Каждая пересборка
// убивает <video> и создаёт новый, то есть обрывает и картинку, и звук.
// На своей машине это мелькание, на телефоне — «ничего не слышно» и
// «видео пропадает, когда трогаешь микрофон».
const makeTile = (id, isSelf) => {
  const box = document.createElement('div');
  box.className = isSelf ? 'tile tile--self' : 'tile';
  box.dataset.peer = id;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // Себя слушать не надо — иначе эхо и вой.
  video.muted = isSelf;

  const name = document.createElement('span');
  name.className = 'tile-name';

  box.append(video, name);
  return box;
};

// Браузеры телефонов не начинают играть со звуком сами. Отказ приходит
// молча и выглядит ровно как «собеседник молчит» — поэтому спрашиваем
// прямо, одной кнопкой на весь экран.
const blocked = new Set();

const askForSound = container => {
  const button = container.querySelector('#sound-blocked');
  if (!button) return;
  button.hidden = blocked.size === 0;
  button.onclick = () => {
    blocked.clear();
    for (const video of container.querySelectorAll('#tiles video')) {
      try {
        const идёт = video.play?.();
        if (идёт && typeof идёт.catch === 'function') идёт.catch(() => {});
      } catch {
        // Не вышло — кнопка вернётся на следующей перерисовке.
      }
    }
    button.hidden = true;
  };
};

const updateTile = (box, stream, label, isSelf, speaker, speaking) => {
  const video = box.querySelector('video');
  // Присваиваем srcObject только когда поток и вправду сменился: лишнее
  // присваивание перезапускает проигрывание.
  const source = stream ?? null;
  if (video.srcObject !== source) {
    video.srcObject = source;
    // Браузеры телефонов не начинают играть со звуком сами по себе.
    // Отказ — не беда: человек уже нажимал «Войти», и следующее касание
    // экрана всё запустит. play() возвращает обещание не везде (в разметке
    // без настоящего проигрывателя — вообще ничего), поэтому и вызов, и
    // отказ обёрнуты.
    try {
      const идёт = video.play?.();
      if (идёт && typeof идёт.catch === 'function') {
        идёт.then(
          () => blocked.delete(box.dataset.peer),
          () => {
            if (!isSelf) blocked.add(box.dataset.peer);
          },
        );
      }
    } catch {
      // Проигрыватель не готов — следующая перерисовка попробует снова.
    }
  }
  // Вывод звука выбирается у проигрывателя, а не у потока, и умеют это не
  // все браузеры — playThrough честно ничего не делает там, где нельзя.
  // Переставляем только при смене: перерисовок теперь много (уровень звука
  // приходит несколько раз в секунду), а setSinkId на каждой из них рвал бы
  // звук.
  if (!isSelf && video.dataset.sink !== String(speaker ?? '')) {
    video.dataset.sink = String(speaker ?? '');
    void playThrough(video, speaker);
  }

  box.classList.toggle('tile--speaking', Boolean(speaking));
  box.classList.toggle('tile--dark', !hasPicture(stream));
  box.dataset.initial = label.slice(0, 1);

  const name = box.querySelector('.tile-name');
  if (name.textContent !== label) name.textContent = label;
};

// Собеседник назвался — зовём как просил. Не назвался (имя ещё не дошло
// или канал обмена недоступен) — по порядку, как раньше.
const nameFor = (name, index, total) =>
  name ?? (total > 1 ? `Собеседник ${index + 1}` : 'Собеседник');

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

  // На своей плитке — своё имя, а не «Вы»: это ровно то, что видят
  // остальные, и другого места проверить его нет.
  const wanted = [
    {id: 'self', stream: state.self, label: state.name ?? 'Вы', isSelf: true},
    ...state.peers.map(({peerId, stream, name}, i) => ({
      id: peerId,
      stream,
      label: nameFor(name, i, state.peers.length),
      isSelf: false,
    })),
  ];

  const tiles = container.querySelector('#tiles');
  const было = new Map([...tiles.children].map(box => [box.dataset.peer, box]));

  for (const {id, stream, label, isSelf} of wanted) {
    const box = было.get(id) ?? makeTile(id, isSelf);
    было.delete(id);
    updateTile(box, stream, label, isSelf, state.speaker, state.speaking?.includes(id));
    // Вставляем ТОЛЬКО новые. append() для узла, который уже лежит здесь,
    // означает «вынуть и вставить заново» — а для <video> это перезапуск
    // проигрывания. Перерисовок теперь несколько в секунду (уровень звука),
    // и отсюда моргание плиток и молчащий звук: проигрыватель не успевает
    // начать, как его уже переставили.
    if (box.parentNode !== tiles) tiles.append(box);
  }
  // Осталось в было — те, кого уже нет.
  for (const box of было.values()) {
    blocked.delete(box.dataset.peer);
    box.remove();
  }

  askForSound(container);

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
    const {title, advice} = explainTrouble(trouble, {relayReady: Boolean(state.relayReady)});
    container.querySelector('#trouble-title').textContent = title;
    container.querySelector('#trouble-advice').textContent = advice;
  }

  // Каналы молчат — говорим об этом, но звонок не прерываем: попытки идут.
  // Названная беда важнее обоих: она объясняет ровно то, чего ждать уже
  // бессмысленно.
  container.querySelector('#waiting').hidden = Boolean(state.quiet || trouble);
  container.querySelector('#quiet').hidden = !state.quiet || Boolean(trouble);

  bindCopy(container, state.link);

  const mic = container.querySelector('#mic');
  bindToggle(mic, state.mic, actions.toggleMicrophone);
  // Уровень звука на самой кнопке: видно, слышит ли вас ваш же компьютер.
  // Корень квадратный растягивает тихую часть шкалы — обычная речь живёт в
  // самом низу, и без него полоска почти не шевелилась бы.
  const level = state.mic ? Math.min(1, Math.sqrt(state.level ?? 0) * 2.2) : 0;
  const прежний = mic.style.getPropertyValue('--level');
  if (прежний !== level.toFixed(2)) mic.style.setProperty('--level', level.toFixed(2));

  // В голосовом режиме камеру всё равно держит выключенной лестница
  // качества. Кнопка, которая на вид работает, а на деле ничего не меняет,
  // и есть тихая ложь — недоступность честнее показать явно.
  const camButton = container.querySelector('#cam');
  camButton.disabled = state.step.videoFor === 'none';
  bindToggle(camButton, state.cam, actions.toggleCamera);

  container.querySelector('#hangup').onclick = actions.hangUp;
};
