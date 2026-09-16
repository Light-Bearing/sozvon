// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {renderCall} from '../src/ui/call.js';
import {explainTrouble} from '../src/ui/screens.js';
import {STEPS} from '../src/ladder.js';

// Разметку берём из настоящего index.html, а не переписываем от руки:
// рукописная копия уже однажды отстала от оригинала, и тест проходил на
// разметке, которой в приложении нет. Здесь же отсутствующий узел валит
// тест сразу — как и должно быть.
// В jsdom-окружении import.meta.url — адрес http, а не file, поэтому путь
// считаем от корня проекта: vitest запускается именно из него.
const HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

const root = () =>
  new DOMParser().parseFromString(HTML, 'text/html').querySelector('#screen-call');

const baseState = (overrides = {}) => ({
  link: 'https://sozvon.test/#секрет-теста',
  step: STEPS[0],
  self: null,
  mic: true,
  cam: true,
  peers: [],
  troubles: [],
  ...overrides,
});

const fakeActions = () => ({
  toggleMicrophone: vi.fn(),
  toggleCamera: vi.fn(),
  hangUp: vi.fn(),
});

// Находка 2: renderCall получал state = {link, step, self, peers} — без
// состояния микрофона и камеры интерфейс физически не мог показать правду.
// bindToggle сам решал, что показать после клика (просто инвертировал
// прежнее значение атрибута), поэтому второй звонок подряд с иным
// стартовым состоянием — или любое расхождение атрибута с реальностью —
// показывал ровно обратное тому, что происходит на самом деле.
describe('кнопки микрофона и камеры показывают состояние комнаты, а не переключаются вслепую', () => {
  it('aria-pressed выставляется из state при первой отрисовке', () => {
    const el = root();
    renderCall(el, baseState({mic: false, cam: true}), fakeActions());

    expect(el.querySelector('#mic').getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('#cam').getAttribute('aria-pressed')).toBe('true');
  });

  it('второй звонок подряд с выключенным микрофоном не показывает его включённым', () => {
    const el = root();
    // Первый звонок: человек выключил микрофон, и это последнее, что
    // отрисовал экран звонка.
    renderCall(el, baseState({mic: false}), fakeActions());
    expect(el.querySelector('#mic').getAttribute('aria-pressed')).toBe('false');

    // Новый звонок начинается со свежим состоянием комнаты (room.js заводит
    // намерение заново). Раньше разметка это никак не отражала: атрибут
    // оставался от предыдущего звонка, а первый клик его инвертировал бы
    // ещё дальше от истины.
    renderCall(el, baseState({mic: true}), fakeActions());
    expect(el.querySelector('#mic').getAttribute('aria-pressed')).toBe('true');
  });

  it('клик по кнопке вызывает действие и не трогает aria-pressed напрямую', () => {
    const el = root();
    const actions = fakeActions();
    renderCall(el, baseState({mic: true}), actions);

    el.querySelector('#mic').click();

    expect(actions.toggleMicrophone).toHaveBeenCalledTimes(1);
    // Атрибут не поменялся сам по себе кликом — он обновится только когда
    // придёт новый state и случится следующий renderCall().
    expect(el.querySelector('#mic').getAttribute('aria-pressed')).toBe('true');
  });

  it('повторная отрисовка с новым state меняет aria-pressed кнопки камеры', () => {
    const el = root();
    renderCall(el, baseState({cam: true}), fakeActions());
    expect(el.querySelector('#cam').getAttribute('aria-pressed')).toBe('true');

    renderCall(el, baseState({cam: false}), fakeActions());
    expect(el.querySelector('#cam').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('state.step управляет доступностью кнопки камеры', () => {
  it('на ступени без видео (voice) кнопка камеры недоступна', () => {
    const el = root();
    const voice = STEPS.at(-1);
    expect(voice.videoFor).toBe('none');

    renderCall(el, baseState({step: voice, cam: true}), fakeActions());

    expect(el.querySelector('#cam').disabled).toBe(true);
  });

  it('на ступенях с видео кнопка камеры доступна', () => {
    const el = root();
    for (const step of STEPS.filter(s => s.videoFor !== 'none')) {
      renderCall(el, baseState({step}), fakeActions());
      expect(el.querySelector('#cam').disabled).toBe(false);
    }
  });

  it('кнопка микрофона доступна на любой ступени — звук лестница никогда не ограничивает', () => {
    const el = root();
    for (const step of STEPS) {
      renderCall(el, baseState({step}), fakeActions());
      expect(el.querySelector('#mic').disabled).toBe(false);
    }
  });
});

// Провал прямого соединения не производит ни одного события библиотеки:
// без этой ветки экран показывал «Жду, когда зайдут» бесконечно.
describe('беда со связью названа на экране', () => {
  it('без беды карточка беды спрятана, а «жду» на месте', () => {
    const el = root();
    renderCall(el, baseState(), fakeActions());

    expect(el.querySelector('#trouble').hidden).toBe(true);
    expect(el.querySelector('#waiting').hidden).toBe(false);
  });

  it('беда вытесняет и «жду», и «каналы молчат»', () => {
    const el = root();
    renderCall(el, baseState({quiet: true, troubles: ['no-path']}), fakeActions());

    expect(el.querySelector('#trouble').hidden).toBe(false);
    expect(el.querySelector('#waiting').hidden).toBe(true);
    expect(el.querySelector('#quiet').hidden).toBe(true);
    // Сам текст проверяется там, где он живёт (tests/screens.test.js);
    // здесь — только что на экран попал именно он, а не что-то своё.
    const {title, advice} = explainTrouble('no-path');
    expect(el.querySelector('#trouble-title').textContent).toBe(title);
    expect(el.querySelector('#trouble-advice').textContent).toBe(advice);
  });

  it('карточка со ссылкой возвращается, даже когда собеседники уже есть', () => {
    const el = root();
    const peers = [{peerId: 'петя', stream: null}];

    renderCall(el, baseState({peers}), fakeActions());
    expect(el.querySelector('#invite').hidden).toBe(true);

    renderCall(el, baseState({peers, troubles: ['no-path']}), fakeActions());
    expect(el.querySelector('#invite').hidden).toBe(false);
  });

  it('ушедшая беда снова прячет карточку', () => {
    const el = root();
    renderCall(el, baseState({troubles: ['no-path']}), fakeActions());

    renderCall(el, baseState({troubles: []}), fakeActions());

    expect(el.querySelector('#trouble').hidden).toBe(true);
    expect(el.querySelector('#waiting').hidden).toBe(false);
  });
});

// Плитки пересобирались заново на каждое изменение состояния — а их в
// разговоре много: чужая дорожка, чужое имя, своё нажатие, такт лестницы.
// Каждая пересборка убивает <video> и создаёт новый, то есть обрывает и
// картинку, и звук. На своей машине это мелькание, на телефоне — «ничего
// не слышно» и «видео пропадает при переключении микрофона».
describe('плитки переживают перерисовку', () => {
  const peer = (overrides = {}) => ({peerId: 'петя', stream: null, name: null, ...overrides});

  it('тот же собеседник — тот же узел video, а не новый', () => {
    const el = root();
    renderCall(el, baseState({peers: [peer()]}), fakeActions());
    const было = el.querySelector('[data-peer="петя"] video');

    renderCall(el, baseState({peers: [peer({name: 'Пётр'})]}), fakeActions());

    expect(el.querySelector('[data-peer="петя"] video')).toBe(было);
  });

  it('имя меняется на месте', () => {
    const el = root();
    renderCall(el, baseState({peers: [peer()]}), fakeActions());

    renderCall(el, baseState({peers: [peer({name: 'Пётр'})]}), fakeActions());

    expect(el.querySelector('[data-peer="петя"] .tile-name').textContent).toBe('Пётр');
  });

  it('srcObject не переставляется, пока поток тот же', () => {
    const el = root();
    const stream = {getVideoTracks: () => [], getAudioTracks: () => []};
    renderCall(el, baseState({peers: [peer({stream})]}), fakeActions());
    const video = el.querySelector('[data-peer="петя"] video');
    let присвоений = 0;
    let текущий = video.srcObject;
    Object.defineProperty(video, 'srcObject', {
      get: () => текущий,
      set: v => {
        присвоений++;
        текущий = v;
      },
    });

    renderCall(el, baseState({peers: [peer({stream})]}), fakeActions());

    expect(присвоений).toBe(0);
  });

  it('ушедший собеседник уносит свою плитку', () => {
    const el = root();
    renderCall(el, baseState({peers: [peer()]}), fakeActions());

    renderCall(el, baseState({peers: []}), fakeActions());

    expect(el.querySelector('[data-peer="петя"]')).toBe(null);
    expect(el.querySelectorAll('#tiles .tile')).toHaveLength(1);
  });

  it('свою плитку тоже не пересоздаём', () => {
    const el = root();
    renderCall(el, baseState(), fakeActions());
    const было = el.querySelector('[data-peer="self"] video');

    renderCall(el, baseState({mic: false}), fakeActions());

    expect(el.querySelector('[data-peer="self"] video')).toBe(было);
  });
});

// «Меня не слышно» неотличимо от «микрофон не работает», пока человек не
// видит, доходит ли звук хотя бы до его собственного компьютера.
describe('уровень звука на кнопке микрофона', () => {
  const уровень = el => Number(el.querySelector('#mic').style.getPropertyValue('--level'));

  it('тишина — кольца нет', () => {
    const el = root();
    renderCall(el, baseState({mic: true, level: 0}), fakeActions());

    expect(уровень(el)).toBe(0);
  });

  it('голос поднимает кольцо', () => {
    const el = root();
    renderCall(el, baseState({mic: true, level: 0.05}), fakeActions());

    expect(уровень(el)).toBeGreaterThan(0);
  });

  it('громче — выше, но не выше единицы', () => {
    const el = root();
    renderCall(el, baseState({mic: true, level: 0.02}), fakeActions());
    const тихо = уровень(el);
    renderCall(el, baseState({mic: true, level: 0.3}), fakeActions());
    const громко = уровень(el);

    expect(громко).toBeGreaterThan(тихо);
    expect(уровень(el)).toBeLessThanOrEqual(1);
    renderCall(el, baseState({mic: true, level: 1}), fakeActions());
    expect(уровень(el)).toBe(1);
  });

  it('выключенный микрофон не светится, каким бы ни был последний замер', () => {
    const el = root();
    renderCall(el, baseState({mic: false, level: 0.5}), fakeActions());

    expect(уровень(el)).toBe(0);
  });
});

// Признак «глухая» у чужой дорожки означает «прямо сейчас нет данных» и
// включается сам собой при пересогласовании — а кадры при этом идут.
// Я на это однажды купился и затемнил плитку поверх работающего видео.
describe('когда плитка считается тёмной', () => {
  const дорожка = (over = {}) => ({
    kind: 'video',
    enabled: true,
    muted: false,
    readyState: 'live',
    ...over,
  });
  const поток = (...tracks) => ({
    getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    getTracks: () => tracks,
  });
  const тёмная = (el, кто) => el.querySelector(`[data-peer="${кто}"]`).classList.contains('tile--dark');

  it('живая дорожка — картинка есть', () => {
    const el = root();
    renderCall(el, baseState({peers: [{peerId: 'петя', stream: поток(дорожка()), name: null}]}), fakeActions());

    expect(тёмная(el, 'петя')).toBe(false);
  });

  it('глухая, но живая — всё равно картинка: кадры идут', () => {
    const el = root();
    const peers = [{peerId: 'петя', stream: поток(дорожка({muted: true})), name: null}];

    renderCall(el, baseState({peers}), fakeActions());

    expect(тёмная(el, 'петя')).toBe(false);
  });

  it('кончившаяся дорожка — картинки нет', () => {
    const el = root();
    const peers = [{peerId: 'петя', stream: поток(дорожка({readyState: 'ended'})), name: null}];

    renderCall(el, baseState({peers}), fakeActions());

    expect(тёмная(el, 'петя')).toBe(true);
  });

  it('погашенная хозяином — картинки нет', () => {
    const el = root();
    const peers = [{peerId: 'петя', stream: поток(дорожка({enabled: false})), name: null}];

    renderCall(el, baseState({peers}), fakeActions());

    expect(тёмная(el, 'петя')).toBe(true);
  });

  it('только звук — картинки нет', () => {
    const el = root();
    const звук = {kind: 'audio', enabled: true, muted: false, readyState: 'live'};
    const peers = [{peerId: 'петя', stream: поток(звук), name: null}];

    renderCall(el, baseState({peers}), fakeActions());

    expect(тёмная(el, 'петя')).toBe(true);
  });
});
