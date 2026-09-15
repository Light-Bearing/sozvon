import {describe, expect, it} from 'vitest';
import {troubleFrom} from '../src/signal/trouble.js';

describe('разбор жалоб библиотеки', () => {
  it('«обменялись описаниями, а соединиться не смогли» — это отсутствие прямого пути', () => {
    expect(
      troubleFrom(
        'could not connect to peer abc123 after exchanging SDP; configure TURN ' +
          'servers with turnConfig or rtcConfig.iceServers',
      ),
    ).toBe('no-path');
  });

  it('не расшифровалось предложение — в комнате чужой ключ', () => {
    expect(troubleFrom('incorrect room password when decrypting offer')).toBe('wrong-key');
    expect(troubleFrom('incorrect room password when decrypting answer')).toBe('wrong-key');
    expect(troubleFrom('incorrect password for overlapping room')).toBe('wrong-key');
  });

  it('рукопожатие не доведено до конца', () => {
    expect(troubleFrom('handshake timed out after 15000ms')).toBe('handshake');
    expect(troubleFrom('peer disconnected during handshake')).toBe('handshake');
  });

  it('незнакомая жалоба не выдаёт себя за знакомую', () => {
    expect(troubleFrom('failed to allocate offer peer')).toBe('unknown');
    expect(troubleFrom('')).toBe('unknown');
    expect(troubleFrom(undefined)).toBe('unknown');
  });

  it('принимает и объект Error, а не только строку', () => {
    expect(troubleFrom(new Error('handshake timed out after 15000ms'))).toBe('handshake');
  });
});
