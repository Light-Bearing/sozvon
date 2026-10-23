// Код безопасности: сверить вслух, что между вами никто не встрял.
//
// Звук и картинка шифруются между браузерами ключами, отпечатки которых
// стороны передают друг другу при рукопожатии. Кто сумеет вклиниться в
// рукопожатие, подсунет свой отпечаток — и будет слушать, пересылая дальше.
// Тогда у двоих отпечатки «собеседника» окажутся разными. Код — короткая
// выжимка из обоих отпечатков: совпал у обоих — между вами никого.
//
// 16 цифр, четыре группы. Короче — и вклинившийся успевал бы перебрать
// свои сертификаты, пока короткий код случайно не совпадёт; 16 цифр делают
// такой перебор долгим и дорогим, а продиктовать их всё ещё можно.

export const fingerprintOf = sdp =>
  /^a=fingerprint:sha-256 ([0-9A-F:]+)\s*$/im.exec(sdp ?? '')?.[1]?.toUpperCase() ?? null;

export const safetyCode = async (mine, theirs) => {
  if (!mine || !theirs) return null;
  // Порядок не важен: у обоих код должен выйти одинаковым.
  const text = [mine, theirs].sort().join('|');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const digits = [];
  for (let i = 0; digits.length < 16; i++) digits.push(String(digest[i] % 10));
  return [0, 4, 8, 12].map(i => digits.slice(i, i + 4).join('')).join(' ');
};

export const codeFor = pc =>
  safetyCode(fingerprintOf(pc?.localDescription?.sdp), fingerprintOf(pc?.remoteDescription?.sdp));
