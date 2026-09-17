import {describe, expect, it} from 'vitest';
import {ADJECTIVES, MAX_NAME, NOUNS, makeName, trimName} from '../src/names.js';

// Выдаёт заранее заданные значения вместо случайных: первое — выбор
// существительного, второе — прилагательного (именно в таком порядке их
// берёт makeName).
const nth = (noun, adjective) => {
  const values = [noun / NOUNS.length, adjective / ADJECTIVES.length];
  let i = 0;
  return () => values[i++] ?? 0;
};

describe('смешное имя', () => {
  it('состоит из двух слов', () => {
    expect(makeName().split(' ')).toHaveLength(2);
  });

  it('прилагательное согласовано с существительным по роду', () => {
    // Первое прилагательное («Бодрый Бодрая Бодрое») со всеми
    // существительными подряд: род берётся из самого существительного.
    const formFor = index => makeName(nth(index, 0));

    const at = word => NOUNS.findIndex(([noun]) => noun === word);

    expect(formFor(at('Пингвин'))).toBe('Бодрый Пингвин'); // мужской
    expect(formFor(at('Выдра'))).toBe('Бодрая Выдра'); // женский
    expect(formFor(at('Облако'))).toBe('Бодрое Облако'); // средний
  });

  it('имён хватает, чтобы не повторяться в одном разговоре', () => {
    const all = new Set();
    for (let i = 0; i < 400; i++) all.add(makeName());

    expect(all.size).toBeGreaterThan(200);
  });
});

describe('чистка введённого имени', () => {
  it('схлопывает пробелы и обрезает края', () => {
    expect(trimName('  Пётр   Иванович \n')).toBe('Пётр Иванович');
  });

  it('режет слишком длинное', () => {
    expect(trimName('я'.repeat(100))).toHaveLength(MAX_NAME);
  });

  it('пустое и мусорное — это отсутствие имени', () => {
    expect(trimName('   ')).toBe(null);
    expect(trimName('')).toBe(null);
    expect(trimName(undefined)).toBe(null);
    expect(trimName(42)).toBe(null);
  });
});
