import {describe, expect, it} from 'vitest';
import {explainRelay} from '../src/ui/diagnostics.js';

// Три разных беды требуют трёх разных действий, и путать их нельзя:
// «не настроен» — ничего чинить не надо; «не отвечает» — чинить машину;
// «пропуск не принят» — чинить ключ в настройках.
describe('объяснение про свой ретранслятор', () => {
  it('не настроен — это не поломка', () => {
    expect(explainRelay({configured: false})).toContain('не настроен');
  });

  it('работает', () => {
    expect(explainRelay({configured: true, alive: true, accepted: true})).toContain('работает');
  });

  it('отвечает, но пропуск не принял — отправляем к ключу', () => {
    expect(explainRelay({configured: true, alive: true, accepted: false})).toContain('ключ');
  });

  it('не отвечает — отправляем к машине и брандмауэру', () => {
    const text = explainRelay({configured: true, alive: false, accepted: false});

    expect(text).toContain('не отвечает');
    expect(text).toContain('3478');
  });
});
