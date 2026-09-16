import {describe, expect, it} from 'vitest';
import {TICKET_SECONDS, mintTicket, relayUrls, turnConfigFor} from '../src/turn.js';

describe('адрес ретранслятора', () => {
  it('голый адрес дополняется портом и получает пару — обычную и по TCP', () => {
    expect(relayUrls('195.58.52.143')).toEqual([
      'turn:195.58.52.143:3478',
      'turn:195.58.52.143:3478?transport=tcp',
    ]);
  });

  it('свой порт уважается', () => {
    expect(relayUrls('дом.example:3555')[0]).toBe('turn:дом.example:3555');
  });

  it('лишнее спереди и сзади человек может не вычищать', () => {
    expect(relayUrls('  turn:host:3478?transport=udp  ')).toEqual([
      'turn:host:3478',
      'turn:host:3478?transport=tcp',
    ]);
  });

  it('пустое — это отсутствие ретранслятора, а не ошибка', () => {
    expect(relayUrls('')).toEqual([]);
    expect(relayUrls(undefined)).toEqual([]);
    expect(relayUrls('   ')).toEqual([]);
  });
});

describe('короткий пропуск', () => {
  it('имя — срок годности и метка, через двоеточие', async () => {
    const {username} = await mintTicket('ключ', {now: 1_000_000_000_000});

    const [срок, метка] = username.split(':');
    expect(Number(срок)).toBe(1_000_000_000 + TICKET_SECONDS);
    expect(метка).toBe('sozvon');
  });

  it('пароль — подпись имени, и от ключа зависит', async () => {
    const один = await mintTicket('ключ-один', {now: 0});
    const другой = await mintTicket('ключ-другой', {now: 0});

    expect(один.credential).not.toBe(другой.credential);
    // Подпись SHA-1 — 20 байт, в base64 это 28 знаков.
    expect(один.credential).toHaveLength(28);
  });

  it('совпадает с тем, что считает сам coturn', async () => {
    // Проверочное значение посчитано отдельно тем же правилом, каким его
    // считает сервер: base64(HMAC-SHA1(ключ, имя)).
    const {username, credential} = await mintTicket('секрет', {now: 0, name: 'кто'});

    expect(username).toBe(`${TICKET_SECONDS}:кто`);
    const {createHmac} = await import('node:crypto');
    expect(credential).toBe(createHmac('sha1', 'секрет').update(username).digest('base64'));
  });
});

describe('список для льда', () => {
  it('без настроенного ретранслятора пуст', async () => {
    expect(await turnConfigFor({})).toEqual([]);
    expect(await turnConfigFor({address: 'host'})).toEqual([]);
    expect(await turnConfigFor({secret: 'ключ'})).toEqual([]);
  });

  it('оба адреса получают один и тот же пропуск', async () => {
    const список = await turnConfigFor({address: 'host', secret: 'ключ', now: 0});

    expect(список).toHaveLength(2);
    expect(список[0].username).toBe(список[1].username);
    expect(список[0].credential).toBe(список[1].credential);
    expect(список.map(s => s.urls)).toEqual([
      'turn:host:3478',
      'turn:host:3478?transport=tcp',
    ]);
  });
});
