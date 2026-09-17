// Окно переписки.
//
// Чужой текст попадает на экран ТОЛЬКО через textContent. Ни одной строки
// из сети рядом с innerHTML быть не должно: это единственное место, куда
// собеседник может написать что угодно.

import {timeOf} from '../chat.js';

const bubble = ({text, from, mine, at}) => {
  const box = document.createElement('div');
  box.className = mine ? 'msg msg--mine' : 'msg';

  const who = document.createElement('span');
  who.className = 'msg-who';
  who.textContent = `${mine ? 'вы' : (from ?? 'собеседник')} · ${timeOf(at)}`;

  const body = document.createElement('span');
  body.textContent = text;

  box.append(who, body);
  return box;
};

export const renderChat = (container, state) => {
  const log = container.querySelector('#chat-log');
  if (!log) return;

  const messages = state.messages ?? [];
  // Прокручиваем вниз, только если человек и так стоял внизу: иначе
  // чтение старого рвалось бы на каждом новом сообщении.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

  log.replaceChildren(...messages.map(bubble));
  container.querySelector('#chat-empty').hidden = messages.length > 0;
  if (atBottom) log.scrollTop = log.scrollHeight;

  const badge = container.querySelector('#chat-badge');
  if (badge) {
    const unread = state.unread ?? 0;
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
  }
};

export const createChat = (root, actions) => {
  const panel = root.querySelector('#chat');
  const form = root.querySelector('#chat-form');
  const text = root.querySelector('#chat-text');

  const open = () => {
    panel.hidden = false;
    actions.read?.();
    text.focus();
  };
  const close = () => {
    panel.hidden = true;
  };

  const send = () => {
    if (!actions.say?.(text.value)) return;
    text.value = '';
    text.style.height = '';
  };

  form.onsubmit = event => {
    event.preventDefault();
    send();
  };

  text.oninput = () => {
    // Растём под текст, но не бесконечно: потолок в стилях.
    text.style.height = '';
    text.style.height = `${text.scrollHeight}px`;
  };

  text.onkeydown = event => {
    // Enter отправляет, Shift+Enter переводит строку — как везде.
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    send();
  };

  root.querySelector('#chat-open').onclick = () => (panel.hidden ? open() : close());
  root.querySelector('#chat-close').onclick = close;

  return {open, close, isOpen: () => !panel.hidden};
};
