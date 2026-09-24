import {afterEach, describe, expect, it} from 'vitest';
import {checkRelayServer, explainRelay} from '../src/ui/diagnostics.js';

// Три разных беды требуют трёх разных действий, и путать их нельзя:
// «не настроен» — ничего чинить не надо; «не отвечает» — чинить машину;
// «пропуск не принят» — чинить ключ в настройках.
describe('объяснение про свой ретранслятор', () => {
  it('не настроен — это не поломка', () => {
    expect(explainRelay({configured: false})).toContain('не настроен');
  });

  it('работает', () => {
    expect(explainRelay({configured: true, alive: true, accepted: true})).toContain('работает');
  });

  it('отвечает, но пропуск не принял — отправляем к ключу', () => {
    expect(explainRelay({configured: true, alive: true, accepted: false})).toContain('ключ');
  });

  it('не отвечает — отправляем к машине и брандмауэру', () => {
    const text = explainRelay({configured: true, alive: false, accepted: false});

    expect(text).toContain('не отвечает');
    expect(text).toContain('3478');
  });
});

describe('проверка ретранслятора у гостя с пропуском', () => {
  // Гость с пропуском из приглашения ключа не имеет, а ретранслятор у него
  // есть. Проверка обязана проверять именно его — иначе на экране неудачи
  // гость читал «не настроен» ровно тогда, когда ретранслятор был.
  const было = globalThis.RTCPeerConnection;
  afterEach(() => {
    globalThis.RTCPeerConnection = было;
  });

  // Поддельное соединение: на первый же сбор путей отдаёт кандидата
  // нужного вида и запоминает, с какими серверами его построили.
  const подделать = (вид, серверы) => {
    globalThis.RTCPeerConnection = class {
      constructor(config) {
        серверы.push(config.iceServers);
      }
      createDataChannel() {}
      async createOffer() {
        return {type: 'offer', sdp: ''};
      }
      async setLocalDescription() {
        queueMicrotask(() => this.onicecandidate?.({candidate: {type: вид}}));
      }
      close() {}
    };
  };

  it('ключа нет, пропуск есть — проверяется пропуск', async () => {
    const серверы = [];
    подделать('relay', серверы);
    const пропуск = [{urls: 'turn:195.0.2.1:3478', username: '9999999999:s', credential: 'c'}];

    const итог = await checkRelayServer({}, {timeoutMs: 5, servers: пропуск});

    expect(итог).toEqual({configured: true, alive: true, accepted: true});
    expect(серверы[0]).toEqual(пропуск);
  });

  it('нет ни ключа, ни пропуска — честное «не настроен»', async () => {
    expect(await checkRelayServer({}, {timeoutMs: 5, servers: []})).toEqual({configured: false});
  });
});
