// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {explainFailure, explainTrouble, showScreen} from '../src/ui/screens.js';

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
});
