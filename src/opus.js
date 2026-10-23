// Звук почище: Opus на 64 кбит/с вместо обычных 32.
//
// Браузеры кодируют речь в Opus и по умолчанию держат его на 32 кбит/с —
// разборчиво, но плоско, как по телефону. Сколько слать, Opus решает по
// описанию собеседника: там тот пишет, сколько готов принять
// (maxaveragebitrate). Здесь мы дописываем это число в описание собеседника
// перед тем, как отдать его своему соединению, — и свой кодер шлёт до 64.
//
// Трогаем только то, что слышим сами от себя наружу, и только у себя: что
// именно отдаётся собеседнику, не меняется, поэтому старые версии у
// собеседников ничего не замечают — они просто получают звук получше.
//
// 64 кбит/с — потолок, на котором речь уже не отличить от живой; сверху
// разница слышна разве что в музыке, а разговор впятером за это платил бы
// заметной долей канала.

export const OPUS_BITRATE = 64_000;

export const boostOpus = (sdp, bitrate = OPUS_BITRATE) => {
  if (typeof sdp !== 'string') return sdp;
  const types = [...sdp.matchAll(/^a=rtpmap:(\d+) opus\/48000/gim)].map(m => m[1]);
  let out = sdp;
  for (const pt of types) {
    const line = new RegExp(`^(a=fmtp:${pt} )(.*)$`, 'm');
    if (line.test(out)) {
      out = out.replace(line, (_, head, params) => {
        const kept = params.split(';').map(p => p.trim()).filter(p => p && !/^maxaveragebitrate=/i.test(p));
        return `${head}${[...kept, `maxaveragebitrate=${bitrate}`].join(';')}`;
      });
    } else {
      out = out.replace(new RegExp(`^(a=rtpmap:${pt} opus/48000[^\\r\\n]*)(\\r?\\n)`, 'mi'), `$1$2a=fmtp:${pt} maxaveragebitrate=${bitrate}$2`);
    }
  }
  return out;
};

// Избыточный звук (RED): в каждом пакете едет ещё и предыдущий кусок, и
// потерянный пакет восстанавливается из следующего. На плохом мобильном
// интернете речь перестаёт рваться; платим примерно вдвое большим потоком
// звука — это мелочь рядом с картинкой.
//
// Кодер шлёт первым из кодеков, перечисленных в описании собеседника, —
// там RED обычно стоит после Opus. Ставим его первым у себя, только если
// собеседник сам его предложил: значит, умеет и разобрать. Нет RED в
// описании (Firefox его для звука не предлагает) — ничего не меняется.
export const preferRed = sdp => {
  if (typeof sdp !== 'string') return sdp;
  const opus = [...sdp.matchAll(/^a=rtpmap:(\d+) opus\/48000/gim)].map(m => m[1]);
  const red = [...sdp.matchAll(/^a=rtpmap:(\d+) red\/48000/gim)]
    .map(m => m[1])
    .filter(pt => opus.some(o => new RegExp(`^a=fmtp:${pt} ${o}/${o}`, 'm').test(sdp)));
  if (!red.length) return sdp;
  return sdp.replace(/^(m=audio \S+ \S+)((?: \d+)+)/gm, (line, head, list) => {
    const types = list.trim().split(' ');
    const first = types.filter(pt => red.includes(pt));
    if (!first.length) return line;
    return `${head} ${[...first, ...types.filter(pt => !red.includes(pt))].join(' ')}`;
  });
};

// Описание собеседника — с поднятым потолком звука. Объект описания у
// браузера только для чтения, поэтому отдаём новый.
export const withBetterAudio = description =>
  description?.sdp ? {type: description.type, sdp: preferRed(boostOpus(description.sdp))} : description;
