import {expect, it} from 'vitest';
import {selfId as nostrId} from '@trystero-p2p/nostr';
import {selfId as mqttId} from '@trystero-p2p/mqtt';

// На этом держится отсев дублей: один и тот же человек, пришедший из
// разных семейств, должен опознаваться одним и тем же идентификатором.
// Иначе он окажется в комнате дважды и получит по два потока.
it('участник опознаётся одинаково в обоих семействах', () => {
  expect(nostrId).toBe(mqttId);
  expect(nostrId).toMatch(/^[A-Za-z0-9]{20}$/);
});
