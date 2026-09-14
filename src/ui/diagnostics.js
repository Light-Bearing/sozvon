// Тот же пробник, что tools/probe.mjs, но в браузере. Здесь — и только
// здесь — разрешены технические слова.

import {relayUrlsFor} from '../signal/relays.js';

const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.nextcloud.com:3478',
];

// У отражённого (srflx) кандидата ip:port — внешний адрес, каким его
// увидел STUN-сервер. raddr:rport — локальный адрес и порт, с которого
// ушёл запрос. Сравнивать внешние порты честно можно только у кандидатов
// с одинаковым rport: это значит, что они добыты с одного и того же
// локального порта.
const reflexiveFrom = candidate => {
  const parts = candidate.split(' ');
  if (parts[7] !== 'srflx') return null;
  const raddrAt = parts.indexOf('raddr');
  const rportAt = parts.indexOf('rport');
  return {
    ip: parts[4],
    port: Number(parts[5]),
    raddr: raddrAt >= 0 ? parts[raddrAt + 1] : null,
    rport: rportAt >= 0 ? Number(parts[rportAt + 1]) : null,
  };
};

// Все STUN-серверы — в ОДНОМ RTCPeerConnection, одним списком iceServers,
// а не по отдельному соединению на сервер. У раздельных соединений разные
// локальные UDP-порты, и на NAT, который сохраняет порт (внешний порт
// равен локальному), это выглядело бы как смена внешнего порта от
// собеседника к собеседнику — то есть как симметричный NAT, хотя на
// самом деле это просто три разных локальных порта на ровном месте.
// Один RTCPeerConnection — как правило один локальный порт на все
// STUN-запросы, и тогда разница во внешних портах значит то, что должна:
// зависимость отображения от собеседника, а не от того, откуда спросили.
const gatherAll = () =>
  new Promise(resolve => {
    const pc = new RTCPeerConnection({iceServers: STUN_SERVERS.map(urls => ({urls}))});
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
  const found = await gatherAll();

  if (!found.length) {
    return {
      verdict: 'Снаружи вас не видно — похоже, сеть закрывает UDP. Прямая связь здесь не встанет.',
      external: null,
      ports: [],
    };
  }

  const external = [...new Set(found.map(s => s.ip))].join(', ');
  const ports = [...new Set(found.map(s => s.port))];

  // Хоть один STUN отразил тот же адрес, что и локальный (raddr) —
  // транслятора вообще нет, адрес и так публичный. Это видно уже по
  // одному ответу, сравнивать не с чем и не нужно.
  if (found.some(s => s.ip === s.raddr)) {
    return {
      verdict: 'NAT нет: адрес и так публичный. Прямая связь будет вставать всегда.',
      external,
      ports,
    };
  }

  // Группируем по локальному порту (rport), с которого ушёл запрос —
  // внутри одной группы кандидаты сравнимы честно. Группа из одного
  // кандидата сравнению не подлежит: не с чем сверить.
  const groups = new Map();
  for (const s of found) {
    if (!groups.has(s.rport)) groups.set(s.rport, []);
    groups.get(s.rport).push(s);
  }
  const comparable = [...groups.values()].filter(group => group.length > 1);

  // Единственный кандидат бывает двумя разными путями: либо и правда
  // ответил только один STUN, либо ответили все, но сошлись в одном и
  // том же адресе — тогда браузер сам убрал дубликаты как избыточные,
  // и это на самом деле дружелюбный NAT, просто через RTCPeerConnection
  // это от «ответил один» не отличить. Раз не отличить — не гадаем.
  if (!comparable.length) {
    return {
      verdict: 'Отражённый адрес получен только один: сравнивать не с чем, тип NAT не определить.',
      external,
      ports,
    };
  }

  const symmetric = comparable.some(group => new Set(group.map(s => s.port)).size > 1);

  const verdict = symmetric
    ? 'NAT симметричный: порт снаружи меняется. С таким же собеседником прямая связь не встанет — нужен ретранслятор.'
    : 'NAT дружелюбный: порт снаружи один и тот же. Прямая связь будет вставать.';

  return {verdict, external, ports};
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
    item.dataset.ok = ok ? 'yes' : 'no';

    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = ok ? '✓' : '✗';

    const where = document.createElement('span');
    where.textContent = `${family} · ${url}`;

    item.append(mark, where);
    if (ok) {
      const took = document.createElement('span');
      took.textContent = `${ms} мс`;
      item.append(took);
    }
    list.append(item);
  }
  container.append(list);
};
