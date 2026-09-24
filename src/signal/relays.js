import {defaultRelayUrls as nostrDefaults} from '@trystero-p2p/nostr';
import {defaultRelayUrls as mqttDefaults} from '@trystero-p2p/mqtt';

// Проверено пробником tools/probe.mjs 24.09.2026: живы все восемь каналов,
// которыми пользуется приложение, и ещё девятнадцать в запасе.
// Адреса смертны: пробник стоит прогонять заново время от времени.
//
// Прежние прогоны врали про mqtt: пробник открывал брокеры без подпротокола
// «mqtt», и mosquitto с emqx рвали такое соединение сразу. Живые брокеры
// числились мёртвыми, хотя приложение (библиотека подпротокол ставит) всё
// это время ими пользовалось.
export const VERIFIED_ON = '2026-09-24';

export const VERIFIED = {
  nostr: ['wss://nos.lol', 'wss://relay.snort.social'],
  mqtt: ['wss://broker.hivemq.com:8884/mqtt'],
};

// Сколько адресов держим одновременно в одном семействе.
// Больше — надёжнее и дороже; четыре хватает.
export const REDUNDANCY = 4;

const DEFAULTS = {
  nostr: nostrDefaults,
  mqtt: mqttDefaults,
};

// Все кандидаты семейства по порядку предпочтения: сначала проверенные
// нами, потом библиотечные. Отдельно от relayUrlsFor — чтобы пробник мерил
// ровно тот список, из которого выбирает приложение. Раньше у пробника был
// свой, и он годами проверял одни адреса, пока приложение ходило в другие.
export const candidatesFor = family => {
  const verified = VERIFIED[family];
  if (!verified) throw new Error(`Неизвестное семейство каналов: ${family}`);
  return [...new Set([...verified, ...DEFAULTS[family]])];
};

// Дописываем, а не заменяем: у библиотеки список шире и она его чинит,
// но живые адреса из нашего пробника в него не всегда входят.
export const relayUrlsFor = family => candidatesFor(family).slice(0, REDUNDANCY);
