// Сколько сейчас на самом деле идёт звука и картинки — в каждую сторону.
//
// Нужно затем, что «дорожка есть» и «звук идёт» — разные вещи, и человек
// со стороны их не различит. Считаем по приращению байтов между тактами:
// мгновенное значение статистики накопительное и само по себе ни о чём не
// говорит.

const KINDS = ['audio', 'video'];

export const createFlowTracker = () => {
  let было = null;

  return {
    // reports — то же, что собирает такт лестницы: по одному набору на
    // собеседника. Складываем по всем: человеку важно «идёт ли вообще», а
    // не с кем именно.
    update: (peerReports, now = Date.now()) => {
      const сумма = {'принято-audio': 0, 'принято-video': 0, 'отдано-audio': 0, 'отдано-video': 0};
      for (const {reports} of peerReports) {
        for (const report of reports) {
          if (report.type === 'inbound-rtp' && KINDS.includes(report.kind)) {
            сумма['принято-' + report.kind] += report.bytesReceived || 0;
          }
          if (report.type === 'outbound-rtp' && KINDS.includes(report.kind)) {
            сумма['отдано-' + report.kind] += report.bytesSent || 0;
          }
        }
      }

      const прошлое = было;
      было = {сумма, now};
      if (!прошлое || now <= прошлое.now) return null;

      const секунд = (now - прошлое.now) / 1000;
      const скорость = ключ =>
        Math.max(0, Math.round(((сумма[ключ] - прошлое.сумма[ключ]) * 8) / 1000 / секунд));

      return {
        inAudio: скорость('принято-audio'),
        inVideo: скорость('принято-video'),
        outAudio: скорость('отдано-audio'),
        outVideo: скорость('отдано-video'),
      };
    },
  };
};

// Человеку — словами и числами, без сокращений, понятных только своим.
export const describeFlow = flow => {
  if (!flow) return '';
  const строка = (метка, звук, видео) =>
    `${метка}: звук ${звук} кбит/с, видео ${видео} кбит/с`;
  return [
    строка('Вы отдаёте', flow.outAudio, flow.outVideo),
    строка('Вам идёт', flow.inAudio, flow.inVideo),
  ].join('\n');
};
