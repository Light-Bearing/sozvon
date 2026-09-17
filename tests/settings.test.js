// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createSettings, fillPicker, renderDevices} from '../src/ui/settings.js';

const HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

const root = () => new DOMParser().parseFromString(HTML, 'text/html').querySelector('#app');

const devices = (overrides = {}) => ({
  microphones: [
    {deviceId: 'm1', label: 'Встроенный микрофон'},
    {deviceId: 'm2', label: 'Петличка'},
  ],
  cameras: [{deviceId: 'c1', label: 'FaceTime HD'}],
  speakers: [{deviceId: 's1', label: 'Наушники'}],
  named: true,
  ...overrides,
});

const nothing = {microphones: [], cameras: [], speakers: [], named: false};

describe('заполнение выпадающего списка', () => {
  let select;

  beforeEach(() => {
    select = document.createElement('select');
  });

  it('показывает названия устройств', () => {
    fillPicker(select, devices().microphones, null);

    expect([...select.options].map(o => o.textContent)).toEqual([
      'Встроенный микрофон',
      'Петличка',
    ]);
  });

  it('отмечает выбранное', () => {
    fillPicker(select, devices().microphones, 'm2');

    expect(select.value).toBe('m2');
  });

  it('исчезнувшее устройство не остаётся выбранным — берётся первое', () => {
    fillPicker(select, devices().microphones, 'уже-отключили');

    expect(select.value).toBe('m1');
  });

  it('пересборка не копит старые пункты', () => {
    fillPicker(select, devices().microphones, null);
    fillPicker(select, devices().microphones, null);

    expect(select.options).toHaveLength(2);
  });
});

describe('поля настроек', () => {
  it('поля с устройствами показаны, пустые спрятаны', () => {
    const el = root();

    renderDevices(el.querySelector('#settings'), {...devices(), cameras: []}, {}, true);

    expect(el.querySelector('#field-microphone').hidden).toBe(false);
    expect(el.querySelector('#field-camera').hidden).toBe(true);
    expect(el.querySelector('#field-speaker').hidden).toBe(false);
  });

  it('там, где браузер не умеет переключать вывод, поля звука нет', () => {
    const el = root();

    renderDevices(el.querySelector('#settings'), devices(), {}, false);

    expect(el.querySelector('#field-speaker').hidden).toBe(true);
  });

  it('без названий объясняем, почему их нет', () => {
    const el = root();

    renderDevices(el.querySelector('#settings'), {...devices(), named: false}, {}, true);

    expect(el.querySelector('#settings-note').hidden).toBe(false);
  });

  it('когда устройств нет вовсе, не объясняем ничего', () => {
    const el = root();

    renderDevices(el.querySelector('#settings'), nothing, {}, true);

    expect(el.querySelector('#settings-note').hidden).toBe(true);
  });
});

describe('панель настроек', () => {
  const open = () => {
    const el = root();
    const actions = {
      currentName: vi.fn(() => ''),
      nameHint: vi.fn(() => 'Сонная Выдра'),
      currentDevices: vi.fn(() => ({microphone: null, camera: null, speaker: null})),
      setName: vi.fn(),
      setDevice: vi.fn(),
    };
    const panel = createSettings(el, actions);
    return {el, actions, panel};
  };

  it('пока человек не назвался, поле пустое, а имя — подсказкой', async () => {
    const {el, panel} = open();

    await panel.open();

    expect(el.querySelector('#settings').hidden).toBe(false);
    expect(el.querySelector('#name-input').value).toBe('');
    expect(el.querySelector('#name-input').placeholder).toBe('Сонная Выдра');
  });

  it('названное человеком имя стоит в поле, а не в подсказке', async () => {
    const {el, actions, panel} = open();
    actions.currentName.mockReturnValue('Пётр');

    await panel.open();

    expect(el.querySelector('#name-input').value).toBe('Пётр');
  });

  it('ввод имени применяется сразу', async () => {
    const {el, actions, panel} = open();
    await panel.open();

    const input = el.querySelector('#name-input');
    input.value = 'Пётр';
    input.dispatchEvent(new Event('input'));

    expect(actions.setName).toHaveBeenCalledWith('Пётр');
  });

  it('опустошённое поле — тоже ответ: возвращаемся к подсказке', async () => {
    const {el, actions, panel} = open();
    await panel.open();

    const input = el.querySelector('#name-input');
    input.value = '   ';
    input.dispatchEvent(new Event('input'));

    expect(actions.setName).toHaveBeenCalledWith('   ');
  });

  it('выбор устройства уходит наверх с видом и адресом', async () => {
    const {el, actions, panel} = open();
    await panel.open();

    const select = el.querySelector('#pick-microphone');
    const option = document.createElement('option');
    option.value = 'm2';
    select.append(option);
    select.value = 'm2';
    select.dispatchEvent(new Event('change'));

    expect(actions.setDevice).toHaveBeenCalledWith('microphone', 'm2');
  });

  it('«Готово» и нажатие мимо карточки закрывают', async () => {
    const {el, panel} = open();
    await panel.open();

    el.querySelector('#settings-close').click();
    expect(el.querySelector('#settings').hidden).toBe(true);

    await panel.open();
    el.querySelector('#settings').click();
    expect(el.querySelector('#settings').hidden).toBe(true);
  });

  it('нажатие по самой карточке не закрывает', async () => {
    const {el, panel} = open();
    await panel.open();

    el.querySelector('.sheet-card').click();

    expect(el.querySelector('#settings').hidden).toBe(false);
  });
});

describe('свой ретранслятор в настройках', () => {
  const open = () => {
    const el = root();
    const relay = {address: '', secret: ''};
    const actions = {
      currentName: () => '',
      nameHint: () => 'Сонная Выдра',
      currentDevices: () => ({}),
      currentRelay: () => relay,
      setName: vi.fn(),
      setDevice: vi.fn(),
      setRelay: vi.fn((field, value) => (relay[field] = value)),
    };
    return {el, relay, actions, panel: createSettings(el, actions)};
  };

  it('спрятан под раскрывашкой — обычному человеку его видеть незачем', () => {
    const {el} = open();

    expect(el.querySelector('.fold').hasAttribute('open')).toBe(false);
    expect(el.querySelector('#relay-address')).not.toBe(null);
  });

  it('введённое доходит наверх и там же остаётся', async () => {
    const {el, relay, actions, panel} = open();
    await panel.open();

    const field = el.querySelector('#relay-address');
    field.value = '195.58.52.143';
    field.dispatchEvent(new Event('input'));

    expect(actions.setRelay).toHaveBeenCalledWith('address', '195.58.52.143');
    expect(relay.address).toBe('195.58.52.143');
  });

  it('ключ вводится скрытым полем', () => {
    const {el} = open();

    expect(el.querySelector('#relay-secret').type).toBe('password');
  });

  it('при открытии показывает уже настроенное', async () => {
    const {el, relay, panel} = open();
    relay.address = 'дом.example';
    relay.secret = 'тайна';

    await panel.open();

    expect(el.querySelector('#relay-address').value).toBe('дом.example');
    expect(el.querySelector('#relay-secret').value).toBe('тайна');
  });
});
