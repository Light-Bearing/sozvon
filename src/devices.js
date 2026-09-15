// Список устройств для настроек.
//
// Названия браузер отдаёт пустыми, пока не выдано разрешение хотя бы на
// один захват, — это не ошибка и не повод выдумывать подписи. Поэтому
// наружу уходит ещё и named: настройки честно скажут, почему в списке
// «Микрофон 1» вместо имени, вместо того чтобы делать вид, что так и надо.

const GROUPS = [
  ['microphones', 'audioinput', 'Микрофон'],
  ['cameras', 'videoinput', 'Камера'],
  ['speakers', 'audiooutput', 'Динамик'],
];

export const EMPTY = {microphones: [], cameras: [], speakers: [], named: false};

export const listDevices = async (mediaDevices = globalThis.navigator?.mediaDevices) => {
  if (!mediaDevices?.enumerateDevices) return EMPTY;

  let all;
  try {
    all = await mediaDevices.enumerateDevices();
  } catch {
    // Браузер вправе отказать — например, в небезопасном происхождении.
    return EMPTY;
  }

  const result = {named: all.some(({label}) => label)};
  for (const [key, kind, word] of GROUPS) {
    result[key] = all
      .filter(device => device.kind === kind)
      .map((device, i) => ({
        deviceId: device.deviceId,
        label: device.label || `${word} ${i + 1}`,
      }));
  }
  return result;
};

// Вывод звука переключается не у потока, а у самого проигрывателя, и
// только там, где браузер это умеет: setSinkId есть в Chrome и Edge, в
// Safari и Firefox его нет. Отсутствие — не ошибка: звук просто идёт
// туда, куда его отправляет система.
export const canChooseSpeaker = () =>
  typeof globalThis.HTMLMediaElement !== 'undefined' &&
  'setSinkId' in globalThis.HTMLMediaElement.prototype;

export const playThrough = async (element, deviceId) => {
  if (!deviceId || typeof element?.setSinkId !== 'function') return false;
  try {
    await element.setSinkId(deviceId);
    return true;
  } catch {
    // Устройство могли отключить между выбором и применением.
    return false;
  }
};
