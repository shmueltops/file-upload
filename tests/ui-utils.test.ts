import { it, expect } from 'vitest';
import { timeRemaining } from '../apps/web/src/lib/api';
it('formats remaining time with natural units and plurals', () => {
  expect(timeRemaining(1)).toBe('1 second left');
  expect(timeRemaining(59)).toBe('59 seconds left');
  expect(timeRemaining(60)).toBe('1 minute left');
  expect(timeRemaining(1060)).toBe('17 minutes 40 seconds left');
  expect(timeRemaining(3900)).toBe('1 hour 5 minutes left');
  expect(timeRemaining(7200)).toBe('2 hours left');
});
