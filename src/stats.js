// Из вороха отчётов WebRTC добываем два числа, на которые смотрит лестница.
// Берём худшее по собеседникам: страдает один — плохо всему звонку.

// totalPacketSendDelay и packetsSent в outbound-rtp — счётчики нарастающим
// итогом с начала соединения, а не мгновенный снимок очереди. Их прямое
// отношение — это средняя задержка за всё время звонка, а не глубина
// затора прямо сейчас: через минуту разговора packetsSent настолько велик,
// что пятисекундный затор почти не сдвигает такое отношение, и проверка
// самочувствия перестаёт срабатывать. Поэтому здесь не чистая функция, а
// трекер с памятью: на каждом вызове берём разницу с прошлым снимком того
// же источника — вот это и есть задержка «прямо сейчас».
export const createStatsTracker = () => {
  // Прошлый снимок (delay, sent) по каждому источнику. report.id устойчив
  // для одного и того же потока на всё время жизни соединения — это и есть
  // «источник» из задачи.
  const previous = new Map();

  const summarize = reports => {
    let loss = 0;
    let queueSeconds = 0;

    for (const report of reports) {
      if (report.type === 'remote-inbound-rtp' && typeof report.fractionLost === 'number') {
        loss = Math.max(loss, report.fractionLost);
      }

      if (report.type === 'outbound-rtp' && typeof report.packetsSent === 'number') {
        const delay = report.totalPacketSendDelay ?? 0;
        const sent = report.packetsSent;
        const prior = previous.get(report.id);
        previous.set(report.id, {delay, sent});

        // Первый снимок этого источника — сравнивать не с чем: если отдать
        // здесь всю накопленную с начала звонка историю, это и есть та же
        // самая ошибка, которую чиним. Счётчики могут и обнулиться (например,
        // после переустановки ICE) — тогда sent окажется меньше прежнего,
        // и разница вместо задержки станет отрицательным мусором. В обоих
        // случаях просто запоминаем новую точку отсчёта и ничего не считаем
        // в этот раз.
        if (prior && sent >= prior.sent) {
          const deltaPackets = sent - prior.sent;
          const deltaDelay = delay - prior.delay;
          if (deltaPackets > 0) {
            queueSeconds = Math.max(queueSeconds, deltaDelay / deltaPackets);
          }
        }
      }
    }

    return {loss, queueSeconds};
  };

  return {summarize};
};
