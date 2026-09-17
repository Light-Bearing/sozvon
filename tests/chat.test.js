import {describe, expect, it} from 'vitest';
import {MAX_KEPT, MAX_TEXT, createChatLog, timeOf, trimText} from '../src/chat.js';

describe('чистка написанного', () => {
  it('обрезает края и лишние пустые строки', () => {
    expect(trimText('  привет\n\n\n\nкак дела  ')).toBe('привет\n\nкак дела');
  });

  it('слишком длинное режет', () => {
    expect(trimText('я'.repeat(MAX_TEXT + 500))).toHaveLength(MAX_TEXT);
  });

  it('пустое и мусорное — это не сообщение', () => {
    expect(trimText('   \n  ')).toBe(null);
    expect(trimText('')).toBe(null);
    expect(trimText(undefined)).toBe(null);
    expect(trimText(42)).toBe(null);
  });

  it('разметку не трогает — она всё равно попадёт на экран только текстом', () => {
    expect(trimText('<b>жирно</b>')).toBe('<b>жирно</b>');
  });
});

describe('лента сообщений', () => {
  it('пустая в начале', () => {
    expect(createChatLog().all()).toEqual([]);
  });

  it('добавленное сохраняет, кто и когда', () => {
    const log = createChatLog();

    log.add({text: 'привет', from: 'Пётр', at: 1000});

    expect(log.all()).toEqual([{text: 'привет', from: 'Пётр', mine: false, at: 1000}]);
  });

  it('своё помечается своим', () => {
    const log = createChatLog();

    log.add({text: 'я', from: 'Я', mine: true});

    expect(log.all()[0].mine).toBe(true);
  });

  it('пустое не добавляется и об этом честно сообщает', () => {
    const log = createChatLog();

    expect(log.add({text: '   ', from: 'Пётр'})).toBe(false);
    expect(log.all()).toEqual([]);
  });

  it('разговор не архив: старое уезжает', () => {
    const log = createChatLog({limit: 3});

    for (const t of ['один', 'два', 'три', 'четыре']) log.add({text: t, from: 'Пётр'});

    expect(log.all().map(m => m.text)).toEqual(['два', 'три', 'четыре']);
  });

  it('по умолчанию держим разумное число', () => {
    expect(MAX_KEPT).toBeGreaterThan(50);
  });

  it('забывает всё, когда попросят', () => {
    const log = createChatLog();
    log.add({text: 'привет', from: 'Пётр'});

    log.forget();

    expect(log.all()).toEqual([]);
  });
});

describe('время сообщения', () => {
  it('часы и минуты, без секунд', () => {
    expect(timeOf(Date.UTC(2026, 8, 17, 9, 5))).toMatch(/^\d{2}:\d{2}$/);
  });
});
