// Память между звонками: имя и выбранные устройства.
//
// localStorage бросает исключение чаще, чем кажется: приватное окно, запрет
// на данные сайтов, снимок страницы. Ни одно из этих мест не стоит звонка,
// поэтому здесь всё молча переживается, а наверх уходит null.

const PREFIX = 'созвон:';

export const recall = field => {
  try {
    return globalThis.localStorage?.getItem(PREFIX + field) ?? null;
  } catch {
    return null;
  }
};

export const remember = (field, value) => {
  try {
    if (value === null || value === undefined) globalThis.localStorage?.removeItem(PREFIX + field);
    else globalThis.localStorage?.setItem(PREFIX + field, value);
  } catch {
    // Не запомнили — не беда: в этом звонке всё и так работает.
  }
};
