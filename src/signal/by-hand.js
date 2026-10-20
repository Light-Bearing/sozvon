// Разговор без публичных каналов: рукопожатие везёт сам человек.
//
// Публичные каналы — единственное, что нужно людям, чтобы найти друг
// друга. Бывает, что из какой-то сети не открывается ни один (их режет
// провайдер или офисный фильтр), и тогда звонок стоит на «жду, когда
// зайдут» вечно. Здесь их заменяет любой мессенджер: хозяин отправляет
// ссылку с описанием своего соединения, гость отвечает кодом, хозяин
// вставляет код — и дальше всё идёт по самому соединению, как обычно.
//
// Снаружи это такое же подключение, как joinPublicChannels(): у комнаты
// (src/room.js) тот же интерфейс — дорожки, каналы сообщений, уход, — и она
// не знает, кто привёз рукопожатие. Собеседник ровно один: код отвечает
// одному человеку.
//
// После первого обмена всё дальнейшее — включил камеру, показал экран,
// перезапуск связи — договаривается по каналу данных внутри самого
// соединения. Почтальон нужен только один раз.

import {gatherComplete, manualLink, pack, unpack} from './manual.js';

export const PEER = 'собеседник';

// Двух серверов хватает: адрес «как нас видно снаружи» у них одинаковый, а
// второй — на случай, если первый недоступен.
const STUN = [{urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']}];

// Сколько ждать сбора адресов. Отправлять описание можно только целиком —
// досылать адреса потом некуда, — но и ждать вечно нельзя: недоступный
// ретранслятор отвечает отказом через десяток секунд. Что собралось за это
// время, того обычно хватает.
const GATHER_MS = 5000;

// Код достаём из того, что вставил человек: он мог скопировать сам код,
// а мог — всё сообщение вместе с приветствием или целую ссылку.
export const codeFrom = text => {
  const tokens = String(text ?? '').match(/[A-Za-z0-9_-]{40,}/g);
  return tokens ? tokens.at(-1) : null;
};

// Кодеки — только самые ходовые. Каждый лишний — строчки в описании, а
// описание едет в ссылке, и длинную ссылку мессенджер может и обрезать.
// VP8 и H.264 базового профиля понимают все браузеры, Opus — тоже.
const KEEP = codec =>
  /^audio\/opus$/i.test(codec.mimeType) ||
  /^video\/(VP8|rtx)$/i.test(codec.mimeType) ||
  (/^video\/H264$/i.test(codec.mimeType) &&
    /profile-level-id=42e01f/i.test(codec.sdpFmtpLine ?? '') &&
    /packetization-mode=1/.test(codec.sdpFmtpLine ?? ''));

const shortList = (transceiver, kind) => {
  try {
    const codecs = globalThis.RTCRtpReceiver?.getCapabilities?.(kind)?.codecs ?? [];
    const kept = codecs.filter(KEEP);
    if (kept.some(c => !/rtx/i.test(c.mimeType))) transceiver.setCodecPreferences?.(kept);
  } catch {
    // Не дали выбрать — значит, пойдёт полный список; длиннее, но работает.
  }
};

export const connectByHand = ({
  role,
  offer = null,
  servers = [],
  base,
  pass = null,
  Rtc = globalThis.RTCPeerConnection,
  gatherMs = GATHER_MS,
}) => async ({handlers = {}, onQuiet = () => {}} = {}) => {
  // Всё по одной паре адресов: адреса в описании перечисляются тогда один
  // раз, а не у каждой дорожки, и ссылка выходит заметно короче.
  const pc = new Rtc({iceServers: [...STUN, ...servers], bundlePolicy: 'max-bundle'});
  // Канал заранее условленный с обеих сторон, без объявления: так он
  // существует с первой секунды и у гостя, и у хозяина.
  const channel = pc.createDataChannel('созвон', {negotiated: true, id: 0});

  let invite = null;
  let joined = false;
  let left = false;
  const listeners = new Map();
  const senders = new Map();
  // Чем какая дорожка служит — камера или экран. Пометка едет по каналу
  // данных раньше самой дорожки, а сопоставляется по номеру потока: он у
  // обеих сторон один и тот же.
  const myRoles = new Map();
  const theirRoles = new Map();

  const send = (a, d) => {
    if (channel.readyState !== 'open') return false;
    channel.send(JSON.stringify({a, d}));
    return true;
  };

  // Предлагает всегда хозяин; гость, когда ему нужно что-то поменять, лишь
  // просит хозяина договориться заново. Так предложения никогда не
  // разминутся. Обычный способ — встречные предложения и уступчивая сторона
  // — здесь подвёл: включили камеру оба в одну миллисекунду, гость уступил,
  // и его камера, добавленная до уступки, так и не пошла — ноль кадров при
  // «договорённой» передаче.
  let making = false;
  let postponed = false;
  let asked = false;

  const negotiate = async () => {
    if (!joined) {
      postponed = true;
      return;
    }
    if (role === 'guest') {
      send('@ask', true);
      return;
    }
    if (making || pc.signalingState !== 'stable') {
      asked = true;
      return;
    }
    try {
      making = true;
      await pc.setLocalDescription();
      send('@sdp', pc.localDescription);
    } catch {
      // Соединение закрыли посреди переговоров — договариваться больше не с кем.
    } finally {
      making = false;
    }
  };
  pc.onnegotiationneeded = () => void negotiate();
  pc.onsignalingstatechange = () => {
    if (pc.signalingState !== 'stable' || !asked) return;
    asked = false;
    void negotiate();
  };

  const hear = async ({a, d}) => {
    if (a === '@ask') {
      if (role === 'host') void negotiate();
      return;
    }
    if (a === '@sdp') {
      try {
        await pc.setRemoteDescription(d);
      } catch {
        return;
      }
      if (d.type === 'offer') {
        await pc.setLocalDescription();
        send('@sdp', pc.localDescription);
      }
      return;
    }
    if (a === '@ice') {
      try {
        await pc.addIceCandidate(d);
      } catch {
        // Адрес к отвергнутому предложению — так и должно быть.
      }
      return;
    }
    if (a === '@role') {
      if (typeof d?.stream === 'string') theirRoles.set(d.stream, d.role === 'screen' ? 'screen' : 'camera');
      return;
    }
    listeners.get(a)?.(d, {peerId: PEER});
  };

  channel.onmessage = event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    // Пишет нам собеседник, а значит, прийти может что угодно: испорченное
    // сообщение отбрасываем молча, разговор из-за него не страдает.
    if (message && typeof message.a === 'string') void hear(message).catch(() => {});
  };

  pc.onicecandidate = event => {
    if (joined && event.candidate) send('@ice', event.candidate);
  };

  const leaveOnce = () => {
    if (left || !joined) return;
    left = true;
    handlers.onPeerLeave?.(PEER);
  };

  channel.onopen = () => {
    joined = true;
    onQuiet(false);
    for (const [stream, r] of myRoles) send('@role', {stream, role: r});
    handlers.onPeerJoin?.(PEER);
    if (postponed) {
      postponed = false;
      void negotiate();
    }
  };
  channel.onclose = leaveOnce;
  pc.onconnectionstatechange = () => {
    // «Нет связи» на минуту ещё не уход: комната перезапускает лёд сама
    // (src/revive.js). Уход — когда соединение сдалось или закрыто.
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') leaveOnce();
  };

  pc.ontrack = event => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    const r = theirRoles.get(stream.id) ?? 'camera';
    handlers.onPeerStream?.(stream, PEER, r);
    // Дорожку сняли — сказать комнате, чтобы плитка потемнела, а не застыла
    // на последнем кадре.
    stream.onremovetrack = () => handlers.onPeerStream?.(stream, PEER, r);
  };

  const gathered = () =>
    Promise.race([gatherComplete(pc), new Promise(r => setTimeout(r, gatherMs))]);

  // Первое рукопожатие — в фоне: подключение возвращаем сразу, а код
  // появится через пару секунд, когда соберутся адреса.
  const ready = (async () => {
    if (role === 'host') {
      // Места под дорожки — заранее: звук, камера и экран. Дорожку гостя
      // можно передать только там, где хозяин предложил для неё место, а
      // предложения теперь делает только он. Пока места пустые, они только
      // принимают; своя дорожка хозяина займёт своё место сама.
      for (const kind of ['audio', 'video', 'video']) {
        const transceiver = pc.addTransceiver(kind, {direction: 'recvonly'});
        shortList(transceiver, kind);
      }
      await pc.setLocalDescription();
      await gathered();
      invite = manualLink(await pack(pc.localDescription), base) + (pass ? `.${pass}` : '');
    } else {
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription();
      await gathered();
      invite = await pack(pc.localDescription);
    }
    handlers.onChanged?.();
  })();
  ready.catch(() => {});

  const addTrack = (track, stream, metadata) => {
    const r = metadata?.role ?? 'camera';
    myRoles.set(stream.id, r);
    send('@role', {stream: stream.id, role: r});
    if (senders.has(track)) return;
    senders.set(track, pc.addTrack(track, stream));
  };

  return {
    manual: role,
    invite: () => invite,
    ready,

    // Ответ гостя. Вставить могли что угодно — достаём сам код и проверяем,
    // что это и правда ответ, а не, скажем, своя же ссылка.
    accept: async text => {
      const code = codeFrom(text);
      if (!code) throw new Error('Здесь нет кода — вставьте ответ целиком');
      const answer = await unpack(code);
      if (answer.type !== 'answer') throw new Error('Это не ответ, а приглашение — нужен код от собеседника');
      await ready;
      await pc.setRemoteDescription(answer);
    },

    addStream: stream => {
      for (const track of stream.getTracks()) addTrack(track, stream);
    },
    addTrack,
    removeTrack: track => {
      const sender = senders.get(track);
      if (!sender) return;
      senders.delete(track);
      try {
        pc.removeTrack(sender);
      } catch {}
    },
    replaceTrack: async (oldTrack, newTrack) => {
      const sender = senders.get(oldTrack);
      if (!sender) return;
      senders.delete(oldTrack);
      senders.set(newTrack, sender);
      await sender.replaceTrack(newTrack);
    },
    getPeers: () => (joined && !left ? {[PEER]: pc} : {}),
    action: name => ({
      send: data => Promise.resolve(send(name, data)),
      set onMessage(fn) {
        listeners.set(name, fn);
      },
    }),
    status: () => [{family: 'вручную', relays: [], aliveCount: 1, alive: true}],
    troubles: () => [],
    leave: async () => {
      left = true;
      try {
        channel.close();
      } catch {}
      pc.close();
    },
  };
};
