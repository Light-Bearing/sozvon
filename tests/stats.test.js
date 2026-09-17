import {describe, expect, it} from 'vitest';
import {createStatsTracker, MAX_SNAPSHOT_AGE_MS} from '../src/stats.js';

// Тот же приём, что и в tests/ladder.test.js: свои часы вместо системных,
// чтобы проверять устаревание снимков без реального ожидания.
const fakeClock = () => {
  let t = 0;
  return {now: () => t, advance: ms => (t += ms)};
};

describe('сводка о связи', () => {
  it('на пустой статистике отвечает нулями, а не падает', () => {
    expect(createStatsTracker().summarize([])).toEqual({loss: 0, queueSeconds: 0});
  });

  it('берёт долю потерь из отчёта собеседника', () => {
    expect(
      createStatsTracker().summarize([
        {peerId: 'сосед', reports: [{type: 'remote-inbound-rtp', fractionLost: 0.12}]},
      ]).loss
    ).toBeCloseTo(0.12);
  });

  it('из нескольких собеседников берёт худшего', () => {
    expect(
      createStatsTracker().summarize([
        {peerId: 'аня', reports: [{type: 'remote-inbound-rtp', fractionLost: 0.01}]},
        {peerId: 'боря', reports: [{type: 'remote-inbound-rtp', fractionLost: 0.3}]},
        {peerId: 'вера', reports: [{type: 'remote-inbound-rtp', fractionLost: 0.05}]},
      ]).loss
    ).toBeCloseTo(0.3);
  });

  it('посторонние отчёты игнорируются', () => {
    expect(
      createStatsTracker().summarize([
        {
          peerId: 'сосед',
          reports: [
            {type: 'candidate-pair', currentRoundTripTime: 9},
            {type: 'codec', mimeType: 'video/VP8'},
          ],
        },
      ])
    ).toEqual({loss: 0, queueSeconds: 0});
  });

  it('отчёты без нужных полей не портят сводку', () => {
    expect(
      createStatsTracker().summarize([
        {
          peerId: 'сосед',
          reports: [
            {type: 'remote-inbound-rtp'},
            {type: 'remote-inbound-rtp', fractionLost: 0.2},
            {type: 'outbound-rtp', id: 'x', packetsSent: 10},
          ],
        },
      ])
    ).toEqual({loss: 0.2, queueSeconds: 0});
  });

  // Находка 4: report.id устойчив только внутри одного RTCPeerConnection —
  // у разных собеседников он свободно совпадает (браузеры нумеруют
  // предсказуемо). Раньше all отчёты сваливались в one плоский servers и
  // ключевались одним report.id — снимок одного собеседника мог перепутаться
  // со снимком другого, снятым в тот же миг. Вдвоём совпасть нечему, поэтому
  // и не поймали. Теперь вызывающий обязан группировать отчёты по
  // собеседнику, и ключ — пара (собеседник, report.id).
  describe('снимки не путаются между собеседниками', () => {
    it('одинаковый report.id у разных собеседников не мешает каждому посчитаться отдельно', () => {
      const tracker = createStatsTracker();

      // Тик 1: у обоих исходящий stream получил one и тот же id.
      tracker.summarize([
        {peerId: 'аня', reports: [{type: 'outbound-rtp', id: 'v1', totalPacketSendDelay: 100, packetsSent: 500}]},
        {peerId: 'боря', reports: [{type: 'outbound-rtp', id: 'v1', totalPacketSendDelay: 30, packetsSent: 300}]},
      ]);

      // Тик 2: у Ани заметный затор (+20 пакетов, +4 с — 0.2 с/пакет),
      // у Бори связь ровная (+20 пакетов, +2 с — 0.1 с/пакет). Если бы
      // снимки не разносились по собеседнику, чужой прошлый снимок с тем же
      // id подмешался бы, и результат не совпал бы ни с одной из этих двух
      // настоящих цифр.
      const {queueSeconds} = tracker.summarize([
        {peerId: 'аня', reports: [{type: 'outbound-rtp', id: 'v1', totalPacketSendDelay: 104, packetsSent: 520}]},
        {peerId: 'боря', reports: [{type: 'outbound-rtp', id: 'v1', totalPacketSendDelay: 32, packetsSent: 320}]},
      ]);

      expect(queueSeconds).toBeCloseTo(0.2); // худшее из двух настоящих значений, не выдумка
    });

    it('источник, не встретившийся в такте, не живёт в памяти вечно и не путается с чужим', () => {
      const tracker = createStatsTracker();

      tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'v1', totalPacketSendDelay: 100, packetsSent: 500}]},
      ]);

      // Такт, в котором этого собеседника вовсе нет — например, вышел из
      // комнаты (или просто не удался getStats(), см. src/room.js).
      tracker.summarize([]);

      // Тот же id встретился заново — либо тот же собеседник вернулся, либо
      // (и это как раз находка 4) браузер выдал такой же id новому
      // собеседнику. В обоих случаях старый снимок 500/100 участвовать не
      // должен: иначе 2 новых пакета дадут многосекундную задержку из
      // ничего.
      const {queueSeconds} = tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'v1', totalPacketSendDelay: 0.02, packetsSent: 2}]},
      ]);

      expect(queueSeconds).toBe(0);
    });
  });

  // Находка 4, second часть: снимки не убирались никогда и без ограничения
  // по давности. Источник, который на время выпал из тактов и вернулся,
  // не должен быть сосчитан через весь провал.
  describe('старые снимки не копятся и не идут в сравнение', () => {
    it('снимок старше maxAgeMs не участвует в сравнении, даже если такт его не вытеснил', () => {
      const clock = fakeClock();
      const tracker = createStatsTracker({now: clock.now, maxAgeMs: 10_000});

      tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'v1', totalPacketSendDelay: 0, packetsSent: 1000}]},
      ]);

      // Например, вкладку свернули на минуту, и таймер такта придержали.
      clock.advance(60_000);

      // Если бы этот снимок всё ещё считался «прошлым тактом», 2 новых
      // пакета за минуту дали бы 60/2 = 30 с «выдумки» вместо честного нуля.
      const {queueSeconds} = tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'v1', totalPacketSendDelay: 60, packetsSent: 1002}]},
      ]);

      expect(queueSeconds).toBe(0);
    });

    it('снимок младше maxAgeMs по-прежнему участвует в сравнении', () => {
      const clock = fakeClock();
      const tracker = createStatsTracker({now: clock.now, maxAgeMs: 10_000});

      tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'v1', totalPacketSendDelay: 0, packetsSent: 1000}]},
      ]);
      clock.advance(2_000); // обычный такт, см. STATS_EVERY_MS в src/room.js

      const {queueSeconds} = tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'v1', totalPacketSendDelay: 4, packetsSent: 1002}]},
      ]);

      expect(queueSeconds).toBeCloseTo(2);
    });

    it('значение по умолчанию (MAX_SNAPSHOT_AGE_MS) тоже действует, если maxAgeMs не задан явно', () => {
      const clock = fakeClock();
      const tracker = createStatsTracker({now: clock.now});

      tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'v1', totalPacketSendDelay: 0, packetsSent: 1000}]},
      ]);
      clock.advance(MAX_SNAPSHOT_AGE_MS + 1);

      const {queueSeconds} = tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'v1', totalPacketSendDelay: 50, packetsSent: 1002}]},
      ]);

      expect(queueSeconds).toBe(0);
    });
  });

  describe('очередь отправки — по приращению между тактами, а не за всё время звонка', () => {
    it('на первом снимке источника сравнивать не с чем — очередь не завышена всей историей', () => {
      // Будто звонок уже давно идёт: отношение «всего» дало бы 600/300 = 2,
      // хотя прямо clock затора могло и не быть — first снимок не в счёт.
      const tracker = createStatsTracker();
      const {queueSeconds} = tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 600, packetsSent: 300}]},
      ]);
      expect(queueSeconds).toBe(0);
    });

    it('считает задержку по приращению между двумя снимками одного источника', () => {
      const tracker = createStatsTracker();
      tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 6, packetsSent: 3}]},
      ]);
      // +2 пакета, +4 секунды задержки на них — (10-6)/(5-3) = 2.
      const {queueSeconds} = tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 10, packetsSent: 5}]},
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
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 0, packetsSent: 3000}]},
      ]);
      const {queueSeconds} = tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 10, packetsSent: 3005}]},
      ]);
      expect(queueSeconds).toBeCloseTo(2);
    });

    it('не делит на ноль, когда между снимками не отправлено ни одного нового пакета', () => {
      const tracker = createStatsTracker();
      tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 6, packetsSent: 3}]},
      ]);
      const {queueSeconds} = tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 6, packetsSent: 3}]},
      ]);
      expect(queueSeconds).toBe(0);
    });

    it('обнуление счётчиков источника (например, после переустановки ICE) не даёт мусор', () => {
      const tracker = createStatsTracker();
      tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 500, packetsSent: 250}]},
      ]);
      // Счётчики этого источника начались заново с нуля — sent меньше
      // прежнего. Разница «в лоб» дала бы отрицательные числа и мусор.
      const {queueSeconds} = tracker.summarize([
        {peerId: 'сосед', reports: [{type: 'outbound-rtp', id: 'a1', totalPacketSendDelay: 4, packetsSent: 2}]},
      ]);
      expect(queueSeconds).toBe(0);
    });

    it('среди нескольких источников одного собеседника на такте берёт худшее приращение', () => {
      const tracker = createStatsTracker();
      tracker.summarize([
        {
          peerId: 'сосед',
          reports: [
            {type: 'outbound-rtp', id: 'video', totalPacketSendDelay: 0, packetsSent: 0},
            {type: 'outbound-rtp', id: 'audio', totalPacketSendDelay: 0, packetsSent: 0},
          ],
        },
      ]);
      const {queueSeconds} = tracker.summarize([
        {
          peerId: 'сосед',
          reports: [
            {type: 'outbound-rtp', id: 'video', totalPacketSendDelay: 10, packetsSent: 5}, // 2 с/пакет
            {type: 'outbound-rtp', id: 'audio', totalPacketSendDelay: 1, packetsSent: 10}, // 0.1 с/пакет
          ],
        },
      ]);
      expect(queueSeconds).toBeCloseTo(2);
    });
  });
});
