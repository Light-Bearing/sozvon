// Лестница качества. Ступень зависит от того, сколько людей в звонке
// и как себя чувствует связь. Ручек у человека нет — только «закрепить».

export const STEPS = [
  {name: 'full',    maxPeers: 2,        width: 1280, height: 720, maxBitrate: 2_500_000, videoFor: 'all'},
  {name: 'small',   maxPeers: 4,        width: 640,  height: 360, maxBitrate: 800_000,   videoFor: 'all'},
  {name: 'speaker', maxPeers: 8,        width: 640,  height: 360, maxBitrate: 800_000,   videoFor: 'speaker'},
  {name: 'voice',   maxPeers: Infinity, width: 0,    height: 0,   maxBitrate: 0,         videoFor: 'none'},
];

// Пороги взяты как разумная отправная точка и уточняются на живых звонках.
// Асимметрия намеренная: спускаемся быстро, поднимаемся неохотно — иначе мигает.
export const HEALTH = {
  lossThreshold: 0.05,
  queueSecondsThreshold: 1,
  badForMs: 5_000,
  goodForMs: 30_000,
};

export const stepForPeers = count => STEPS.find(step => count <= step.maxPeers) ?? STEPS.at(-1);

export const createLadder = ({now = () => Date.now(), health = HEALTH} = {}) => {
  let penalty = 0;
  let badSince = null;
  let goodSince = null;
  let latest = STEPS[0];

  const update = ({peerCount, loss = 0, queueSeconds = 0}) => {
    const t = now();
    const unhealthy =
      loss > health.lossThreshold || queueSeconds > health.queueSecondsThreshold;

    if (unhealthy) {
      goodSince = null;
      badSince ??= t;
      if (t - badSince >= health.badForMs) {
        // Потолок — на самом счётчике, а не только на итоговой ступени.
        // Итог и так не опускался ниже STEPS.length - 1, но без этой строки
        // penalty рос и дальше вхолостую при долгой просадке: тридцать минут
        // плохой связи давали ту же нижнюю ступень, что и одна минута, но
        // «долг» в penalty оказывался в разы больше — и подъём обратно
        // (только по одной ступени за health.goodForMs) занимал не полторы
        // минуты, а те же в разы больше. Пять минут неурядиц превращались
        // почти в получаса тишины без объяснений.
        penalty = Math.min(penalty + 1, STEPS.length - 1);
        badSince = null;
      }
    } else {
      badSince = null;
      goodSince ??= t;
      if (penalty > 0 && t - goodSince >= health.goodForMs) {
        penalty -= 1;
        goodSince = null;
      }
    }

    const base = STEPS.indexOf(stepForPeers(peerCount));
    latest = STEPS[Math.min(base + penalty, STEPS.length - 1)];
    return latest;
  };

  return {update, current: () => latest};
};
