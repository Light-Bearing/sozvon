import {expect, it} from 'vitest';
import {selfId as torrentId} from '@trystero-p2p/torrent';
import {selfId as nostrId} from '@trystero-p2p/nostr';
import {selfId as mqttId} from '@trystero-p2p/mqtt';

it('участник опознаётся одинаково во всех трёх семействах', () => {
  expect(torrentId).toBe(nostrId);
  expect(nostrId).toBe(mqttId);
  expect(torrentId).toMatch(/^[A-Za-z0-9]{20}$/);
});
