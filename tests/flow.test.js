import {describe, expect, it} from 'vitest';
import {createFlowTracker, describeFlow} from '../src/flow.js';

const набор = (принятоЗвук, принятоВидео, отданоЗвук, отданоВидео) => [
  {
    peerId: 'петя',
    reports: [
      {type: 'inbound-rtp', kind: 'audio', bytesReceived: принятоЗвук},
      {type: 'inbound-rtp', kind: 'video', bytesReceived: принятоВидео},
      {type: 'outbound-rtp', kind: 'audio', bytesSent: отданоЗвук},
      {type: 'outbound-rtp', kind: 'video', bytesSent: отданоВидео},
    ],
  },
];

describe('живой расход', () => {
  it('первый такт сравнивать не с чем', () => {
    expect(createFlowTracker().update(набор(0, 0, 0, 0), 1000)).toBe(null);
  });

  it('считает приращение, а не накопленное', () => {
    const t = createFlowTracker();
    t.update(набор(1000, 10000, 2000, 20000), 1000);

    // За секунду прибавилось 5000 байт звука = 40 кбит/с.
    const итог = t.update(набор(6000, 60000, 7000, 70000), 2000);

    expect(итог).toEqual({inAudio: 40, inVideo: 400, outAudio: 40, outVideo: 400});
  });

  it('складывает по всем собеседникам', () => {
    const t = createFlowTracker();
    const двое = at => [
      {peerId: 'а', reports: [{type: 'inbound-rtp', kind: 'audio', bytesReceived: at}]},
      {peerId: 'б', reports: [{type: 'inbound-rtp', kind: 'audio', bytesReceived: at}]},
    ];
    t.update(двое(0), 1000);

    expect(t.update(двое(1000), 2000).inAudio).toBe(16);
  });

  it('обнулившийся счётчик не даёт отрицательной скорости', () => {
    const t = createFlowTracker();
    t.update(набор(10000, 0, 0, 0), 1000);

    expect(t.update(набор(0, 0, 0, 0), 2000).inAudio).toBe(0);
  });

  it('словами — без сокращений', () => {
    const текст = describeFlow({inAudio: 40, inVideo: 800, outAudio: 38, outVideo: 700});

    expect(текст).toContain('Вы отдаёте: звук 38 кбит/с, видео 700 кбит/с');
    expect(текст).toContain('Вам идёт: звук 40 кбит/с, видео 800 кбит/с');
  });

  it('до первого замера говорить нечего', () => {
    expect(describeFlow(null)).toBe('');
  });
});
