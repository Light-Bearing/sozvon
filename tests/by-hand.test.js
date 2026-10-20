import {describe, expect, it} from 'vitest';
import {codeFrom} from '../src/signal/by-hand.js';

describe('код ответа из того, что вставил человек', () => {
  const код = 'H4sIAAAAAAAAA' + 'x'.repeat(60);

  it('сам код — как есть', () => {
    expect(codeFrom(код)).toBe(код);
  });

  it('код внутри сообщения с приветствием', () => {
    expect(codeFrom(`Привет! Вот ответ: ${код} — жду`)).toBe(код);
  });

  it('код в хвосте ссылки', () => {
    expect(codeFrom(`https://example.org/sozvon/#m.${код}`)).toBe(код);
  });

  it('кода нет — так и говорим, а не гадаем', () => {
    expect(codeFrom('привет, а где код?')).toBe(null);
    expect(codeFrom('')).toBe(null);
    expect(codeFrom(undefined)).toBe(null);
  });
});
