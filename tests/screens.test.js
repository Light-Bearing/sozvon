// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {explainFailure, explainStep, explainTrouble, showScreen} from '../src/ui/screens.js';
import {STEPS} from '../src/ladder.js';

const root = () => {
  const el = document.createElement('div');
  el.innerHTML = `
    <section id="screen-start"></section>
    <section id="screen-join" hidden></section>
    <section id="screen-call" hidden></section>
    <section id="screen-failed" hidden></section>`;
  return el;
};

describe('переключение экранов', () => {
  it('показывает один и прячет остальные', () => {
    const el = root();
    showScreen(el, 'join');
    expect(el.querySelector('#screen-join').hidden).toBe(false);
    expect(el.querySelector('#screen-start').hidden).toBe(true);
    expect(el.querySelector('#screen-call').hidden).toBe(true);
  });

  it('повторный показ того же экрана ничего не портит', () => {
    const el = root();
    showScreen(el, 'call');
    showScreen(el, 'call');
    expect(el.querySelector('#screen-call').hidden).toBe(false);
  });

  it('неизвестный экран — ошибка, а не пустая страница', () => {
    expect(() => showScreen(root(), 'подвал')).toThrow();
  });
});

describe('объяснение неудачи', () => {
  it('отказ в камере объясняется без терминов', () => {
    const {title, advice} = explainFailure(
      Object.assign(new Error('denied'), {name: 'NotAllowedError'}),
    );
    expect(title).toMatch(/камер|микрофон/i);
    expect(advice).not.toMatch(/getUserMedia|NotAllowedError|WebRTC/);
  });

  it('отсутствие камеры отличается от отказа', () => {
    const noDevice = explainFailure(
      Object.assign(new Error('none'), {name: 'NotFoundError'}),
    );
    const denied = explainFailure(
      Object.assign(new Error('denied'), {name: 'NotAllowedError'}),
    );
    expect(noDevice.title).not.toBe(denied.title);
  });

  it('незнакомая беда тоже получает человеческий текст', () => {
    const {title, advice} = explainFailure(new Error('что-то странное'));
    expect(title.length).toBeGreaterThan(0);
    expect(advice.length).toBeGreaterThan(0);
    expect(advice).not.toMatch(/Error|undefined/);
  });

  it('пустая ошибка не роняет объяснение', () => {
    expect(() => explainFailure(undefined)).not.toThrow();
  });
});

describe('объяснение беды со связью', () => {
  it('нет прямого пути — называем причину и отправляем в проверку связи', () => {
    const {title, advice} = explainTrouble('no-path');

    expect(title).toBe('Прямого пути между вашими сетями нет');
    expect(advice).toContain('Проверить связь');
  });

  // Совет годится, только когда собеседники в одной комнате: двоим в разных
  // странах менять сеть не на что, и «раздайте с телефона» им просто врёт.
  it('не советует раздавать интернет с телефона как решение', () => {
    expect(explainTrouble('no-path').advice).not.toContain('раздач');
    expect(explainFailure(new Error('что угодно')).advice).not.toContain('раздат');
  });

  it('чужой ключ — просим прислать ссылку целиком', () => {
    expect(explainTrouble('wrong-key').advice).toContain('после решётки');
  });

  it('незнакомая беда не притворяется знакомой', () => {
    expect(explainTrouble('unknown').title).toBe('Соединиться с собеседником не вышло');
    expect(explainTrouble(undefined).title).toBe('Соединиться с собеседником не вышло');
  });

  it('когда за бортом несколько — сперва счёт, потом причина', () => {
    // Живой разговор на пятерых: двое не видели друг друга, а экран
    // говорил ровно то же, что сказал бы при одном недостижимом. Счёт —
    // единственное, из чего видно, что разговор идёт, но не весь.
    const {title, advice} = explainTrouble([
      {peerId: 'петя', kind: 'no-path'},
      {peerId: 'вася', kind: 'no-path'},
    ]);

    expect(title).toBe('Связь не встала с двумя участниками');
    expect(advice).toContain('Остальных вы видите и слышите');
  });

  it('с одним — по-прежнему причина, а не счёт', () => {
    expect(explainTrouble([{peerId: 'петя', kind: 'no-path'}]).title).toBe(
      'Прямого пути между вашими сетями нет',
    );
  });

  it('из нескольких причин выбирается самая объяснительная', () => {
    // «Оборвалось на полуслове» ничего не советует, «прямого пути нет» —
    // советует. Показать надо то, из чего понятно, что делать.
    const {advice} = explainTrouble([
      {peerId: 'петя', kind: 'handshake'},
      {peerId: 'вася', kind: 'no-path'},
    ]);

    expect(advice).toContain('не выпускает');
  });

  it('без ретранслятора про него говорят, с ретранслятором — молчат', () => {
    const беда = [{peerId: 'петя', kind: 'no-path'}];

    expect(explainTrouble(беда, {relayReady: false}).advice).toContain('Ретранслятор');
    expect(explainTrouble(беда, {relayReady: true}).advice).not.toContain('Ретранслятор');
  });

  it('пустой список — нечего и показывать', () => {
    expect(explainTrouble([])).toEqual({title: '', advice: ''});
  });
});

describe('лестница качества объясняется словами', () => {
  it('пока камеры у всех — говорить нечего', () => {
    expect(explainStep(STEPS[0], 2)).toBe('');
    expect(explainStep(STEPS[1], 4)).toBe('');
  });

  it('с пяти человек — камера у говорящего, и об этом сказано', () => {
    // Иначе выключенные лестницей камеры выглядят как поломка: все плитки
    // тёмные, и непонятно, кто виноват и что чинить.
    expect(explainStep(STEPS[2], 5)).toBe('Вас 5 — камера включается у того, кто говорит');
  });

  it('с девяти — один звук', () => {
    expect(explainStep(STEPS[3], 9)).toBe('Вас 9 — идёт только звук, без камер');
  });

  it('без ступени молчим', () => {
    expect(explainStep(null, 5)).toBe('');
  });
});
