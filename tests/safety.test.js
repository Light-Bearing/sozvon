import {describe, expect, it} from 'vitest';
import {codeFor, fingerprintOf, safetyCode} from '../src/safety.js';

const FP_A = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const FP_B = '11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF';
const FP_M = 'DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF';
const sdp = fp => `v=0\r\na=fingerprint:sha-256 ${fp}\r\n`;

describe('код безопасности', () => {
  it('у обоих собеседников — одинаковый', async () => {
    expect(await safetyCode(FP_A, FP_B)).toBe(await safetyCode(FP_B, FP_A));
  });

  it('16 цифр в четырёх группах', async () => {
    expect(await safetyCode(FP_A, FP_B)).toMatch(/^\d{4} \d{4} \d{4} \d{4}$/);
  });

  it('вклинился третий — коды у двоих расходятся', async () => {
    // У А соединение на самом деле с М, у Б — тоже с М.
    const уА = await safetyCode(FP_A, FP_M);
    const уБ = await safetyCode(FP_B, FP_M);

    expect(уА).not.toBe(уБ);
  });

  it('из соединения — по отпечаткам в его описаниях', async () => {
    const pc = {localDescription: {sdp: sdp(FP_A)}, remoteDescription: {sdp: sdp(FP_B)}};

    expect(await codeFor(pc)).toBe(await safetyCode(FP_A, FP_B));
  });

  it('рукопожатие не закончено — кода ещё нет', async () => {
    expect(await codeFor({localDescription: {sdp: sdp(FP_A)}, remoteDescription: null})).toBe(null);
    expect(fingerprintOf('v=0\r\n')).toBe(null);
  });
});
