// Почему не включилась камера, микрофон или показ экрана — словами.
//
// Раньше отказ браузера проглатывался: кнопка молча возвращалась в
// «выключено», и человек не понимал, сломалось ли что-то у него или у нас.
// На Маке так бывает чаще всего: кроме разрешения сайту, браузеру нужно
// ещё разрешение самой системы — на камеру, микрофон и отдельно на запись
// экрана. Без него браузер отказывает, даже если сайту всё разрешено.

const WHAT = {
  camera: {name: 'камеру', mac: 'Камера'},
  microphone: {name: 'микрофон', mac: 'Микрофон'},
  screen: {name: 'показ экрана', mac: 'Запись экрана и системного звука'},
};

const macPath = kind =>
  `Системные настройки → Конфиденциальность и безопасность → ${WHAT[kind].mac}: включите там браузер и перезапустите его`;

export const isMac = () =>
  /Mac/i.test(globalThis.navigator?.platform ?? '') || /Macintosh/i.test(globalThis.navigator?.userAgent ?? '');

// null — говорить нечего: например, человек сам закрыл окно выбора экрана.
export const explainMediaFailure = (kind, error, {mac = isMac()} = {}) => {
  const what = WHAT[kind];
  if (!what) return null;
  const name = error?.name ?? '';
  const message = String(error?.message ?? '');
  // «by system» — отказал не сайту, а браузеру: запрет стоит в системе.
  const bySystem = /system/i.test(message);

  if (name === 'NotAllowedError') {
    if (bySystem) return mac ? `Мак не даёт браузеру ${what.name}. ${macPath(kind)}` : `Система не даёт браузеру ${what.name} — разрешите его в настройках системы`;
    // Окно выбора экрана закрыли сами — это не поломка.
    if (kind === 'screen') return null;
    const site = `Браузер не дал ${what.name} — разрешите значком слева от адреса`;
    return mac ? `${site}. Если там всё разрешено — ${macPath(kind)}` : site;
  }
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
    return kind === 'screen'
      ? 'Показать экран не вышло — попробуйте ещё раз'
      : `${what.name[0].toUpperCase()}${what.name.slice(1)} занял кто-то другой — закройте FaceTime, Zoom или другую вкладку со звонком`;
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return kind === 'camera' ? 'Камера не найдена — проверьте, подключена ли она' : kind === 'microphone' ? 'Микрофон не найден — проверьте, подключён ли он' : null;
  }
  if (name === 'NotSupportedError' || name === 'TypeError') {
    return kind === 'screen' ? 'Этот браузер не умеет показывать экран' : `Этот браузер не даёт ${what.name} — откройте разговор в Chrome, Safari или Firefox`;
  }
  return `Не получилось включить ${what.name}${name ? ` (${name})` : ''}`;
};
