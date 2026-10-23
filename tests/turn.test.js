import {describe, expect, it} from 'vitest';
import {
  TICKET_SECONDS,
  mintTicket,
  packPass,
  packPassCompact,
  passFor,
  relayUrls,
  serversFromPass,
  turnConfigFor,
  unpackPass,
} from '../src/turn.js';

describe('адрес ретранслятора', () => {
  it('голый адрес дополняется портом: обычный, по TCP и UDP 443 для строгих сетей', () => {
    expect(relayUrls('195.58.52.143')).toEqual([
      'turn:195.58.52.143:3478',
      'turn:195.58.52.143:3478?transport=tcp',
      'turn:195.58.52.143:443?transport=udp',
    ]);
  });

  it('свой порт уважается — и 443 тогда не угадываем', () => {
    expect(relayUrls('дом.example:3555')).toEqual([
      'turn:дом.example:3555',
      'turn:дом.example:3555?transport=tcp',
    ]);
  });

  it('лишнее спереди и сзади человек может не вычищать', () => {
    expect(relayUrls('  turn:host:3478?transport=udp  ')).toEqual([
      'turn:host:3478',
      'turn:host:3478?transport=tcp',
      'turn:host:443?transport=udp',
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
    const one = await mintTicket('ключ-один', {now: 0});
    const another = await mintTicket('ключ-другой', {now: 0});

    expect(one.credential).not.toBe(another.credential);
    // Подпись SHA-1 — 20 байт, в base64 это 28 знаков.
    expect(one.credential).toHaveLength(28);
  });

  it('совпадает с тем, что считает сам coturn', async () => {
    // Проверочное значение посчитано отдельно тем же правилом, каким его
    // считает сервер: base64(HMAC-SHA1(ключ, name)).
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

  it('все адреса получают один и тот же пропуск', async () => {
    const servers = await turnConfigFor({address: 'host', secret: 'ключ', now: 0});

    expect(servers).toHaveLength(3);
    expect(new Set(servers.map(s => s.username)).size).toBe(1);
    expect(new Set(servers.map(s => s.credential)).size).toBe(1);
    expect(servers.map(s => s.urls)).toEqual([
      'turn:host:3478',
      'turn:host:3478?transport=tcp',
      'turn:host:443?transport=udp',
    ]);
  });
});

describe('настройка ретранслятора ссылкой', () => {
  const makeLink = (field, ключ) => {
    const json = JSON.stringify({a: field, k: ключ});
    const b64 = Buffer.from(json).toString('base64url');
    return `https://sozvon.test/#turn=${b64}`;
  };

  it('адрес и ключ достаются из хвоста', async () => {
    const {relayFromLink} = await import('../src/turn.js');

    expect(relayFromLink(makeLink('195.58.52.143', 'ключ-сервера'))).toEqual({
      address: '195.58.52.143',
      secret: 'ключ-сервера',
    });
  });

  it('обычная makeLink на разговор настройкой не считается', async () => {
    const {relayFromLink} = await import('../src/turn.js');

    expect(relayFromLink('https://sozvon.test/#1shRJ554WgkcmxgI-ERoLA')).toBe(null);
    expect(relayFromLink('https://sozvon.test/')).toBe(null);
  });

  it('испорченная makeLink не роняет приложение', async () => {
    const {relayFromLink} = await import('../src/turn.js');

    expect(relayFromLink('https://sozvon.test/#turn=это-не-base64!!')).toBe(null);
    expect(relayFromLink('не makeLink вовсе')).toBe(null);
    expect(relayFromLink(makeLink('', 'ключ'))).toBe(null);
    expect(relayFromLink(makeLink('адрес', ''))).toBe(null);
  });
});

describe('пропуск в приглашении', () => {
  const СЕЙЧАС = Date.UTC(2026, 8, 24, 12, 0, 0);

  it('упакованный пропуск распаковывается тем же', async () => {
    const пропуск = await passFor({address: '195.0.2.1', secret: 'ключ', now: СЕЙЧАС});

    expect(unpackPass(packPass(пропуск), {now: СЕЙЧАС})).toEqual(пропуск);
  });

  it('в пропуске нет ключа — только имя и подпись', async () => {
    // Весь смысл пропуска: ключ остаётся в браузере хозяина. Проверяем
    // по-честному — ищем ключ в самой упаковке.
    const пропуск = await passFor({address: '195.0.2.1', secret: 'совсем-тайный-ключ', now: СЕЙЧАС});
    const упаковка = packPass(пропуск);

    expect(JSON.stringify(unpackPass(упаковка, {now: СЕЙЧАС}))).not.toContain('совсем-тайный-ключ');
    expect(атобТекст(упаковка)).not.toContain('совсем-тайный-ключ');
  });

  it('просроченный пропуск отбрасывается', async () => {
    // Ретранслятор его всё равно не примет, а попытка стоила бы времени на
    // каждом соединении.
    const пропуск = await passFor({address: '195.0.2.1', secret: 'ключ', now: СЕЙЧАС});
    const потом = СЕЙЧАС + (TICKET_SECONDS + 1) * 1000;

    expect(unpackPass(packPass(пропуск), {now: потом})).toBe(null);
  });

  it('испорченный хвост ссылки — просто без ретранслятора', () => {
    expect(unpackPass('%%%')).toBe(null);
    expect(unpackPass('')).toBe(null);
    expect(unpackPass(undefined)).toBe(null);
    expect(unpackPass(btoa('{"a":"x"}'))).toBe(null);
  });

  it('в ссылку пока идёт прежний вид — его читают и старые версии', async () => {
    const пропуск = await passFor({address: '195.58.52.143:3478', secret: 'ключ', now: СЕЙЧАС});

    expect(packPass(пропуск).startsWith('ey')).toBe(true);
  });

  it('короткий пропуск по адресу — около сорока знаков, и читается', async () => {
    const пропуск = await passFor({address: '195.58.52.143:3478', secret: 'ключ', now: СЕЙЧАС});
    const упаковка = packPassCompact(пропуск);

    expect(упаковка.length).toBeLessThanOrEqual(44);
    expect(unpackPass(упаковка, {now: СЕЙЧАС})).toEqual(пропуск);
  });

  it('адрес без порта и с приставкой turn: — тоже коротко и без потерь', async () => {
    for (const address of ['195.58.52.143', 'turn:195.58.52.143:3478']) {
      const пропуск = await passFor({address, secret: 'ключ', now: СЕЙЧАС});
      const упаковка = packPassCompact(пропуск);
      expect(упаковка.length).toBeLessThanOrEqual(44);
      // Адрес может прийти без приставки — важно, что ретранслятор тот же.
      expect(serversFromPass(unpackPass(упаковка, {now: СЕЙЧАС}))).toEqual(serversFromPass(пропуск));
    }
  });

  it('имя вместо адреса — прежний вид, длиннее, но работает', async () => {
    const пропуск = await passFor({address: 'relay.example.org:3478', secret: 'ключ', now: СЕЙЧАС});

    expect(unpackPass(packPass(пропуск), {now: СЕЙЧАС})).toEqual(пропуск);
  });

  it('старые ссылки, с пропуском прежнего вида, по-прежнему открываются', async () => {
    const пропуск = await passFor({address: '195.0.2.1', secret: 'ключ', now: СЕЙЧАС});
    const прежний = btoa(JSON.stringify({a: пропуск.address, u: пропуск.username, c: пропуск.credential}))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    expect(unpackPass(прежний, {now: СЕЙЧАС})).toEqual(пропуск);
  });

  it('короткий просроченный — тоже отбрасывается', async () => {
    const пропуск = await passFor({address: '195.0.2.1', secret: 'ключ', now: СЕЙЧАС});

    expect(unpackPass(packPassCompact(пропуск), {now: СЕЙЧАС + (TICKET_SECONDS + 1) * 1000})).toBe(null);
  });

  it('обрезанный короткий — без ретранслятора, а не мусор', async () => {
    const пропуск = await passFor({address: '195.0.2.1', secret: 'ключ', now: СЕЙЧАС});

    expect(unpackPass(packPassCompact(пропуск).slice(0, 20), {now: СЕЙЧАС})).toBe(null);
  });

  it('без ретранслятора пропуска нет', async () => {
    expect(await passFor({address: '', secret: 'ключ'})).toBe(null);
    expect(await passFor({address: 'x', secret: ''})).toBe(null);
  });

  it('из пропуска получаются адреса для льда', async () => {
    const пропуск = await passFor({address: '195.0.2.1', secret: 'ключ', now: СЕЙЧАС});

    expect(serversFromPass(пропуск)).toEqual([
      {urls: 'turn:195.0.2.1:3478', username: пропуск.username, credential: пропуск.credential},
      {urls: 'turn:195.0.2.1:3478?transport=tcp', username: пропуск.username, credential: пропуск.credential},
      {urls: 'turn:195.0.2.1:443?transport=udp', username: пропуск.username, credential: пропуск.credential},
    ]);
    expect(serversFromPass(null)).toEqual([]);
  });
});

// base64url → текст, для проверки, что внутри упаковки.
const атобТекст = blob => {
  const padded = blob.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
};
