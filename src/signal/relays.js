import {defaultRelayUrls as torrentDefaults} from '@trystero-p2p/torrent';
import {defaultRelayUrls as nostrDefaults} from '@trystero-p2p/nostr';
import {defaultRelayUrls as mqttDefaults} from '@trystero-p2p/mqtt';

// Проверено пробником tools/probe.mjs с домашней сети 14.09.2026.
// Адреса смертны: пробник стоит прогонять заново время от времени.
export const VERIFIED_ON = '2026-09-14';

export const VERIFIED = {
  torrent: ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'],
  nostr: ['wss://nos.lol', 'wss://relay.snort.social'],
  mqtt: ['wss://broker.hivemq.com:8884/mqtt'],
};

// Сколько адресов держим одновременно в одном семействе.
// Больше — надёжнее и дороже; четыре хватает.
export const REDUNDANCY = 4;

const DEFAULTS = {
  torrent: torrentDefaults,
  nostr: nostrDefaults,
  mqtt: mqttDefaults,
};

// Дописываем, а не заменяем: у библиотеки список шире и она его чинит,
// но живые адреса из нашего пробника в него не всегда входят.
export const relayUrlsFor = family => {
  const verified = VERIFIED[family];
  if (!verified) throw new Error(`Неизвестное семейство каналов: ${family}`);
  return [...new Set([...verified, ...DEFAULTS[family]])].slice(0, REDUNDANCY);
};
