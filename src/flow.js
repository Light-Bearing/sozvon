// Сколько сейчас на самом деле идёт звука и картинки — в каждую сторону.
//
// Нужно затем, что «дорожка есть» и «звук идёт» — разные вещи, и человек
// со стороны их не различит. Считаем по приращению байтов между тактами:
// мгновенное значение статистики накопительное и само по себе ни о чём не
// говорит.

const KINDS = ['audio', 'video'];

export const createFlowTracker = () => {
  let previous = null;

  return {
    // reports — то же, что собирает такт лестницы: по одному набору на
    // собеседника. Складываем по всем: человеку важно «идёт ли вообще», а
    // не с кем именно.
    update: (peerReports, now = Date.now()) => {
      const totals = {'принято-audio': 0, 'принято-video': 0, 'отдано-audio': 0, 'отдано-video': 0};
      for (const {reports} of peerReports) {
        for (const report of reports) {
          if (report.type === 'inbound-rtp' && KINDS.includes(report.kind)) {
            totals['принято-' + report.kind] += report.bytesReceived || 0;
          }
          if (report.type === 'outbound-rtp' && KINDS.includes(report.kind)) {
            totals['отдано-' + report.kind] += report.bytesSent || 0;
          }
        }
      }

      const before = previous;
      previous = {totals, now};
      if (!before || now <= before.now) return null;

      const seconds = (now - before.now) / 1000;
      const rate = key =>
        Math.max(0, Math.round(((totals[key] - before.totals[key]) * 8) / 1000 / seconds));

      return {
        inAudio: rate('принято-audio'),
        inVideo: rate('принято-video'),
        outAudio: rate('отдано-audio'),
        outVideo: rate('отдано-video'),
      };
    },
  };
};

// Человеку — словами и числами, без сокращений, понятных только своим.
export const describeFlow = flow => {
  if (!flow) return '';
  const line = (label, audio, video) =>
    `${label}: звук ${audio} кбит/с, видео ${video} кбит/с`;
  return [
    line('Вы отдаёте', flow.outAudio, flow.outVideo),
    line('Вам идёт', flow.inAudio, flow.inVideo),
  ].join('\n');
};
