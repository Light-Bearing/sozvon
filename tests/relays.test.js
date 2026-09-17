import {describe, expect, it} from 'vitest';
import {defaultRelayUrls as nostrDefaults} from '@trystero-p2p/nostr';
import {REDUNDANCY, relayUrlsFor, VERIFIED} from '../src/signal/relays.js';

describe('адреса каналов', () => {
  it('проверенные живыми идут первыми', () => {
    for (const family of ['nostr', 'mqtt']) {
      expect(relayUrlsFor(family).slice(0, VERIFIED[family].length))
        .toEqual(VERIFIED[family]);
    }
  });

  it('список обрезан до нужной избыточности', () => {
    for (const family of ['nostr', 'mqtt']) {
      expect(relayUrlsFor(family).length).toBeLessThanOrEqual(REDUNDANCY);
      expect(relayUrlsFor(family).length).toBeGreaterThan(0);
    }
  });

  it('повторов в списке нет', () => {
    for (const family of ['nostr', 'mqtt']) {
      const urls = relayUrlsFor(family);
      expect(new Set(urls).size).toBe(urls.length);
    }
  });

  it('к проверенным дописываются адреса из библиотеки', () => {
    // relay.snort.social пробником найден живым, но в servers библиотеки
    // nostr не входит — ровно поэтому мы дописываем, а не заменяем.
    // (У torrent и mqtt all проверенные адреса и так уже есть в списке
    // библиотеки — этот случай показателен только на nostr.)
    expect(nostrDefaults).not.toContain(VERIFIED.nostr[1]);
    expect(relayUrlsFor('nostr')).toContain(VERIFIED.nostr[1]);
    expect(relayUrlsFor('nostr').length).toBeGreaterThan(VERIFIED.nostr.length);
  });

  it('неизвестное семейство — это ошибка, а не пустой список', () => {
    expect(() => relayUrlsFor('карман')).toThrow();
  });
});
