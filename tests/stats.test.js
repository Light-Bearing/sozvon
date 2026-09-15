import {describe, expect, it} from 'vitest';
import {createStatsTracker} from '../src/stats.js';

describe('сводка о связи', () => {
  it('на пустой статистике отвечает нулями, а не падает', () => {
    expect(createStatsTracker().summarize([])).toEqual({loss: 0, queueSeconds: 0});
  });

  it('берёт долю потерь из отчёта собеседника', () => {
    expect(createStatsTracker().summarize([
      {type: 'remote-inbound-rtp', fractionLost: 0.12},
    ]).loss).toBeCloseTo(0.12);
  });

  it('из нескольких собеседников берёт худшего', () => {
    expect(createStatsTracker().summarize([
      {type: 'remote-inbound-rtp', fractionLost: 0.01},
      {type: 'remote-inbound-rtp', fractionLost: 0.3},
      {type: 'remote-inbound-rtp', fractionLost: 0.05},
    ]).loss).toBeCloseTo(0.3);
  });

  it('посторонние отчёты игнорируются', () => {
    expect(createStatsTracker().summarize([
      {type: 'candidate-pair', currentRoundTripTime: 9},
      {type: 'codec', mimeType: 'video/VP8'},
    ])).toEqual({loss: 0, queueSeconds: 0});
  });

  it('отчёты без нужных полей не портят сводку', () => {
    expect(createStatsTracker().summarize([
      {type: 'remote-inbound-rtp'},
      {type: 'remote-inbound-rtp', fractionLost: 0.2},
      {type: 'outbound-rtp', id: 'x', packetsSent: 10},
    ])).toEqual({loss: 0.2, queueSeconds: 0});
  });

  describe('очередь отправки — по приращению между тактами, а не за всё время звонка', () => {
    it('на первом снимке источника сравнивать не с чем — очередь не завышена всей историей', () => {
      // Будто звонок уже давно идёт: отношение «всего» дало бы 600/300 = 2,
      // хотя прямо сейчас затора могло и не быть — первый снимок не в счёт.
      const tracker = createStatsTracker();
      const {queueSeconds} = tracker.summarize([
        {type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 600, packetsSent: 300},
      ]);
      expect(queueSeconds).toBe(0);
    });

    it('считает задержку по приращению между двумя снимками одного источника', () => {
      const tracker = createStatsTracker();
      tracker.summarize([
        {type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 6, packetsSent: 3},
      ]);
      // +2 пакета, +4 секунды задержки на них — (10-6)/(5-3) = 2.
      const {queueSeconds} = tracker.summarize([
        {type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 10, packetsSent: 5},
      ]);
      expect(queueSeconds).toBeCloseTo(2);
    });

    it('после долгого спокойного разговора короткий затор всё равно виден, не размыт историей', () => {
      // Ровно сценарий из ревью: через минуту разговора packetsSent так
      // велик, что старое отношение totalPacketSendDelay/packetsSent
      // (10/3005 ≈ 0.0033) почти не двигалось бы затором — и проверка
      // самочувствия не срабатывала бы почти никогда.
      const tracker = createStatsTracker();
      tracker.summarize([
        {type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 0, packetsSent: 3000},
      ]);
      const {queueSeconds} = tracker.summarize([
        {type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 10, packetsSent: 3005},
      ]);
      expect(queueSeconds).toBeCloseTo(2);
    });

    it('не делит на ноль, когда между снимками не отправлено ни одного нового пакета', () => {
      const tracker = createStatsTracker();
      tracker.summarize([
        {type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 6, packetsSent: 3},
      ]);
      const {queueSeconds} = tracker.summarize([
        {type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 6, packetsSent: 3},
      ]);
      expect(queueSeconds).toBe(0);
    });

    it('обнуление счётчиков источника (например, после переустановки ICE) не даёт мусор', () => {
      const tracker = createStatsTracker();
      tracker.summarize([
        {type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 500, packetsSent: 250},
      ]);
      // Счётчики этого источника начались заново с нуля — sent меньше
      // прежнего. Разница «в лоб» дала бы отрицательные числа и мусор.
      const {queueSeconds} = tracker.summarize([
        {type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 4, packetsSent: 2},
      ]);
      expect(queueSeconds).toBe(0);
    });

    it('среди нескольких источников на такте берёт худшее приращение', () => {
      const tracker = createStatsTracker();
      tracker.summarize([
        {type: 'outbound-rtp', id: 'video', totalPacketSendDelay: 0, packetsSent: 0},
        {type: 'outbound-rtp', id: 'audio', totalPacketSendDelay: 0, packetsSent: 0},
      ]);
      const {queueSeconds} = tracker.summarize([
        {type: 'outbound-rtp', id: 'video', totalPacketSendDelay: 10, packetsSent: 5}, // 2 с/пакет
        {type: 'outbound-rtp', id: 'audio', totalPacketSendDelay: 1, packetsSent: 10}, // 0.1 с/пакет
      ]);
      expect(queueSeconds).toBeCloseTo(2);
    });
  });
});
