import {describe, expect, it} from 'vitest';
import {summarizeStats} from '../src/stats.js';

describe('сводка о связи', () => {
  it('на пустой статистике отвечает нулями, а не падает', () => {
    expect(summarizeStats([])).toEqual({loss: 0, queueSeconds: 0});
  });

  it('берёт долю потерь из отчёта собеседника', () => {
    expect(summarizeStats([
      {type: 'remote-inbound-rtp', fractionLost: 0.12},
    ]).loss).toBeCloseTo(0.12);
  });

  it('из нескольких собеседников берёт худшего', () => {
    expect(summarizeStats([
      {type: 'remote-inbound-rtp', fractionLost: 0.01},
      {type: 'remote-inbound-rtp', fractionLost: 0.3},
      {type: 'remote-inbound-rtp', fractionLost: 0.05},
    ]).loss).toBeCloseTo(0.3);
  });

  it('считает задержку очереди как среднюю на пакет', () => {
    expect(summarizeStats([
      {type: 'outbound-rtp', totalPacketSendDelay: 6, packetsSent: 3},
    ]).queueSeconds).toBeCloseTo(2);
  });

  it('не делит на ноль, когда ничего не отправлено', () => {
    expect(summarizeStats([
      {type: 'outbound-rtp', totalPacketSendDelay: 0, packetsSent: 0},
    ]).queueSeconds).toBe(0);
  });

  it('посторонние отчёты игнорируются', () => {
    expect(summarizeStats([
      {type: 'candidate-pair', currentRoundTripTime: 9},
      {type: 'codec', mimeType: 'video/VP8'},
    ])).toEqual({loss: 0, queueSeconds: 0});
  });

  it('отчёты без нужных полей не портят сводку', () => {
    expect(summarizeStats([
      {type: 'remote-inbound-rtp'},
      {type: 'remote-inbound-rtp', fractionLost: 0.2},
      {type: 'outbound-rtp', packetsSent: 10},
    ])).toEqual({loss: 0.2, queueSeconds: 0});
  });
});
