// @vitest-environment jsdom
import {describe, expect, it, vi} from 'vitest';
import {renderCall} from '../src/ui/call.js';
import {STEPS} from '../src/ladder.js';

// Урезанная разметка экрана звонка — ровно то подмножество #screen-call из
// index.html, которое трогает renderCall().
const root = () => {
  const el = document.createElement('div');
  el.innerHTML = `
    <div id="invite">
      <button data-copy class="tag tag--hung" type="button">
        <span class="tag-label">Нажмите, чтобы скопировать</span>
        <span data-link class="tag-code"></span>
      </button>
      <p class="waiting" id="waiting">Жду, когда зайдут</p>
    </div>
    <div id="tiles" class="tiles"></div>
    <div class="controls">
      <button id="mic" class="btn" type="button"></button>
      <button id="cam" class="btn" type="button"></button>
      <button data-copy class="tag tag--pocket" type="button" hidden>
        <span data-link class="tag-code"></span>
      </button>
      <button id="hangup" class="btn btn--leave" type="button"></button>
    </div>`;
  return el;
};

const baseState = (overrides = {}) => ({
  link: 'https://sozvon.test/#секрет-теста',
  step: STEPS[0],
  self: null,
  mic: true,
  cam: true,
  peers: [],
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
