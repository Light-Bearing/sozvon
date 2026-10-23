// Ретранслятор — только там, где он нужен.
//
// Библиотека заранее готовит по двадцать соединений на каждое семейство
// каналов и раз в три минуты переиздаёт их с перезапуском поиска пути. Дай
// ретранслятор всем соединениям — каждая заготовка просит на нём два места
// (обычное и по TCP), и так снова и снова. У хозяина это было восемьдесят
// просьб за один вход при двенадцати местах на имя: места разбирали
// заготовки, которые почти никогда никому не пригождаются, а настоящему
// соединению могло не достаться. Раздай ретранслятор ещё и гостям —
// умножь это на число людей.
//
// Но паре ретранслятор нужен только с одной стороны: лёд соединяет пару,
// если достижим хоть один её конец. А в каждой паре ровно одна сторона
// отвечает на предложение, и отвечающее соединение библиотека всегда
// создаёт заново, не из заготовок. Поэтому ретранслятор получают ровно
// отвечающие: у каждой пары он есть, у заготовок его нет.

import {withBetterAudio} from './opus.js';

let relay = [];

// Какой ретранслятор сейчас в ходу. Живёт здесь, а не в настройке комнаты:
// соединения создаёт библиотека, и спросить у неё «а ретранслятор теперь
// другой» нельзя — можно только дать соединению заглянуть сюда само.
export const useRelay = servers => {
  relay = Array.isArray(servers) ? servers.filter(Boolean) : [];
};

export const relayInUse = () => relay;

const isRelay = server =>
  [].concat(server?.urls ?? []).some(url => /^turns?:/i.test(String(url)));

// Настройка соединения с заданным ретранслятором вместо прежнего. Прочие
// серверы (STUN) не трогаем: по ним соединение узнаёт свой внешний адрес.
export const withRelay = (config, servers = []) => {
  const kept = (config?.iceServers ?? []).filter(server => !isRelay(server));
  return {...config, iceServers: [...kept, ...servers]};
};

// Класс соединения для библиотеки (её параметр rtcPolyfill). Base — ради
// проверок: в тестовой среде настоящего RTCPeerConnection нет.
// Сколько ждать адресов после setLocalDescription. Свои адреса появляются
// мгновенно, внешний — за доли секунды, ретранслятор — меньше чем за
// секунду; полный сбор бывает и по сорок секунд (недоступный сервер
// отвечает отказом нескоро) — столько не ждём.
export const GATHER_WAIT_MS = 1500;

// Ждём, пока соберутся адреса, но не дольше limit. Отказ — не наша забота:
// ждать нечего, setLocalDescription уже ответил сам.
export const settleGathering = (pc, limit = GATHER_WAIT_MS) =>
  new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener?.('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, limit);
    pc.addEventListener?.('icegatheringstatechange', check);
  });

export const createRtcClass = (Base = globalThis.RTCPeerConnection) => {
  if (typeof Base !== 'function') return undefined;

  return class extends Base {
    constructor(config, ...rest) {
      // Заготовке ретранслятор не положен: она почти наверняка никому не
      // пригодится, а место на нём займёт.
      super(withRelay(config, []), ...rest);
    }

    // Описание уходит собеседнику только с адресами. Библиотека шлёт его
    // сразу после setLocalDescription, а адреса досылает следом — но у
    // заготовки, которую она только что обновила со сменой адресов, их
    // досылать некому: она ещё ни к кому не привязана, и адреса теряются.
    // Гость, пришедший в этот миг, получал описание без единого адреса, и
    // связь не вставала — «прямого пути нет». После долгого обрыва сети
    // так выходило всегда: отложенные обновления срабатывают разом.
    // Поэтому ждём сбора (не дольше полутора секунд): тогда адреса — уже в
    // самом описании, а досылка остаётся запасной.
    async setLocalDescription(description, ...rest) {
      await super.setLocalDescription(description, ...rest);
      if (description?.type === 'rollback') return;
      await settleGathering(this);
    }

    setRemoteDescription(description, ...rest) {
      // Пришло предложение — значит, мы отвечаем. Ретранслятор подключаем
      // ДО ответа: сбор путей начнётся на setLocalDescription, и адрес
      // ретранслятора должен в него попасть.
      //
      // Предложение приходит и на живое соединение — когда собеседник
      // включает камеру и договаривается заново. Там перенастройка ничего
      // не запускает сама, но пригодится, если путь придётся искать заново
      // (см. src/revive.js).
      if (description?.type === 'offer' && relay.length) {
        try {
          this.setConfiguration(withRelay(this.getConfiguration(), relay));
        } catch {
          // Перенастроить не дали — ответим как есть. Прямой путь от этого
          // не хуже, чем был бы без ретранслятора вовсе.
        }
      }
      // Звук почище — см. src/opus.js.
      return super.setRemoteDescription(withBetterAudio(description), ...rest);
    }
  };
};
