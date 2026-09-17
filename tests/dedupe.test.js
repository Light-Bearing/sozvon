import {beforeEach, describe, expect, it} from 'vitest';
import {createPeerRegistry} from '../src/signal/dedupe.js';

describe('отсев дублей', () => {
  let registry;
  beforeEach(() => (registry = createPeerRegistry()));

  it('первый нашедший становится владельцем', () => {
    expect(registry.claim('петя', 'nostr')).toBe(true);
    expect(registry.ownerOf('петя')).toBe('nostr');
  });

  it('второй канал с тем же участником получает отказ', () => {
    registry.claim('петя', 'nostr');
    expect(registry.claim('петя', 'nostr')).toBe(false);
    expect(registry.ownerOf('петя')).toBe('nostr');
  });

  it('повторный вызов от самого владельца тоже отказ — второй раз не считается', () => {
    registry.claim('петя', 'nostr');
    expect(registry.claim('петя', 'nostr')).toBe(false);
  });

  it('уход не-владельца ничего не меняет', () => {
    registry.claim('петя', 'nostr');
    expect(registry.release('петя', 'mqtt')).toBe(false);
    expect(registry.ownerOf('петя')).toBe('nostr');
  });

  it('уход владельца освобождает участника', () => {
    registry.claim('петя', 'nostr');
    expect(registry.release('петя', 'nostr')).toBe(true);
    expect(registry.ownerOf('петя')).toBeUndefined();
  });

  it('после ухода владельца другой канал может забрать участника', () => {
    registry.claim('петя', 'nostr');
    registry.release('петя', 'nostr');
    expect(registry.claim('петя', 'nostr')).toBe(true);
    expect(registry.ownerOf('петя')).toBe('nostr');
  });

  it('разные участники живут независимо', () => {
    registry.claim('петя', 'nostr');
    registry.claim('маша', 'nostr');
    expect(registry.peers().sort()).toEqual(['маша', 'петя']);
  });

  it('уход неизвестного участника безвреден', () => {
    expect(registry.release('никто', 'nostr')).toBe(false);
  });
});
