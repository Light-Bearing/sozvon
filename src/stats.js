// Из вороха отчётов WebRTC добываем два числа, на которые смотрит лестница.
// Берём худшее по собеседникам: страдает один — плохо всему звонку.

export const summarizeStats = reports => {
  let loss = 0;
  let queueSeconds = 0;

  for (const report of reports) {
    if (report.type === 'remote-inbound-rtp' && typeof report.fractionLost === 'number') {
      loss = Math.max(loss, report.fractionLost);
    }
    if (report.type === 'outbound-rtp' && report.packetsSent > 0) {
      queueSeconds = Math.max(
        queueSeconds,
        (report.totalPacketSendDelay ?? 0) / report.packetsSent,
      );
    }
  }

  return {loss, queueSeconds};
};
