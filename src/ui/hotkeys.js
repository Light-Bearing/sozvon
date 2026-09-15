// Пробел — быстрый выключатель микрофона.
//
// Не «нажал и говоришь»: захват по требованию освобождает устройство при
// выключении, и удержание дёргало бы getUserMedia на каждое нажатие — с
// задержкой на первом слове и морганием индикатора на устройстве. Пробел
// поэтому переключает, а не удерживает.

const TYPING = ['input', 'textarea', 'select'];

// Пробел — родная клавиша браузера для нажатия кнопки или ввода текста.
// Там, где он уже что-то значит, перехватывать его нельзя: иначе пробел
// на кнопке микрофона переключил бы микрофон дважды и не сделал ничего.
const busyElsewhere = element => {
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName?.toLowerCase();
  return tag === 'button' || tag === 'a' || TYPING.includes(tag);
};

export const bindHotkeys = (target, {isReady, toggleMicrophone}) => {
  const onKeyDown = event => {
    if (event.code !== 'Space' && event.key !== ' ') return;
    // Удержание шлёт keydown раз за разом — переключаем только на первое.
    if (event.repeat) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (busyElsewhere(event.target) || busyElsewhere(target.activeElement)) return;
    if (!isReady()) return;

    // Без этого страница ещё и прокрутится.
    event.preventDefault();
    toggleMicrophone();
  };

  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
};
