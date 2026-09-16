// Панель настроек: имя и устройства.
//
// Открывается прямо из звонка, потому что менять и то и другое нужно
// посреди разговора: имя — когда собеседник не понял, кто это, устройство —
// когда воткнули наушники.

import {canChooseSpeaker, listDevices} from '../devices.js';
import {describeFlow} from '../flow.js';

// Заполняет один выпадающий список. Выбранное берём из чужого выбора, а не
// из того, что уже стоит в разметке: список пересобирается на каждом
// открытии, и после пересборки он обязан показывать правду.
export const fillPicker = (select, items, chosen) => {
  select.replaceChildren(
    ...items.map(({deviceId, label}) => {
      const option = document.createElement('option');
      option.value = deviceId;
      option.textContent = label;
      return option;
    }),
  );
  // Пустой список — выбирать не из чего; поле прячет вызывающий.
  if (!items.length) return;
  select.value = items.some(item => item.deviceId === chosen) ? chosen : items[0].deviceId;
};

// speakerSupported отдельным доводом — чтобы это можно было проверить в
// тесте, не подделывая HTMLMediaElement целиком.
export const renderDevices = (root, devices, chosen, speakerSupported = canChooseSpeaker()) => {
  const groups = [
    ['microphone', devices.microphones, chosen.microphone],
    ['camera', devices.cameras, chosen.camera],
    ['speaker', speakerSupported ? devices.speakers : [], chosen.speaker],
  ];

  for (const [kind, items, pick] of groups) {
    fillPicker(root.querySelector(`#pick-${kind}`), items, pick);
    // Поля без устройств не показываем вовсе: пустой список объясняет
    // меньше, чем его отсутствие. Вывод звука прячется и там, где браузер
    // не умеет его переключать, — Safari и Firefox.
    root.querySelector(`#field-${kind}`).hidden = items.length === 0;
  }

  // Браузер скрывает названия устройств, пока не выдано разрешение хотя бы
  // на один захват. Говорим об этом прямо, вместо «Микрофон 1» без пояснений.
  const hasAny = devices.microphones.length || devices.cameras.length;
  root.querySelector('#settings-note').hidden = devices.named || !hasAny;
};

export const createSettings = (root, actions) => {
  const panel = root.querySelector('#settings');
  const nameInput = root.querySelector('#name-input');

  const relayAddress = root.querySelector('#relay-address');
  const relaySecret = root.querySelector('#relay-secret');

  // Версия видна всегда: «исправление не помогло» и «исправление до тебя
  // не доехало» — разные беды, а на вид одинаковые.
  const versionLine = root.querySelector('#version');
  if (versionLine) versionLine.textContent = `Созвон ${actions.version ?? ''}`.trim();

  const flowLine = root.querySelector('#flow');
  let flowTimer = null;

  // Живой расход обновляем, пока панель открыта: цифра, застывшая на
  // мгновении открытия, обманет сильнее, чем её отсутствие.
  const showFlow = () => {
    const text = describeFlow(actions.currentFlow?.());
    flowLine.hidden = !text;
    flowLine.textContent = text;
  };

  const open = async () => {
    nameInput.placeholder = actions.nameHint();
    nameInput.value = actions.currentName();
    const relay = actions.currentRelay?.() ?? {};
    relayAddress.value = relay.address ?? '';
    relaySecret.value = relay.secret ?? '';
    renderDevices(panel, await listDevices(), actions.currentDevices());
    panel.hidden = false;
    showFlow();
    flowTimer = setInterval(showFlow, 2000);
    nameInput.focus();
  };

  const close = () => {
    panel.hidden = true;
    clearInterval(flowTimer);
    flowTimer = null;
  };

  // Имя применяем на каждый ввод: человек видит его на своей плитке сразу
  // и не гадает, сохранилось ли. Пустое поле — тоже ответ: «зовите как
  // придумали», и в поле останется подсказка.
  nameInput.oninput = () => actions.setName(nameInput.value);

  for (const kind of ['microphone', 'camera', 'speaker']) {
    root.querySelector(`#pick-${kind}`).onchange = event =>
      actions.setDevice(kind, event.target.value);
  }

  // Ретранслятор применяется со следующего звонка: лёд узнаёт о серверах
  // при создании соединения, и менять их у живого смысла нет.
  relayAddress.oninput = () => actions.setRelay?.('address', relayAddress.value);
  relaySecret.oninput = () => actions.setRelay?.('secret', relaySecret.value);

  root.querySelector('#settings-close').onclick = close;
  // Нажатие мимо карточки закрывает — обычное поведение таких панелей.
  panel.onclick = event => {
    if (event.target === panel) close();
  };

  return {open, close};
};
