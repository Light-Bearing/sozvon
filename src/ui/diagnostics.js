// Тот же пробник, что tools/probe.mjs, но в браузере. Здесь — и только
// здесь — разрешены технические слова.

import {relayUrlsFor} from '../signal/relays.js';

const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.nextcloud.com:3478',
];

const reflexiveFrom = candidate => {
  const parts = candidate.split(' ');
  return parts[7] === 'srflx' ? {ip: parts[4], port: Number(parts[5])} : null;
};

// Собираем адреса через каждый STUN отдельно: если внешний порт у всех
// один — NAT дружелюбный, если разный — симметричный, и прямая связь
// с таким же собеседником не встанет.
const gatherVia = urls =>
  new Promise(resolve => {
    const pc = new RTCPeerConnection({iceServers: [{urls}]});
    const found = [];
    const finish = () => {
      pc.close();
      resolve(found);
    };
    const timer = setTimeout(finish, 5_000);

    pc.onicecandidate = ({candidate}) => {
      if (!candidate) {
        clearTimeout(timer);
        return finish();
      }
      const srflx = reflexiveFrom(candidate.candidate);
      if (srflx) found.push(srflx);
    };

    pc.createDataChannel('probe');
    pc.createOffer().then(offer => pc.setLocalDescription(offer));
  });

export const checkNat = async () => {
  const results = await Promise.all(STUN_SERVERS.map(url => gatherVia(url)));
  const seen = results.flat();

  if (!seen.length) {
    return {
      verdict: 'Снаружи вас не видно — похоже, сеть закрывает UDP. Прямая связь здесь не встанет.',
      external: null,
      ports: [],
    };
  }

  const ips = [...new Set(seen.map(s => s.ip))];
  const ports = [...new Set(seen.map(s => s.port))];

  const verdict =
    ports.length === 1
      ? 'NAT дружелюбный: порт снаружи один и тот же. Прямая связь будет вставать.'
      : 'NAT симметричный: порт снаружи меняется. С таким же собеседником прямая связь не встанет — нужен ретранслятор.';

  return {verdict, external: ips.join(', '), ports};
};

const pingRelay = url =>
  new Promise(resolve => {
    const started = performance.now();
    let socket;
    const done = ok => {
      try {
        socket?.close();
      } catch {}
      resolve({url, ok, ms: Math.round(performance.now() - started)});
    };
    const timer = setTimeout(() => done(false), 7_000);
    try {
      socket = new WebSocket(url);
    } catch {
      clearTimeout(timer);
      return done(false);
    }
    socket.onopen = () => {
      clearTimeout(timer);
      done(true);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      done(false);
    };
  });

export const checkRelays = async () => {
  const targets = ['torrent', 'nostr', 'mqtt'].flatMap(family =>
    relayUrlsFor(family).map(url => ({family, url})),
  );
  const checked = await Promise.all(
    targets.map(async ({family, url}) => ({family, ...(await pingRelay(url))})),
  );
  return checked;
};

export const renderDiagnostics = async container => {
  container.textContent = 'Проверяю…';

  const [nat, relays] = await Promise.all([checkNat(), checkRelays()]);

  const alive = relays.filter(r => r.ok);
  const families = new Set(alive.map(r => r.family));

  container.replaceChildren();
  const add = (tag, text) => {
    const el = document.createElement(tag);
    el.textContent = text;
    container.append(el);
    return el;
  };

  add('h2', 'Как вас видно снаружи');
  add('p', nat.verdict);
  if (nat.external) add('p', `Внешний адрес: ${nat.external}`);

  add('h2', 'Каналы для рукопожатия');
  add(
    'p',
    families.size === 0
      ? 'Ни один канал не отвечает. Остаётся ручной обмен.'
      : `Живых адресов ${alive.length} из ${relays.length}, независимых семейств ${families.size} из 3.`,
  );

  const list = document.createElement('ul');
  for (const {family, url, ok, ms} of relays) {
    const item = document.createElement('li');
    item.textContent = `${ok ? '✓' : '✗'} ${family} — ${url}${ok ? ` (${ms} мс)` : ''}`;
    list.append(item);
  }
  container.append(list);
};
