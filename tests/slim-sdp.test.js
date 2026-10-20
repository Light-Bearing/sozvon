import {describe, expect, it} from 'vitest';
import {isSlim, slimPack, slimUnpack} from '../src/signal/slim-sdp.js';

// Предложение канала данных, как его пишет Chrome: свой адрес под именем
// .local, внешний адрес, адрес ретранслятора и бесполезные TCP-кандидаты.
const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const chromeOffer = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 61842 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 203.0.113.7',
  'a=candidate:1467250027 1 udp 2122260223 4d3f8a2e-1b2c-4d5e-8f90-0a1b2c3d4e5f.local 61842 typ host generation 0 network-cost 999',
  'a=candidate:842163049 1 udp 1686052607 203.0.113.7 61842 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=candidate:842163049 1 udp 1686052607 203.0.113.7 61842 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=candidate:3 1 udp 41885439 195.58.52.143 49170 typ relay raddr 203.0.113.7 rport 61842 generation 0',
  'a=candidate:4 1 udp 2122194687 2001:db8::1 61843 typ host generation 0',
  'a=candidate:5 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active generation 0',
  'a=ice-ufrag:Xq3v',
  'a=ice-pwd:Tz9mNpQ2rS4tU6vW8xY0aB1c',
  'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${FP}`,
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

describe('описание в двести знаков', () => {
  it('короткое: в разы короче полного', () => {
    const code = slimPack({sdp: chromeOffer});

    expect(code.length).toBeLessThan(170);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('обратно — то же самое: имя, пароль, отпечаток, кто начинает', () => {
    const {type, sdp} = slimUnpack(slimPack({sdp: chromeOffer}));

    expect(type).toBe('offer');
    expect(sdp).toContain('a=ice-ufrag:Xq3v');
    expect(sdp).toContain('a=ice-pwd:Tz9mNpQ2rS4tU6vW8xY0aB1c');
    expect(sdp).toContain(`a=fingerprint:sha-256 ${FP}`);
    expect(sdp).toContain('a=setup:actpass');
    expect(sdp).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
  });

  it('адреса доезжают все нужные, без повторов и без TCP', () => {
    const {sdp} = slimUnpack(slimPack({sdp: chromeOffer}));
    const адреса = [...sdp.matchAll(/^a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ (\w+)/gm)].map(m => `${m[3]} ${m[1]} ${m[2]}`);

    expect(адреса).toEqual([
      'host 4d3f8a2e-1b2c-4d5e-8f90-0a1b2c3d4e5f.local 61842',
      'srflx 203.0.113.7 61842',
      'relay 195.58.52.143 49170',
      'host 2001:db8:0:0:0:0:0:1 61843',
    ]);
  });

  it('ответ остаётся ответом', () => {
    const answer = chromeOffer.replace('a=setup:actpass', 'a=setup:active');

    expect(slimUnpack(slimPack({sdp: answer})).type).toBe('answer');
  });

  it('отличается от прежнего вида кода', () => {
    expect(isSlim(slimPack({sdp: chromeOffer}))).toBe(true);
    // Прежний — сжатый gzip, всегда начинается с H4sI.
    expect(isSlim('H4sIAAAAAAAAA1234')).toBe(false);
  });

  it('обрезанный или испорченный код — понятная ошибка, а не мусор в соединении', () => {
    const code = slimPack({sdp: chromeOffer});

    expect(() => slimUnpack(code.slice(0, 40))).toThrow('Код испорчен');
    expect(() => slimUnpack(`${code}AAAA`)).toThrow('Код испорчен');
    expect(() => slimUnpack('<script>')).toThrow('Код испорчен');
    expect(() => slimUnpack('')).toThrow('Код испорчен');
  });
});
