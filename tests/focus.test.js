import {describe, expect, it} from 'vitest';
import {followScreens} from '../src/focus.js';

const собеседник = (peerId, screen = null) => ({peerId, stream: null, screen, name: null});
const поток = {id: 'экран'};

describe('чужой показ экрана сам становится крупным', () => {
  it('начался показ — закрепляем его', () => {
    const было = {peers: [собеседник('петя', поток)], pinned: null, seen: new Set()};

    expect(followScreens(было).pinned).toBe('петя|screen');
  });

  it('второй раз подряд не закрепляем — показ уже видели', () => {
    // Иначе человек, снявший закрепление руками, получал бы его обратно на
    // следующей же перерисовке — а их несколько в секунду.
    const peers = [собеседник('петя', поток)];
    const {seen} = followScreens({peers, pinned: null, seen: new Set()});

    expect(followScreens({peers, pinned: null, seen}).pinned).toBe(null);
  });

  it('занятое место не отбираем', () => {
    // Человек уже выбрал, на кого смотреть; его выбор старше нашей догадки.
    const было = {peers: [собеседник('петя', поток)], pinned: 'маша', seen: new Set()};

    expect(followScreens(было).pinned).toBe('маша');
  });

  it('показ кончился — раскладка возвращается', () => {
    const было = {peers: [собеседник('петя')], pinned: 'петя|screen', seen: new Set(['петя|screen'])};

    expect(followScreens(было).pinned).toBe(null);
  });

  it('закреплённого человека показ соседа не трогает', () => {
    const было = {
      peers: [собеседник('петя', поток), собеседник('маша')],
      pinned: 'маша',
      seen: new Set(['петя|screen']),
    };

    expect(followScreens(было).pinned).toBe('маша');
  });

  it('свой экран сам не закрепляем', () => {
    // Показывающий и так видит то, что показывает; закрепив, он потерял бы
    // из виду собеседников.
    const было = {peers: [собеседник('петя')], selfScreen: поток, pinned: null, seen: new Set()};

    expect(followScreens(было).pinned).toBe(null);
  });

  it('но закреплённый руками свой экран не отбираем', () => {
    const было = {peers: [], selfScreen: поток, pinned: 'self|screen', seen: new Set()};

    expect(followScreens(было).pinned).toBe('self|screen');
  });

  it('свой показ кончился — своё закрепление тоже снимаем', () => {
    const было = {peers: [], selfScreen: null, pinned: 'self|screen', seen: new Set()};

    expect(followScreens(было).pinned).toBe(null);
  });

  it('ушедший собеседник уносит и своё закрепление', () => {
    const было = {peers: [], pinned: 'петя|screen', seen: new Set(['петя|screen'])};

    expect(followScreens(было).pinned).toBe(null);
  });
});
