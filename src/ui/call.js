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
import {explainStep, explainTrouble} from './screens.js';
import {HALVES, bestColumns, lastRowOffset} from '../grid.js';
import {renderChat} from './chat.js';

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
  // Видео всегда беззвучное, и звук собеседника идёт отдельным элементом.
  //
  // Так требует правило автопроигрывания: звучащее видео браузер сам не
  // пускает, беззвучное — пускает всегда. Пока звук и картинка сидели в
  // одном элементе, запрет на звук отнимал заодно и картинку: в Firefox
  // человек входил в разговор и не видел собеседника вовсе. Теперь
  // картинка есть сразу, а звук возвращается одним касанием.
  //
  // Себя не слушаем ни при каких условиях — иначе эхо и вой.
  video.muted = true;

  const name = document.createElement('span');
  name.className = 'tile-name';

  // Что у человека выключено. В разговоре на пятерых это первый вопрос:
  // «его не слышно» — он выключил микрофон или связь не встала? По
  // молчащей дорожке одно от другого не отличить.
  const gear = document.createElement('span');
  gear.className = 'tile-gear';
  gear.innerHTML =
    '<svg class="i i-mute"><use href="#i-mic-off" /></svg>' +
    '<svg class="i i-blind"><use href="#i-cam-off" /></svg>';

  // Крупно — и обратно. Кнопка, а не клик по всей плитке: по плитке
  // промахиваются пальцем, а объявить её читалке экрана нечем.
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'tile-pin';
  pin.innerHTML =
    '<svg class="i i-on"><use href="#i-expand" /></svg>' +
    '<svg class="i i-off"><use href="#i-collapse" /></svg>';

  // Реакция — картинка, а не текст: читалке экрана её объявлять нечего,
  // а подпись рядом уже сказала, чья это плитка.
  const reaction = document.createElement('span');
  reaction.className = 'tile-reaction';
  reaction.hidden = true;
  reaction.setAttribute('aria-hidden', 'true');

  // Своего звука нет и быть не должно, поэтому элемента для него у своей
  // плитки просто нет.
  const sound = isSelf ? null : document.createElement('audio');
  if (sound) sound.autoplay = true;

  box.append(video, ...(sound ? [sound] : []), name, gear, pin, reaction);
  return box;
};

// Размер сетки читаем наблюдателем, а не на каждой перерисовке: перерисовок
// по нескольку в секунду, а каждое чтение размеров заставляет браузер
// пересчитывать раскладку заново.
let gridBox = {width: 0, height: 0};
let gridWatcher = null;
let gridKey = '';

const applyGrid = (tiles, count) => {
  // Не смогли померить (нет наблюдателя — например, в тестовой среде) —
  // не мешаем: в стилях лежит запасная раскладка на auto-fit.
  if (!(gridBox.width > 0) || !(count > 0)) return;

  const columns = bestColumns({count, width: gridBox.width, height: gridBox.height});
  const key = `${columns}|${count}`;
  if (key === gridKey) return;
  gridKey = key;

  // Полуклетки — ради центровки неполного ряда (см. src/grid.js).
  tiles.style.gridTemplateColumns = `repeat(${columns * HALVES}, minmax(0, 1fr))`;
  const offset = lastRowOffset({count, columns});
  const firstOfLastRow = count - (count % columns || columns);
  [...tiles.children].forEach((box, i) => {
    box.style.gridColumn =
      offset && i === firstOfLastRow
        ? `${offset + 1} / span ${HALVES}`
        : `span ${HALVES}`;
  });
};

const watchGrid = tiles => {
  if (gridWatcher || typeof ResizeObserver !== 'function') return;
  gridWatcher = new ResizeObserver(entries => {
    const box = entries[0]?.contentBoxSize?.[0];
    if (!box) return;
    gridBox = {width: box.inlineSize, height: box.blockSize};
    // Размер сменился — прежний выбор столбцов больше ничего не значит.
    gridKey = '';
    applyGrid(tiles, tiles.children.length);
  });
  gridWatcher.observe(tiles);
};

// Куда человек перетащил полоску участников. Живёт здесь, а не в состоянии
// комнаты: за перетаскивание приходит по десятку событий в секунду, и гонять
// их через полную перерисовку — верный способ получить рывки вместо
// движения. Сбрасывается, когда закрепление снимают: в следующий раз
// полоска должна начинаться с угла.
const shift = {x: 0, y: 0};

export const forgetShift = () => {
  shift.x = 0;
  shift.y = 0;
};

const applyShift = tiles => {
  tiles.style.setProperty('--dx', `${shift.x}px`);
  tiles.style.setProperty('--dy', `${shift.y}px`);
};

// Полоску можно двигать: при показе экрана она закрывает как раз то, что
// пришли смотреть, и человек должен мочь её отодвинуть.
const makeDraggable = tiles => {
  if (tiles.dataset.draggable) return;
  tiles.dataset.draggable = 'да';

  let from = null;

  tiles.addEventListener('pointerdown', event => {
    if (!tiles.dataset.pinned) return;
    const box = event.target.closest?.('.tile');
    if (!box || box.classList.contains('tile--pinned')) return;
    // Кнопке — нажатие, а не перетаскивание.
    if (event.target.closest('.tile-pin')) return;

    // Границы считаем один раз, на старте: пока тянут, раскладка не
    // меняется — меняется только сдвиг, и пересчитывать её на каждом
    // событии значило бы мерить десятки раз в секунду впустую.
    const мелкие = [...tiles.querySelectorAll('.tile:not(.tile--pinned)')];
    const края = мелкие.map(t => t.getBoundingClientRect());
    from = {
      x: event.clientX,
      y: event.clientY,
      shiftX: shift.x,
      shiftY: shift.y,
      left: Math.min(...края.map(r => r.left)) - shift.x,
      top: Math.min(...края.map(r => r.top)) - shift.y,
      right: Math.max(...края.map(r => r.right)) - shift.x,
      bottom: Math.max(...края.map(r => r.bottom)) - shift.y,
    };
    tiles.setPointerCapture?.(event.pointerId);
  });

  tiles.addEventListener('pointermove', event => {
    if (!from) return;
    const зажать = (want, low, high) => Math.min(Math.max(want, low), high);
    // Полоска не должна уезжать за край: оттуда её не вернуть.
    shift.x = зажать(
      from.shiftX + event.clientX - from.x,
      -from.left,
      window.innerWidth - from.right,
    );
    shift.y = зажать(
      from.shiftY + event.clientY - from.y,
      -from.top,
      window.innerHeight - from.bottom,
    );
    applyShift(tiles);
  });

  const finish = event => {
    if (!from) return;
    from = null;
    tiles.releasePointerCapture?.(event.pointerId);
  };
  tiles.addEventListener('pointerup', finish);
  tiles.addEventListener('pointercancel', finish);
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
    // Касание человека снимает запрет со всей страницы разом — поэтому
    // будим и звук, и картинку: где-то мог не пойти и беззвучный элемент.
    for (const el of container.querySelectorAll('#tiles audio, #tiles video')) {
      start(el)?.catch(() => {});
    }
    button.hidden = true;
  };
};

// Вспышка реакции. Ставим ровно тогда, когда она сменилась: перерисовок
// несколько в секунду, и без этой проверки значок дёргался бы без конца.
const showReaction = (box, reaction) => {
  const spot = box.querySelector('.tile-reaction');
  if (!spot) return;
  if (!reaction) {
    spot.hidden = true;
    delete spot.dataset.at;
    return;
  }
  if (spot.dataset.at === String(reaction.at)) return;
  spot.dataset.at = String(reaction.at);
  spot.textContent = reaction.emoji;
  spot.hidden = false;
  // Сброс движения: вторая подряд реакция иначе появилась бы неподвижной —
  // анимация уже отыграла и сама себя не повторяет.
  spot.style.animation = 'none';
  void spot.offsetWidth;
  spot.style.animation = '';
};

// Запуск проигрывателя. Возвращает обещание там, где браузер его даёт, и
// ничего — там, где play() нет вовсе (jsdom).
const start = el => {
  try {
    const playing = el.play?.();
    return playing && typeof playing.catch === 'function' ? playing : null;
  } catch {
    return null;
  }
};

// Доводы объектом, а не по порядку: их стало восемь, и перепутать два
// подряд идущих булевых — вопрос времени.
const updateTile = (box, {stream, label, isSelf, speaker, speaking, mirror, reaction, mic, cam}) => {
  const video = box.querySelector('video');
  const sound = box.querySelector('audio');
  // Присваиваем srcObject только когда поток и вправду сменился: лишнее
  // присваивание перезапускает проигрывание.
  const source = stream ?? null;
  if (video.srcObject !== source) {
    video.srcObject = source;
    // play() возвращает обещание не везде (в разметке без настоящего
    // проигрывателя — вообще ничего), поэтому и вызов, и отказ обёрнуты.
    // Беззвучному видео браузеры не отказывают, так что отказ здесь — не
    // про запрет, а про неготовность: следующая перерисовка попробует
    // снова.
    start(video);
  }
  if (sound && sound.srcObject !== source) {
    sound.srcObject = source;
    // А вот звук браузер сам не пустит, пока человек не коснулся страницы.
    // Отказ запоминаем: из него вырастает кнопка «включить звук».
    const playing = start(sound);
    if (playing) {
      playing.then(
        () => blocked.delete(box.dataset.peer),
        () => blocked.add(box.dataset.peer),
      );
    }
  }
  // Вывод звука выбирается у проигрывателя, а не у потока, и умеют это не
  // все браузеры — playThrough честно ничего не делает там, где нельзя.
  // Переставляем только при смене: перерисовок теперь много (уровень звука
  // приходит несколько раз в секунду), а setSinkId на каждой из них рвал бы
  // звук.
  if (sound && sound.dataset.sink !== String(speaker ?? '')) {
    sound.dataset.sink = String(speaker ?? '');
    void playThrough(sound, speaker);
  }

  // Зеркалим только своё и только по просьбе человека. Чужих — никогда:
  // там зеркало показало бы людей не такими, какие они есть.
  // Экран не зеркалим никогда, даже свой: любой текст на нём перевернулся
  // бы, а смысл показа как раз в том, чтобы его читали.
  const isScreen = box.dataset.peer.endsWith('|screen');
  box.classList.toggle('tile--mirror', isSelf && !isScreen && Boolean(mirror));
  box.classList.toggle('tile--speaking', Boolean(speaking));
  box.classList.toggle('tile--dark', !hasPicture(stream));
  box.dataset.initial = label.slice(0, 1);

  const name = box.querySelector('.tile-name');
  if (name.textContent !== label) name.textContent = label;

  showReaction(box, reaction);

  // null — «человек ещё не сказал о себе»: соврать «у него выключен
  // микрофон» хуже, чем промолчать. Экран о себе не рассказывает вовсе.
  //
  // Прятать значки классом, а не свойством hidden: hidden есть у
  // HTMLElement, а <svg> — не он. Присваивание проходит молча, свойство
  // потом честно читается как true, и даже замер подтверждает «скрыт» —
  // а на экране оба значка стоят рядом.
  const gear = box.querySelector('.tile-gear');
  const mute = mic === false;
  const blind = cam === false;
  gear.classList.toggle('tile-gear--mute', mute);
  gear.classList.toggle('tile-gear--blind', blind);
  gear.hidden = !mute && !blind;
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
  // Фон — тоже своё лицо, и расходиться с плиткой он не должен.
  backdrop.classList.toggle('backdrop--mirror', Boolean(state.mirror));

  // На своей плитке — своё имя, а не «Вы»: это ровно то, что видят
  // остальные, и другого места проверить его нет.
  // Экран — отдельная плитка рядом с лицом, а не вместо него: показывать
  // можно и то и другое разом. Подпись сразу говорит, чей это экран.
  const wanted = [
    {
      id: 'self',
      stream: state.self,
      label: state.name ?? 'Вы',
      isSelf: true,
      mic: state.mic,
      cam: state.cam,
    },
    // У плитки экрана значков нет: микрофон и камера — про человека, а не
    // про то, что он показывает.
    ...(state.selfScreen
      ? [{id: 'self|screen', stream: state.selfScreen, label: 'Ваш экран', isSelf: true}]
      : []),
    ...state.peers.flatMap(({peerId, stream, screen, name, mic, cam}, i) => {
      const кто = nameFor(name, i, state.peers.length);
      return [
        {id: peerId, stream, label: кто, isSelf: false, mic, cam},
        ...(screen
          ? [{id: `${peerId}|screen`, stream: screen, label: `Экран · ${кто}`, isSelf: false}]
          : []),
      ];
    }),
  ];

  const tiles = container.querySelector('#tiles');
  watchGrid(tiles);
  const present = new Map([...tiles.children].map(box => [box.dataset.peer, box]));

  // Закреплённый мог уйти из разговора. Держаться за его имя нельзя: экран
  // остался бы пустым, а кнопка «вернуть как было» — ни на чём.
  const ids = new Set(wanted.map(t => t.id));
  const pinned = state.pinned && ids.has(state.pinned) ? state.pinned : null;
  // Закреплять нечего, пока плитка одна.
  const canPin = wanted.length > 1;
  tiles.dataset.pinned = pinned ?? '';
  makeDraggable(tiles);
  if (!pinned) forgetShift();
  applyShift(tiles);
  let small = 0;

  for (const {id, stream, label, isSelf, mic, cam} of wanted) {
    const box = present.get(id) ?? makeTile(id, isSelf);
    present.delete(id);
    updateTile(box, {
      stream,
      label,
      isSelf,
      speaker: state.speaker,
      speaking: state.speaking?.includes(id),
      mirror: state.mirror,
      reaction: state.reactions?.get(id),
      mic,
      cam,
    });
    // Вставляем ТОЛЬКО новые. append() для узла, который уже лежит здесь,
    // означает «вынуть и вставить заново» — а для <video> это перезапуск
    // проигрывания. Перерисовок теперь несколько в секунду (уровень звука),
    // и отсюда моргание плиток и молчащий звук: проигрыватель не успевает
    // начать, как его уже переставили.
    if (box.parentNode !== tiles) tiles.append(box);

    const isPinned = id === pinned;
    box.classList.toggle('tile--pinned', isPinned);
    // Полоска мелких считается по порядку: место каждой задаётся номером,
    // а не отдельным узлом-обёрткой — переносить <video> между родителями
    // значит перезапускать проигрывание.
    if (pinned && !isPinned) box.style.setProperty('--i', String(small++));
    else box.style.removeProperty('--i');

    const pin = box.querySelector('.tile-pin');
    pin.hidden = !canPin;
    pin.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
    pin.setAttribute('aria-label', isPinned ? 'Вернуть как было' : 'Показать крупно');
    pin.onclick = () => actions.togglePin?.(id);
  }
  // Осталось в present — те, кого уже нет.
  for (const box of present.values()) {
    blocked.delete(box.dataset.peer);
    box.remove();
  }

  // Столбцы считаем после того, как плитки на месте: раскладка зависит от
  // их числа. Закреплённый режим сетку не использует вовсе.
  if (pinned) {
    tiles.style.gridTemplateColumns = '';
    gridKey = '';
  } else {
    applyGrid(tiles, wanted.length);
  }

  askForSound(container);

  // Про камеры, выключенные лестницей, молчать нельзя: тёмные плитки
  // выглядят как поломка, а это всего лишь плата за многолюдность.
  const mode = container.querySelector('#mode');
  if (mode) {
    const текст = explainStep(state.step, state.peers.length + 1);
    mode.textContent = текст;
    mode.hidden = !текст;
    // Пометка на сцене — чтобы плитки уступили строке место, а не легли
    // под неё: иначе она накрывает подписи нижнего ряда.
    container.dataset.mode = текст ? 'да' : '';
  }

  // Беда с соединением — единственное, что может вывести карточку обратно
  // на экран, когда собеседники уже есть: если к кому-то не достучаться,
  // ссылка нужна тут же, под объяснением.
  const trouble = state.troubles?.length ? state.troubles : null;

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
  const shown = mic.style.getPropertyValue('--level');
  if (shown !== level.toFixed(2)) mic.style.setProperty('--level', level.toFixed(2));

  // В голосовом режиме камеру всё равно держит выключенной лестница
  // качества. Кнопка, которая на вид работает, а на деле ничего не меняет,
  // и есть тихая ложь — недоступность честнее показать явно.
  const camButton = container.querySelector('#cam');
  camButton.disabled = state.step.videoFor === 'none';
  bindToggle(camButton, state.cam, actions.toggleCamera);

  // Экран умеют не все браузеры — на телефонах getDisplayMedia нет вовсе.
  // Кнопка, которая ничего не делает, хуже её отсутствия.
  const screen = container.querySelector('#screen');
  if (screen) {
    screen.hidden = !state.canShareScreen;
    bindToggle(screen, state.screen, actions.toggleScreen);
    screen.setAttribute(
      'aria-label',
      state.screen ? 'Прекратить показ экрана' : 'Показать экран',
    );
  }

  renderChat(container, state);

  container.querySelector('#hangup').onclick = actions.hangUp;
};
