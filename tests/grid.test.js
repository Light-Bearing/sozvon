import {describe, expect, it} from 'vitest';
import {bestColumns, lastRowOffset} from '../src/grid.js';

// Числа — примерно рабочая область плиток на разных экранах, за вычетом
// полей и места под док.
const НОУТБУК = {width: 1368, height: 690};
const ТЕЛЕФОН = {width: 350, height: 700};
const ЛЁЖА = {width: 800, height: 250};

describe('сколько столбцов', () => {
  it('четверо на ноутбуке встают квадратом, а не четырьмя башнями', () => {
    // Ровно то, что делал прежний auto-fit: набивал ряд до отказа. Четыре
    // узких столбца на широком экране — самая невыгодная раскладка из
    // возможных.
    expect(bestColumns({count: 4, ...НОУТБУК})).toBe(2);
  });

  it('двое на широком экране — рядом, на узком — друг под другом', () => {
    expect(bestColumns({count: 2, ...НОУТБУК})).toBe(2);
    expect(bestColumns({count: 2, ...ТЕЛЕФОН})).toBe(1);
  });

  it('пятеро на ноутбуке — три и два', () => {
    expect(bestColumns({count: 5, ...НОУТБУК})).toBe(3);
  });

  it('на телефоне в лежачем положении ряд шире, чем столбец', () => {
    expect(bestColumns({count: 4, ...ЛЁЖА})).toBe(2);
    expect(bestColumns({count: 6, ...ЛЁЖА})).toBe(3);
  });

  it('один человек — один столбец', () => {
    expect(bestColumns({count: 1, ...НОУТБУК})).toBe(1);
  });

  it('размера ещё не знаем — не выдумываем', () => {
    // До первого замера ширина нулевая; вернуть здесь что-то бодрое
    // значило бы разложить плитки наугад и переложить их через кадр.
    expect(bestColumns({count: 6, width: 0, height: 0})).toBe(1);
    expect(bestColumns({count: 6, width: 800, height: 0})).toBe(1);
  });

  it('при равной выгоде выигрывает раскладка поспокойнее', () => {
    // Строгое «больше» в переборе: меньше столбцов — меньше дробления.
    const квадрат = {width: 600, height: 600};
    expect(bestColumns({count: 2, ...квадрат})).toBe(1);
  });
});

describe('неполный последний ряд — по центру', () => {
  // Отступ считается в полуклетках: целыми двойку в трёх столбцах не
  // выровнять.
  it('ряд полон — двигать нечего', () => {
    expect(lastRowOffset({count: 4, columns: 2})).toBe(0);
    expect(lastRowOffset({count: 6, columns: 3})).toBe(0);
  });

  it('один в хвосте при двух столбцах — на полклетки вправо', () => {
    expect(lastRowOffset({count: 3, columns: 2})).toBe(1);
  });

  it('двое в хвосте при трёх столбцах — тоже на полклетки', () => {
    expect(lastRowOffset({count: 5, columns: 3})).toBe(1);
  });

  it('один в хвосте при трёх столбцах — на целую клетку', () => {
    expect(lastRowOffset({count: 4, columns: 3})).toBe(2);
  });

  it('трое в хвосте при четырёх — на полклетки', () => {
    expect(lastRowOffset({count: 7, columns: 4})).toBe(1);
  });
});
