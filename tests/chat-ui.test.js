// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {createChat, renderChat} from '../src/ui/chat.js';

const HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const root = () => new DOMParser().parseFromString(HTML, 'text/html').querySelector('#screen-call');

const msg = (over = {}) => ({text: 'привет', from: 'Пётр', mine: false, at: Date.now(), ...over});

describe('лента переписки на экране', () => {
  it('пока пусто — объясняем, зачем это окно', () => {
    const el = root();

    renderChat(el, {messages: []});

    expect(el.querySelector('#chat-empty').hidden).toBe(false);
    expect(el.querySelectorAll('.msg')).toHaveLength(0);
  });

  it('сообщения показываются, своё отличается от чужого', () => {
    const el = root();

    renderChat(el, {messages: [msg(), msg({text: 'ответ', mine: true})]});

    const пузыри = el.querySelectorAll('.msg');
    expect(пузыри).toHaveLength(2);
    expect(пузыри[0].classList.contains('msg--mine')).toBe(false);
    expect(пузыри[1].classList.contains('msg--mine')).toBe(true);
    expect(el.querySelector('#chat-empty').hidden).toBe(true);
  });

  // Единственное место, куда собеседник пишет что угодно. Ни одной строки
  // из сети рядом с innerHTML быть не должно.
  it('разметка из сообщения остаётся текстом, а не становится разметкой', () => {
    const el = root();

    renderChat(el, {messages: [msg({text: '<img src=x onerror=alert(1)>'})]});

    const пузырь = el.querySelector('.msg');
    expect(пузырь.querySelector('img')).toBe(null);
    expect(пузырь.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('имя собеседника тоже только текст', () => {
    const el = root();

    renderChat(el, {messages: [msg({from: '<b>жирный</b>'})]});

    expect(el.querySelector('.msg-who b')).toBe(null);
  });

  it('непрочитанное показывается числом, прочитанное прячется', () => {
    const el = root();

    renderChat(el, {messages: [], unread: 3});
    expect(el.querySelector('#chat-badge').hidden).toBe(false);
    expect(el.querySelector('#chat-badge').textContent).toBe('3');

    renderChat(el, {messages: [], unread: 0});
    expect(el.querySelector('#chat-badge').hidden).toBe(true);
  });

  it('очень много непрочитанного не ломает значок', () => {
    const el = root();

    renderChat(el, {messages: [], unread: 250});

    expect(el.querySelector('#chat-badge').textContent).toBe('99+');
  });
});

describe('окно переписки', () => {
  const setup = () => {
    const el = root();
    const actions = {say: vi.fn(() => true), read: vi.fn()};
    return {el, actions, chat: createChat(el, actions)};
  };

  it('открывается и закрывается кнопкой', () => {
    const {el, chat} = setup();

    chat.open();
    expect(el.querySelector('#chat').hidden).toBe(false);

    el.querySelector('#chat-close').click();
    expect(el.querySelector('#chat').hidden).toBe(true);
  });

  it('открытие помечает прочитанным', () => {
    const {actions, chat} = setup();

    chat.open();

    expect(actions.read).toHaveBeenCalled();
  });

  it('отправка очищает поле', () => {
    const {el, actions} = setup();
    const поле = el.querySelector('#chat-text');
    поле.value = 'привет';

    el.querySelector('#chat-form').dispatchEvent(new Event('submit', {cancelable: true}));

    expect(actions.say).toHaveBeenCalledWith('привет');
    expect(поле.value).toBe('');
  });

  it('пустое не отправляется и поле не чистит', () => {
    const {el, actions} = setup();
    actions.say.mockReturnValue(false);
    const поле = el.querySelector('#chat-text');
    поле.value = '   ';

    el.querySelector('#chat-form').dispatchEvent(new Event('submit', {cancelable: true}));

    expect(поле.value).toBe('   ');
  });

  it('Enter отправляет, Shift+Enter переводит строку', () => {
    const {el, actions} = setup();
    const поле = el.querySelector('#chat-text');
    поле.value = 'привет';

    поле.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, cancelable: true}));
    expect(actions.say).not.toHaveBeenCalled();

    поле.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', cancelable: true}));
    expect(actions.say).toHaveBeenCalledWith('привет');
  });
});
