import {describe, expect, it, vi} from 'vitest';
import {EMPTY, listDevices, playThrough} from '../src/devices.js';

const fakeDevices = list => ({enumerateDevices: vi.fn().mockResolvedValue(list)});

describe('список устройств', () => {
  it('разложен по трём видам', async () => {
    const devices = await listDevices(
      fakeDevices([
        {kind: 'audioinput', deviceId: 'm1', label: 'Встроенный микрофон'},
        {kind: 'videoinput', deviceId: 'c1', label: 'FaceTime HD'},
        {kind: 'audiooutput', deviceId: 's1', label: 'Наушники'},
        {kind: 'audioinput', deviceId: 'm2', label: 'Петличка'},
      ]),
    );

    expect(devices.microphones).toEqual([
      {deviceId: 'm1', label: 'Встроенный микрофон'},
      {deviceId: 'm2', label: 'Петличка'},
    ]);
    expect(devices.cameras).toHaveLength(1);
    expect(devices.speakers).toHaveLength(1);
    expect(devices.named).toBe(true);
  });

  it('без разрешения названий нет — подписываем по порядку и говорим об этом', async () => {
    const devices = await listDevices(
      fakeDevices([
        {kind: 'audioinput', deviceId: 'm1', label: ''},
        {kind: 'audioinput', deviceId: 'm2', label: ''},
      ]),
    );

    expect(devices.microphones.map(d => d.label)).toEqual(['Микрофон 1', 'Микрофон 2']);
    expect(devices.named).toBe(false);
  });

  it('без поддержки в браузере — пустой список, а не падение', async () => {
    expect(await listDevices(undefined)).toEqual(EMPTY);
    expect(await listDevices({})).toEqual(EMPTY);
  });

  it('отказ браузера не роняет настройки', async () => {
    const mediaDevices = {enumerateDevices: vi.fn().mockRejectedValue(new Error('нельзя'))};

    expect(await listDevices(mediaDevices)).toEqual(EMPTY);
  });
});

describe('вывод звука', () => {
  it('переключается там, где браузер это умеет', async () => {
    const element = {setSinkId: vi.fn().mockResolvedValue(undefined)};

    expect(await playThrough(element, 's1')).toBe(true);
    expect(element.setSinkId).toHaveBeenCalledWith('s1');
  });

  it('там, где не умеет, молча остаётся как было', async () => {
    expect(await playThrough({}, 's1')).toBe(false);
    expect(await playThrough(null, 's1')).toBe(false);
  });

  it('пустой выбор ничего не трогает', async () => {
    const element = {setSinkId: vi.fn()};

    expect(await playThrough(element, null)).toBe(false);
    expect(element.setSinkId).not.toHaveBeenCalled();
  });

  it('отключённое между выбором и применением устройство не роняет звонок', async () => {
    const element = {setSinkId: vi.fn().mockRejectedValue(new Error('нет такого'))};

    expect(await playThrough(element, 's1')).toBe(false);
  });
});
