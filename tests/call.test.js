// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {renderCall} from '../src/ui/call.js';
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
    expect(el.querySelector('#trouble-title').textContent).toContain('канал к нему');
    expect(el.querySelector('#trouble-advice').textContent).toContain('раздача интернета');
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
