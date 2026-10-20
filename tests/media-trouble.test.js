import {describe, expect, it} from 'vitest';
import {explainMediaFailure} from '../src/media-trouble.js';

const ошибка = (name, message = '') => Object.assign(new Error(message), {name});

describe('почему не включилось — словами', () => {
  it('Мак запретил браузеру камеру — ведём в системные настройки', () => {
    const текст = explainMediaFailure('camera', ошибка('NotAllowedError', 'Permission denied by system'), {mac: true});

    expect(текст).toMatch(/Мак не даёт браузеру камеру/);
    expect(текст).toMatch(/Конфиденциальность и безопасность → Камера/);
  });

  it('Мак запретил запись экрана — ведём туда, где её разрешают', () => {
    const текст = explainMediaFailure('screen', ошибка('NotAllowedError', 'Permission denied by system'), {mac: true});

    expect(текст).toMatch(/Запись экрана и системного звука/);
  });

  it('сайту запрещено — значок у адреса, а на Маке ещё и система', () => {
    const текст = explainMediaFailure('microphone', ошибка('NotAllowedError', 'Permission denied'), {mac: true});

    expect(текст).toMatch(/значком слева от адреса/);
    expect(текст).toMatch(/→ Микрофон/);
    expect(explainMediaFailure('microphone', ошибка('NotAllowedError'), {mac: false})).not.toMatch(/Системные/);
  });

  it('окно выбора экрана закрыли сами — молчим, это не поломка', () => {
    expect(explainMediaFailure('screen', ошибка('NotAllowedError', 'Permission denied'), {mac: true})).toBe(null);
  });

  it('камеру держит другая программа', () => {
    expect(explainMediaFailure('camera', ошибка('NotReadableError'), {mac: true})).toMatch(/Камеру занял кто-то другой/);
  });

  it('камеры нет', () => {
    expect(explainMediaFailure('camera', ошибка('NotFoundError'))).toMatch(/Камера не найдена/);
  });

  it('незнакомая беда — хотя бы что именно не включилось', () => {
    expect(explainMediaFailure('camera', ошибка('WeirdError'))).toBe('Не получилось включить камеру (WeirdError)');
  });
});
