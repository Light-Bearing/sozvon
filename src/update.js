// Устаревшая сборка должна замечать это сама.
//
// Человек писал: «сброс кэша помогает». Значит, у кого-то работала старая
// версия, и все починки до него не доезжали. Самое коварное тут то, что
// со стороны это неотличимо от «починка не помогла»: человек уверен, что
// обновился, и проверяет исправления, которых у него нет.
//
// Поэтому сборка кладёт рядом с собой version.json (см. vite.config.js), а
// приложение сверяется с ним. Разошлось — показываем это прямо и даём
// обновиться одним нажатием. Нажатие делает то же, что человек делал
// руками: снимает воркер, стирает его кэш и загружает страницу заново.

export const checkForUpdate = async ({current, base = './', fetchImpl = globalThis.fetch} = {}) => {
  if (!current || typeof fetchImpl !== 'function') return null;
  try {
    // И отметка в адресе, и no-store: ни кэш браузера, ни посредник по
    // дороге не должны отдать вчерашний ответ.
    const response = await fetchImpl(`${base}version.json?_=${Date.now()}`, {cache: 'no-store'});
    if (!response?.ok) return null;
    const {version} = await response.json();
    return typeof version === 'string' && version && version !== current ? version : null;
  } catch {
    // Нет сети или ответ испорчен — молчим: это не повод пугать человека.
    return null;
  }
};

export const refreshHard = async ({
  sw = globalThis.navigator?.serviceWorker,
  cacheStorage = globalThis.caches,
  reload = () => globalThis.location.reload(),
} = {}) => {
  try {
    for (const registration of (await sw?.getRegistrations?.()) ?? []) {
      await registration.unregister();
    }
  } catch {
    // Не дали снять воркер — всё равно перезагрузимся: страница у нас
    // и так просится в обход кэша (см. public/sw.js).
  }
  try {
    for (const key of (await cacheStorage?.keys?.()) ?? []) await cacheStorage.delete(key);
  } catch {
    // То же: кэш не стёрся — перезагрузка всё равно полезна.
  }
  reload();
};
