import {describe, expect, it} from 'vitest';
import {
  deriveRoomId,
  derivePassword,
  generateSecret,
  linkToSecret,
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

  it('ссылка без секрета и с мусором даёт null', () => {
    expect(linkToSecret('https://light-bearing.github.io/sozvon/')).toBeNull();
    expect(linkToSecret('https://light-bearing.github.io/sozvon/#коротко')).toBeNull();
  });
});
