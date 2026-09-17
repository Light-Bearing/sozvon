import {describe, expect, it} from 'vitest';
import {codeFromLink, gatherComplete, manualLink, pack, unpack} from '../src/signal/manual.js';

const sampleSdp = {
  type: 'offer',
  sdp: ['v=0', 'o=- 42 2 IN IP4 127.0.0.1', 's=-', 't=0 0'].join('\r\n').repeat(30),
};

describe('упаковка описания соединения', () => {
  it('ходит туда-обратно без потерь', async () => {
    expect(await unpack(await pack(sampleSdp))).toEqual(sampleSdp);
  });

  it('код состоит только из безопасных для ссылки символов', async () => {
    expect(await pack(sampleSdp)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('сжатие действительно сокращает — описания повторяются', async () => {
    const code = await pack(sampleSdp);
    expect(code.length).toBeLessThan(sampleSdp.sdp.length / 2);
  });

  it('испорченный код — внятная ошибка, а не тишина', async () => {
    await expect(unpack('этоНеКод')).rejects.toThrow();
  });

  it('пустой код — тоже ошибка', async () => {
    await expect(unpack('')).rejects.toThrow();
  });
});

describe('ссылка ручного обмена', () => {
  it('отличима от обычной ссылки-приглашения', async () => {
    const code = await pack(sampleSdp);
    const link = manualLink(code, 'https://light-bearing.github.io/sozvon/');
    expect(link).toContain('#m.');
    expect(codeFromLink(link)).toBe(code);
  });

  // Та же беда, что была у secretToLink: сборка в one файл открывается с
  // диска (file://), а в Chrome location.origin для таких адресов — буквально
  // строка "null". Склейка "null" + location.pathname давала битую ссылку.
  it('на file:// (Chrome отдаёт location.origin как строку "null") makeLink не начинается с "null"', async () => {
    const previous = globalThis.location;
    globalThis.location = {
      origin: 'null',
      pathname: '/Users/some-one/sozvon/index.html',
      href: 'file:///Users/some-one/sozvon/index.html',
    };
    try {
      const code = await pack(sampleSdp);
      const link = manualLink(code);
      expect(link).toBe(`file:///Users/some-one/sozvon/index.html#m.${code}`);
      expect(link.startsWith('null')).toBe(false);
      expect(codeFromLink(link)).toBe(code);
    } finally {
      globalThis.location = previous;
    }
  });

  it('обычная makeLink кодом не притворяется', () => {
    expect(codeFromLink('https://light-bearing.github.io/sozvon/#K7mQ2xAbCdEfGhIjKl')).toBeNull();
    expect(codeFromLink('https://light-bearing.github.io/sozvon/')).toBeNull();
  });
});

describe('ожидание сбора адресов', () => {
  it('ждёт, пока сбор не закончится', async () => {
    const listeners = [];
    const pc = {
      iceGatheringState: 'gathering',
      addEventListener: (_, fn) => listeners.push(fn),
      removeEventListener: () => {},
    };
    let done = false;
    const waiting = gatherComplete(pc).then(() => (done = true));

    expect(done).toBe(false);
    pc.iceGatheringState = 'complete';
    for (const fn of listeners) fn();
    await waiting;
    expect(done).toBe(true);
  });

  it('если сбор уже закончен, не ждёт вовсе', async () => {
    await expect(
      gatherComplete({
        iceGatheringState: 'complete',
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    ).resolves.toBeUndefined();
  });
});
