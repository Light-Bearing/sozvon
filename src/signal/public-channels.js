import {joinRoom as joinNostr, getRelaySockets as nostrSockets} from '@trystero-p2p/nostr';
import {joinRoom as joinMqtt, getRelaySockets as mqttSockets} from '@trystero-p2p/mqtt';
import {createPeerRegistry} from './dedupe.js';
import {relayUrlsFor} from './relays.js';
import {troubleFrom} from './trouble.js';

export const APP_ID = 'sozvon';

// Числовое значение WebSocket.OPEN — берём его как литерал, а не через
// глобальный WebSocket, чтобы status() не зависел от окружения (в тестах
// глобального WebSocket может не быть вовсе).
const SOCKET_OPEN = 1;

// Торрент-трекеров здесь больше нет, и это осознанный размен.
//
// Библиотека знакомит через них так: представляется торрент-клиентом и
// шлёт обычную анкету участника раздачи — info_hash, peer_id, numwant.
// Файлов не качает ни байта, но выглядит именно как качалка. Отсюда две
// беды сразу: такие адреса режут первыми там, где сеть зажата (работа,
// гостиница), и на них ругается защитное ПО — у человека рабочий
// антивирус кричал четыре минуты. Звонилка, из-за которой воет
// антивирус, теряет доверие быстрее, чем выигрывает надёжность.
//
// Остаются два независимых семейства: этого хватает, чтобы пережить
// смерть любого одного. За неделю проверок рукопожатие не ломалось ни
// разу — ломался путь для звука, а не знакомство.
const FAMILIES = [
  {family: 'nostr', join: joinNostr, getRelaySockets: nostrSockets},
  {family: 'mqtt', join: joinMqtt, getRelaySockets: mqttSockets},
];

// Отладочный отбор семейств по адресу страницы — например, ?каналы=nostr
// или ?каналы=torrent,mqtt, — чтобы проверить «а если оставить одно
// семейство, связь встанет?» (см. main.js). Разбор строки и отбор по имени
// нарочно разделены: первый ничего не знает про сами семейства, второй
// ничего не знает про URL — каждый проверяется тестом отдельно и без браузера.
export const parseFamilyNames = value =>
  value
    ?.split(',')
    .map(name => name.trim())
    .filter(Boolean) ?? [];

// Без имён (параметра нет или он пуст) — все семейства, как всегда.
// Неизвестные имена молча отсеиваются: это инструмент для собственного
// эксперимента разработчика, а не пользовательский ввод, который нужно
// проверять на опечатки.
export const familiesFor = (names, all = FAMILIES) =>
  names.length ? all.filter(({family}) => names.includes(family)) : all;

// families — необязательный параметр только для тестов: подсовывает
// поддельные {family, join} вместо трёх настоящих пакетов. Вызывающие из
// приложения его не передают и получают FAMILIES по умолчанию.
// turnConfig — список ретрансляторов для льда. Библиотека дописывает его к
// своим STUN-серверам, а не заменяет их: прямой путь по-прежнему пробуется
// первым, ретранслятор включается только когда прямого нет.
export const joinPublicChannels = ({
  roomId,
  password,
  handlers,
  families = FAMILIES,
  turnConfig,
}) => {
  const registry = createPeerRegistry();

  // Участники, чей поток уже пропущен наверх. Второй и далее поток от
  // того же участника отбрасываем — неважно, каким семейством он пришёл:
  // на приёме мы не привередничаем, откуда, лишь бы не повторялось.
  const streamedPeers = new Set();

  // Поток каждого собеседника собираем САМИ, а не отдаём наверх тот, что
  // дала библиотека. Причина простая: пересогласование случается на каждое
  // включение микрофона или камеры, и дорожка после него может приехать с
  // другим объектом потока. Отдай мы его как есть — плитка мгновенно
  // потеряла бы всё, чего в нём нет: включил звук, пропала картинка.
  // Свой поток этого не умеет: в него только добавляют и из него убирают.
  const peerStreams = new Map();

  const streamFor = peerId => {
    if (!peerStreams.has(peerId)) peerStreams.set(peerId, new MediaStream());
    return peerStreams.get(peerId);
  };

  const takeTrack = (track, peerId) => {
    const stream = streamFor(peerId);

    // У собеседника в разговоре не бывает двух микрофонов или двух камер:
    // новая дорожка того же вида ЗАМЕНЯЕТ прежнюю. Без этого правила после
    // каждого пересогласования — а оно случается на любое включение
    // микрофона — в потоке копились бы мёртвые дорожки, и проигрыватель
    // брал бы первую из них, то есть показывал пустоту вместо картинки.
    for (const прежняя of stream.getTracks()) {
      if (прежняя !== track && прежняя.kind === track.kind) stream.removeTrack(прежняя);
    }
    stream.addTrack(track);

    // Собеседник выключил камеру — дорожка глохнет, но не исчезает.
    // Перерисовываем, чтобы плитка честно потемнела, а кончившуюся дорожку
    // убираем совсем.
    const обновить = () => {
      if (peerStreams.get(peerId) !== stream) return;
      if (track.readyState === 'ended') stream.removeTrack(track);
      handlers.onPeerStream?.(stream, peerId);
    };
    for (const событие of ['ended', 'mute', 'unmute']) {
      track.addEventListener(событие, обновить);
    }

    handlers.onPeerStream?.(stream, peerId);
  };

  // Собеседники, которых канал нашёл, а соединиться с ними не вышло.
  // Ключ — участник, значение — вид беды из trouble.js. Пока этого не было,
  // неудача выглядела как бесконечное «жду, когда зайдут»: onPeerJoin
  // срабатывает только на открытом канале данных, поэтому провал льда не
  // производил вообще никаких событий и экран честно ничего не знал.
  const troubles = new Map();

  const tellTroubles = () =>
    handlers.onTrouble?.([...troubles].map(([peerId, kind]) => ({peerId, kind})));

  // Поток, который раздаёт приложение. Храним, чтобы отправить его и
  // новым участникам (при claim), и участнику, у которого сменился
  // владелец (см. «призрак» в onPeerLeave).
  let localStream = null;

  const channels = families.map(({family, join, getRelaySockets = () => ({})}) => {
    const relays = relayUrlsFor(family);
    const room = join(
      {
        appId: APP_ID,
        password,
        relayConfig: {urls: relays},
        ...(turnConfig?.length ? {turnConfig} : {}),
      },
      roomId,
      {
        onJoinError: ({peerId, error}) => {
          // На вошедшего жаловаться не на что: у него как раз получилось.
          if (registry.ownerOf(peerId)) return;
          const kind = troubleFrom(error);
          // Ту же беду обычно приносят все три семейства подряд — наверх
          // сообщаем только о смене, а не о каждом повторе.
          if (troubles.get(peerId) === kind) return;
          troubles.set(peerId, kind);
          tellTroubles();
        },
      },
    );

    room.onPeerJoin = peerId => {
      // Вошёл — значит, беда кончилась, каким бы семейством он ни вошёл:
      // снимаем жалобу до разбора владения, иначе она осталась бы висеть
      // при входе через не-владельца.
      if (troubles.delete(peerId)) tellTroubles();
      if (!registry.claim(peerId, family)) return;
      if (localStream) room.addStream(localStream, {target: peerId});
      handlers.onPeerJoin?.(peerId);
    };
    room.onPeerLeave = peerId => {
      if (!registry.release(peerId, family)) return;

      // Призрак: соединение владельца пропало, но другое семейство того
      // же участника ещё живо. Молча переносим владение туда — наверх об
      // уходе не сообщаем, а живой поток переотправляем по новому адресу.
      const ghost = channels.find(
        c => c.family !== family && Object.hasOwn(c.room.getPeers(), peerId),
      );
      if (ghost) {
        registry.claim(peerId, ghost.family);
        if (localStream) ghost.room.addStream(localStream, {target: peerId});
        streamedPeers.delete(peerId);
        return;
      }

      streamedPeers.delete(peerId);
      peerStreams.delete(peerId);
      handlers.onPeerLeave?.(peerId);
    };
    room.onPeerStream = (stream, peerId) => {
      if (streamedPeers.has(peerId)) return;
      streamedPeers.add(peerId);
      for (const track of stream.getTracks()) takeTrack(track, peerId);
    };

    // Дорожку, добавленную ПОСЛЕ того как соединение встало, — а у нас это
    // обычный случай, потому что микрофон и камеру человек включает уже
    // внутри разговора, — библиотека отдаёт сюда, а не в onPeerStream. Пока
    // этого обработчика не было, медиа собеседника доходило до соединения и
    // молча терялось по дороге к экрану: в receiveRemoteTrack у библиотеки
    // для таких дорожек зовётся onPeerTrack, и только он.
    //
    // Объявляем наверх КАЖДУЮ дорожку, без отсева: звук и картинка приходят
    // по отдельности и в один и тот же поток, и если смолчать на второй,
    // видео не появится следом за звуком. Повторное объявление того же
    // потока ничего не стоит — комната просто перерисует плитку.
    room.onPeerTrack = (track, _stream, peerId) => {
      streamedPeers.add(peerId);
      takeTrack(track, peerId);
    };

    return {family, relays, room, getRelaySockets};
  });

  const roomOf = family => channels.find(c => c.family === family).room;

  // Эти две операции по-прежнему обходят все комнаты без разбора:
  // replaceTrack безопасно проходит мимо соединений без нужной дорожки
  // (peer.mjs ничего не делает, если трек не найден), а leave обязан
  // закрыть вообще все соединения, а не только соединение владельца.
  const everyRoom = fn => channels.map(({room}) => fn(room));

  return {
    // Раздаём каждому участнику только через комнату его владельца.
    // Лишние соединения (у остальных семейств) существуют, но дорожек не
    // получают — именно потому, что мы шлём адресно, а не потому что их
    // кто-то фильтрует на приёме.
    addStream: stream => {
      localStream = stream;
      for (const peerId of registry.peers()) {
        roomOf(registry.ownerOf(peerId)).addStream(stream, {target: peerId});
      }
    },
    // Дорожка по требованию (включение микрофона/камеры человеком после
    // входа) — тот же принцип, что у addStream() выше: решает отправитель,
    // шлём только владельцу и адресно. localStream держим свежим и здесь:
    // это тот же общий поток, что мутирует media.js (там addTrack()/
    // removeTrack() дописывают и убирают дорожки в НЁМ ЖЕ, не пересоздавая
    // объект) — поэтому участнику, подключившемуся позже, ничего досылать
    // не нужно: onPeerJoin() ниже сам отдаст localStream целиком, уже со
    // всеми дорожками, какие в нём на тот момент есть.
    addTrack: (track, stream) => {
      localStream = stream;
      for (const peerId of registry.peers()) {
        roomOf(registry.ownerOf(peerId)).addTrack(track, stream, {target: peerId});
      }
    },
    // Снимает дорожку с уже установленных соединений (человек выключил
    // микрофон или камеру). Поток здесь не нужен — библиотека находит
    // отправителя по самой дорожке.
    removeTrack: track => {
      for (const peerId of registry.peers()) {
        roomOf(registry.ownerOf(peerId)).removeTrack(track, {target: peerId});
      }
    },
    replaceTrack: (oldTrack, newTrack) =>
      everyRoom(room => room.replaceTrack(oldTrack, newTrack)),
    getPeers: () =>
      Object.fromEntries(
        channels.flatMap(({family, room}) =>
          Object.entries(room.getPeers()).filter(
            ([peerId]) => registry.ownerOf(peerId) === family,
          ),
        ),
      ),
    action: namespace => {
      const actions = new Map(
        channels.map(({family, room}) => [family, room.makeAction(namespace)]),
      );
      return {
        // Адресуем и группируем по владельцу: каждому каналу — один вызов
        // send со списком его участников. Каналу, чьих участников сейчас
        // нет, не отправляем вообще ничего.
        send: data => {
          const targetsByOwner = new Map();
          for (const peerId of registry.peers()) {
            const owner = registry.ownerOf(peerId);
            if (!targetsByOwner.has(owner)) targetsByOwner.set(owner, []);
            targetsByOwner.get(owner).push(peerId);
          }
          return Promise.all(
            [...targetsByOwner].map(([family, targets]) =>
              actions.get(family).send(data, {target: targets}),
            ),
          );
        },
        // Фильтр не нужен: отправитель уже гарантировал единственность
        // сообщения, поэтому onMessage вешаем на все три семейства как
        // есть.
        set onMessage(fn) {
          for (const action of actions.values()) action.onMessage = fn;
        },
      };
    },
    // Живость семейства — по сокетам его собственных адресов из relays, а
    // не по одному только факту, что список адресов настроен: настроенный
    // адрес ничего не говорит о том, отвечает ли он сейчас. getRelaySockets()
    // библиотека отдаёт как {url: WebSocket} — считаем семейство живым, если
    // хоть один из НАШИХ адресов сейчас в состоянии OPEN.
    status: () =>
      channels.map(({family, relays, getRelaySockets}) => {
        const sockets = getRelaySockets();
        const aliveCount = relays.filter(url => sockets[url]?.readyState === SOCKET_OPEN).length;
        return {family, relays, aliveCount, alive: aliveCount > 0};
      }),
    troubles: () => [...troubles].map(([peerId, kind]) => ({peerId, kind})),
    leave: () => Promise.all(everyRoom(room => room.leave())),
  };
};
