// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {bindHotkeys} from '../src/ui/hotkeys.js';

const press = (options = {}) => {
  const event = new KeyboardEvent('keydown', {
    code: 'Space',
    key: ' ',
    bubbles: true,
    cancelable: true,
    ...options,
  });
  (options.on ?? document.body).dispatchEvent(event);
  return event;
};

describe('пробел переключает микрофон', () => {
  let toggleMicrophone;
  let isReady;
  // document переживает тесты, поэтому привязку надо снимать: иначе
  // обработчики прошлых тестов копятся на нём и отвечают за свои старые
  // заглушки — тест «вне звонка молчит» падал именно из-за этого.
  let stop;

  beforeEach(() => {
    document.body.innerHTML = '';
    toggleMicrophone = vi.fn();
    isReady = vi.fn(() => true);
    stop = bindHotkeys(document, {isReady, toggleMicrophone});
  });

  afterEach(() => stop());

  it('переключает и не даёт странице прокрутиться', () => {
    const event = press();

    expect(toggleMicrophone).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('удержание считается одним нажатием', () => {
    press();
    press({repeat: true});
    press({repeat: true});

    expect(toggleMicrophone).toHaveBeenCalledTimes(1);
  });

  it('вне звонка молчит', () => {
    isReady.mockReturnValue(false);

    const event = press();

    expect(toggleMicrophone).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('не мешает вводить имя пробелом', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();

    press({on: input});

    expect(toggleMicrophone).not.toHaveBeenCalled();
  });

  it('не переключает дважды, когда нажата сама кнопка микрофона', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();

    press({on: button});

    expect(toggleMicrophone).not.toHaveBeenCalled();
  });

  it('другие клавиши и сочетания не трогает', () => {
    press({code: 'KeyM', key: 'm'});
    press({ctrlKey: true});
    press({metaKey: true});

    expect(toggleMicrophone).not.toHaveBeenCalled();
  });

  it('отвязка прекращает переключение', () => {
    stop();

    press();

    expect(toggleMicrophone).toHaveBeenCalledTimes(0);

    // afterEach позовёт stop() ещё раз — removeEventListener к этому
    // равнодушен, но привязку надо вернуть, чтобы afterEach снимал своё.
    stop = bindHotkeys(document, {isReady, toggleMicrophone});
  });
});
