import {describe, expect, it} from 'vitest';
import {boostOpus, withBetterAudio} from '../src/opus.js';

const sdp = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 VP8/90000',
  '',
].join('\r\n');

describe('звук почище', () => {
  it('Opus получает потолок 64 кбит/с, прежние настройки остаются', () => {
    expect(boostOpus(sdp)).toContain('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=64000');
  });

  it('прочие кодеки и картинка не тронуты', () => {
    const out = boostOpus(sdp);
    expect(out).toContain('a=fmtp:63 111/111\r\n');
    expect(out).toContain('a=rtpmap:96 VP8/90000');
  });

  it('уже стоящий потолок заменяется, а не дублируется', () => {
    const out = boostOpus(sdp.replace('useinbandfec=1', 'useinbandfec=1;maxaveragebitrate=20000'));
    expect(out.match(/maxaveragebitrate/g)).toHaveLength(1);
    expect(out).toContain('maxaveragebitrate=64000');
  });

  it('нет строки настроек у Opus — дописываем её', () => {
    const out = boostOpus(sdp.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', ''));
    expect(out).toContain('a=rtpmap:111 opus/48000/2\r\na=fmtp:111 maxaveragebitrate=64000\r\n');
  });

  it('без звука в описании — ничего не меняется', () => {
    const data = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
    expect(boostOpus(data)).toBe(data);
    expect(withBetterAudio({type: 'answer', sdp: data})).toEqual({type: 'answer', sdp: data});
    expect(withBetterAudio(null)).toBe(null);
  });
});
