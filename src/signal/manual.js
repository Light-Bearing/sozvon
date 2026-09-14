// Запасной путь: описание соединения едет в самой ссылке, ответ —
// кодом обратно. Шифровать нечего: у кого ссылка, у того и всё остальное.

const MANUAL_PREFIX = 'm.';

const through = async (bytes, transform) =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(transform),
    ).arrayBuffer(),
  );

const toBase64Url = bytes =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromBase64Url = text => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')), c =>
    c.charCodeAt(0),
  );
};

export const pack = async ({type, sdp}) => {
  const json = new TextEncoder().encode(JSON.stringify({t: type, s: sdp}));
  return toBase64Url(await through(json, new CompressionStream('gzip')));
};

export const unpack = async code => {
  if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new Error('Код испорчен или неполон');
  let json;
  try {
    json = await through(fromBase64Url(code), new DecompressionStream('gzip'));
  } catch {
    throw new Error('Код испорчен или неполон');
  }
  const {t, s} = JSON.parse(new TextDecoder().decode(json));
  return {type: t, sdp: s};
};

export const manualLink = (code, base) =>
  `${base ?? location.origin + location.pathname}#${MANUAL_PREFIX}${code}`;

export const codeFromLink = href => {
  const hash = new URL(href).hash.slice(1);
  return hash.startsWith(MANUAL_PREFIX) ? hash.slice(MANUAL_PREFIX.length) : null;
};

// При ручном обмене отправлять описание можно только после того, как
// собраны все адреса: досылать их потом будет некуда.
export const gatherComplete = pc =>
  new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', check);
  });
