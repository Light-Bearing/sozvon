// Окно переписки.
//
// Чужой текст попадает на экран ТОЛЬКО через textContent. Ни одной строки
// из сети рядом с innerHTML быть не должно: это единственное место, куда
// собеседник может написать что угодно.

import {isReaction, timeOf} from '../chat.js';

const bubble = ({text, from, mine, at}) => {
  const box = document.createElement('div');
  box.className = mine ? 'msg msg--mine' : 'msg';

  const who = document.createElement('span');
  who.className = 'msg-who';
  who.textContent = `${mine ? 'вы' : (from ?? 'собеседник')} · ${timeOf(at)}`;

  const body = document.createElement('span');
  // Значок в ленте показываем крупно: мелким он читается как опечатка,
  // а не как ответ. Это тот же текст, просто другого кегля.
  if (isReaction(text)) body.className = 'msg-reaction';
  body.textContent = text;

  box.append(who, body);
  return box;
};

// Что уже нарисовано в ленте: сообщение → его пузырь.
const drawn = new WeakMap();

export const renderChat = (container, state) => {
  const log = container.querySelector('#chat-log');
  if (!log) return;

  const messages = state.messages ?? [];
  // Прокручиваем вниз, только если человек и так стоял внизу: иначе
  // чтение старого рвалось бы на каждом новом сообщении.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

  // Дописываем только новое, а не пересобираем ленту: она рисуется на
  // каждом кадре разговора, и экранный диктор, следящий за лентой, читал
  // бы всю переписку заново с каждой перерисовкой.
  const shown = drawn.get(log) ?? new Map();
  const wanted = new Set(messages);
  for (const [message, node] of shown) {
    if (!wanted.has(message)) {
      node.remove();
      shown.delete(message);
    }
  }
  for (const message of messages) {
    if (shown.has(message)) continue;
    const node = bubble(message);
    log.append(node);
    shown.set(message, node);
  }
  drawn.set(log, shown);
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

  // Escape закрывает переписку, и фокус возвращается на её кнопку, чтобы
  // человек с клавиатуры остался там, откуда пришёл.
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
    root.querySelector('#chat-open')?.focus();
  });

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

  // Реакция уходит сразу, без «отправить»: в этом вся её польза — одно
  // касание вместо «разблокировать, набрать, послать».
  for (const button of root.querySelectorAll('[data-reaction]')) {
    button.onclick = () => void actions.say?.(button.dataset.reaction);
  }

  root.querySelector('#chat-open').onclick = () => (panel.hidden ? open() : close());
  root.querySelector('#chat-close').onclick = close;

  return {open, close, isOpen: () => !panel.hidden};
};
