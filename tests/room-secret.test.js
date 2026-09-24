import {describe, expect, it} from 'vitest';
import {
  derivePassword,
  deriveRoomId,
  generateSecret,
  linkToSecret,
  passFromLink,
  secretToLink,
} from '../src/room-secret.js';

describe('секрет комнаты', () => {
  it('рождается случайным и нужной длины', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
  });

  it('имя комнаты выводится одинаково и не равно секрету', async () => {
    const secret = generateSecret();
    const once = await deriveRoomId(secret);
    const twice = await deriveRoomId(secret);
    expect(once).toBe(twice);
    expect(once).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(once).not.toBe(secret);
  });

  it('ключ и имя комнаты — разные строки', async () => {
    const secret = generateSecret();
    expect(await derivePassword(secret)).not.toBe(await deriveRoomId(secret));
  });

  it('разные секреты дают разные имена комнат', async () => {
    expect(await deriveRoomId(generateSecret()))
      .not.toBe(await deriveRoomId(generateSecret()));
  });

  it('ссылка и секрет ходят туда-обратно', () => {
    const secret = generateSecret();
    const link = secretToLink(secret, 'https://light-bearing.github.io/sozvon/');
    expect(link).toBe(`https://light-bearing.github.io/sozvon/#${secret}`);
    expect(linkToSecret(link)).toBe(secret);
  });

  // Находка 7: сборка в one файл открывается с диска (file://), а в Chrome
  // location.origin для таких адресов — буквально строка "null". Склейка
  // "null" + location.pathname давала битую ссылку вида
  // "null/Users/.../index.html#…" — ровно то, что README предлагает
  // попробовать.
  it('на file:// (Chrome отдаёт location.origin как строку "null") makeLink не начинается с "null"', () => {
    const previous = globalThis.location;
    globalThis.location = {
      origin: 'null',
      pathname: '/Users/kто-то/sozvon/index.html',
      href: 'file:///Users/kто-то/sozvon/index.html',
    };
    try {
      const secret = generateSecret();
      const link = secretToLink(secret);
      expect(link).toBe(`file:///Users/kто-то/sozvon/index.html#${secret}`);
      expect(link.startsWith('null')).toBe(false);
    } finally {
      globalThis.location = previous;
    }
  });

  it('ссылка без секрета и с мусором даёт null', () => {
    expect(linkToSecret('https://light-bearing.github.io/sozvon/')).toBeNull();
    expect(linkToSecret('https://light-bearing.github.io/sozvon/#коротко')).toBeNull();
  });

  it('негодный вход даёт null без исключения', () => {
    expect(linkToSecret('не-ссылка')).toBeNull();
    expect(linkToSecret('')).toBeNull();
    expect(linkToSecret('#хвост')).toBeNull();
  });
});

describe('пропуск в хвосте ссылки', () => {
  const СЕКРЕТ = 'AbCdEfGhIjKlMnOpQrStUv';

  it('ссылка без пропуска выглядит как прежде', () => {
    expect(secretToLink(СЕКРЕТ, 'https://s.test/')).toBe(`https://s.test/#${СЕКРЕТ}`);
  });

  it('пропуск идёт после секрета через точку', () => {
    expect(secretToLink(СЕКРЕТ, 'https://s.test/', 'eyJhIjoi')).toBe(
      `https://s.test/#${СЕКРЕТ}.eyJhIjoi`,
    );
  });

  it('секрет читается и из ссылки с пропуском', () => {
    // Иначе приглашение с ретранслятором перестало бы быть приглашением.
    expect(linkToSecret(`https://s.test/#${СЕКРЕТ}.eyJhIjoi`)).toBe(СЕКРЕТ);
    expect(passFromLink(`https://s.test/#${СЕКРЕТ}.eyJhIjoi`)).toBe('eyJhIjoi');
  });

  it('старые ссылки без пропуска по-прежнему работают', () => {
    expect(linkToSecret(`https://s.test/#${СЕКРЕТ}`)).toBe(СЕКРЕТ);
    expect(passFromLink(`https://s.test/#${СЕКРЕТ}`)).toBe(null);
  });

  it('ссылка настройки ретранслятора за приглашение не сходит', () => {
    // В ней лежит ключ целиком; перепутать её с приглашением значило бы
    // войти в разговор с ключом в адресной строке.
    expect(linkToSecret('https://s.test/#turn=eyJhIjoi')).toBe(null);
  });
});
