export const SCREENS = ['start', 'join', 'call', 'failed'];

export const showScreen = (root, name) => {
  if (!SCREENS.includes(name)) throw new Error(`Нет такого экрана: ${name}`);
  for (const screen of SCREENS) {
    const el = root.querySelector(`#screen-${screen}`);
    if (el) el.hidden = screen !== name;
  }
};

// Человеку на экране не нужны названия ошибок — нужно понять,
// что случилось и что делать дальше.
export const explainFailure = error => {
  switch (error?.name) {
    case 'NotAllowedError':
      return {
        title: 'Браузер не пустил к камере и микрофону',
        advice:
          'Нажмите на значок замка слева от адреса и разрешите камеру и микрофон, ' +
          'потом обновите страницу.',
      };
    case 'NotFoundError':
      return {
        title: 'Камера или микрофон не найдены',
        advice:
          'Проверьте, подключены ли они, и не занял ли их другой звонок или программа.',
      };
    case 'NotReadableError':
      return {
        title: 'Камеру занял кто-то другой',
        advice: 'Закройте другие программы, которые могут её использовать, и попробуйте снова.',
      };
    default:
      return {
        title: 'Связь не установилась',
        advice:
          'Чаще всего помогает раздать интернет с телефона и попробовать снова. ' +
          'Если не поможет — загляните в диагностику, там видно, что именно не работает.',
      };
  }
};
