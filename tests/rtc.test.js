import {afterEach, describe, expect, it} from 'vitest';
import {createRtcClass, relayInUse, useRelay, withRelay} from '../src/rtc.js';

const STUN = {urls: 'stun:stun.l.google.com:19302'};
const TURN = [
  {urls: 'turn:relay.test:3478', username: '1:n', credential: 'c'},
  {urls: 'turn:relay.test:3478?transport=tcp', username: '1:n', credential: 'c'},
];

// Поддельное соединение: помнит настройку и то, что ему передавали.
class Поддельное {
  constructor(config) {
    this.config = config;
  }
  getConfiguration() {
    return this.config;
  }
  setConfiguration(config) {
    this.config = config;
  }
  setRemoteDescription(description) {
    this.remote = description;
    return Promise.resolve();
  }
}

const есть = pc => pc.config.iceServers.some(s => String(s.urls).startsWith('turn:'));

afterEach(() => useRelay([]));

describe('ретранслятор получают только отвечающие', () => {
  it('заготовке ретранслятор не положен, даже если его передали', () => {
    // Библиотека строит заготовку с тем, что ей дали; мы вынимаем
    // ретранслятор ещё до рождения соединения — иначе оно попросит место.
    useRelay(TURN);
    const Класс = createRtcClass(Поддельное);

    const pc = new Класс({iceServers: [STUN, ...TURN]});

    expect(есть(pc)).toBe(false);
    expect(pc.config.iceServers).toEqual([STUN]);
  });

  it('пришло предложение — подключаем ретранслятор до ответа', async () => {
    useRelay(TURN);
    const Класс = createRtcClass(Поддельное);
    const pc = new Класс({iceServers: [STUN]});

    await pc.setRemoteDescription({type: 'offer', sdp: 'v=0'});

    expect(есть(pc)).toBe(true);
    expect(pc.config.iceServers[0]).toEqual(STUN);
    expect(pc.remote).toEqual({type: 'offer', sdp: 'v=0'});
  });

  it('пришёл ответ — мы предлагали, ретранслятор не нужен', async () => {
    // В паре ретранслятор нужен с одной стороны, и это отвечающая.
    useRelay(TURN);
    const Класс = createRtcClass(Поддельное);
    const pc = new Класс({iceServers: [STUN]});

    await pc.setRemoteDescription({type: 'answer', sdp: 'v=0'});

    expect(есть(pc)).toBe(false);
  });

  it('ретранслятора нет вовсе — настройку не трогаем', async () => {
    const Класс = createRtcClass(Поддельное);
    const pc = new Класс({iceServers: [STUN]});

    await pc.setRemoteDescription({type: 'offer', sdp: 'v=0'});

    expect(pc.config.iceServers).toEqual([STUN]);
  });

  it('ретранслятор появился уже после рождения соединения — всё равно достаётся', async () => {
    // Гость узнаёт о ретрансляторе из ссылки, а соединения библиотека может
    // начать строить раньше. Класс смотрит на ретранслятор в момент ответа,
    // а не в момент рождения.
    const Класс = createRtcClass(Поддельное);
    const pc = new Класс({iceServers: [STUN]});

    useRelay(TURN);
    await pc.setRemoteDescription({type: 'offer', sdp: 'v=0'});

    expect(есть(pc)).toBe(true);
  });

  it('перенастроить не дали — отвечаем как есть и не падаем', async () => {
    useRelay(TURN);
    class Упрямое extends Поддельное {
      setConfiguration() {
        throw new Error('InvalidModificationError');
      }
    }
    const Класс = createRtcClass(Упрямое);
    const pc = new Класс({iceServers: [STUN]});

    await expect(pc.setRemoteDescription({type: 'offer', sdp: 'v=0'})).resolves.toBeUndefined();
    expect(pc.remote).toEqual({type: 'offer', sdp: 'v=0'});
  });

  it('повторное предложение не удваивает ретранслятор', async () => {
    // Предложение приходит и на живое соединение — при каждом включении
    // камеры. Настройка не должна распухать на каждом.
    useRelay(TURN);
    const Класс = createRtcClass(Поддельное);
    const pc = new Класс({iceServers: [STUN]});

    await pc.setRemoteDescription({type: 'offer', sdp: '1'});
    await pc.setRemoteDescription({type: 'offer', sdp: '2'});

    expect(pc.config.iceServers).toHaveLength(1 + TURN.length);
  });
});

describe('подмена ретранслятора в настройке', () => {
  it('STUN остаётся, прежний ретранслятор уходит, новый встаёт', () => {
    const старый = {urls: 'turns:old.test:443', username: 'x', credential: 'y'};

    expect(withRelay({iceServers: [STUN, старый]}, TURN).iceServers).toEqual([STUN, ...TURN]);
  });

  it('прочие поля настройки не теряются', () => {
    expect(withRelay({iceServers: [], bundlePolicy: 'max-bundle'}, []).bundlePolicy).toBe(
      'max-bundle',
    );
  });

  it('без настоящего RTCPeerConnection класса нет — пусть библиотека берёт свой', () => {
    expect(createRtcClass(undefined)).toBeUndefined();
  });

  it('useRelay принимает только список', () => {
    useRelay(null);
    expect(relayInUse()).toEqual([]);
    useRelay(TURN);
    expect(relayInUse()).toEqual(TURN);
  });
});
