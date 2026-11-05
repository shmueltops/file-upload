import { describe, it, expect, vi } from 'vitest';
import {
  nameKey,
  validateName,
  validatePath,
  validateFilePath,
} from '../packages/shared/src/paths';
import { scanFile, scanDurationMs } from '../packages/shared/src/services/scanner';
import { hashPassword, checkPassword } from '../packages/shared/src/services/users';
describe('portable paths', () => {
  it.each([
    'CON',
    'con.txt',
    'LPT9.pdf',
    'com¹.log',
    '..',
    '.',
    '',
    'trailing.',
    'trailing ',
    'a/b',
    'a\\b',
    'a:b',
    'a\u0000b',
  ])('rejects %j', (name) => expect(() => validateName(name)).toThrow());
  it.each(['/absolute', 'a//b', 'a/', '../root', 'a/./b', 'C:/drive', '\\server\\share'])(
    'rejects invalid path %j',
    (path) => expect(() => validatePath(path)).toThrow(),
  );
  it('normalizes Unicode and folds without locale dependence', () => {
    expect(validatePath('Cafe\u0301/Photos')).toBe('Café/Photos');
    expect(nameKey('Straße')).toBe(nameKey('STRASSE'));
    expect(nameKey('Café')).toBe(nameKey('CAFE\u0301'));
    expect(validatePath('')).toBe('');
  });
  it('bounds component and total path lengths', () => {
    expect(() => validateName('é'.repeat(128))).toThrow();
    expect(() => validatePath(Array(33).fill('x').join('/'))).toThrow();
    expect(() =>
      validateFilePath(Array(4).fill('x'.repeat(250)).join('/'), 'y'.repeat(30)),
    ).toThrow();
  });
});
describe('simulated scanner', () => {
  const noDelay = async () => {};
  it('scales scan time linearly from 10 seconds at 1 KB to 30 seconds at 3 GB', () => {
    expect(scanDurationMs(0)).toBe(10_000);
    expect(scanDurationMs(1000)).toBe(10_000);
    expect(scanDurationMs(1_500_000_500)).toBe(20_000);
    expect(scanDurationMs(3_000_000_000)).toBe(30_000);
    expect(scanDurationMs(4_000_000_000)).toBe(30_000);
  });
  it('keeps the verdict pending until the simulated scan finishes', async () => {
    vi.useFakeTimers();
    try {
      const random = vi.fn(() => 1);
      const result = scanFile('report.txt', 1000, random);
      await vi.advanceTimersByTimeAsync(9999);
      expect(random).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect((await result).result).toBe('clean');
      expect(random).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('prioritizes deterministic case-insensitive reasons', async () => {
    expect(await scanFile('VIRUS-COMMUNISM.txt', 1000, () => 1, noDelay)).toMatchObject({
      result: 'infected',
      reason: 'virus in name',
    });
    expect(await scanFile('Communism.txt', 1000, () => 1, noDelay)).toMatchObject({
      result: 'infected',
      reason: 'communism in name',
    });
  });
  it('samples the ten percent branch once', async () => {
    expect((await scanFile('report.txt', 1000, () => 0.099, noDelay)).reason).toBe('virus found');
    expect((await scanFile('report.txt', 1000, () => 0.1, noDelay)).result).toBe('clean');
  });
});
describe('password hashing', () => {
  it('salts hashes and verifies without plaintext storage', async () => {
    const password = crypto.randomUUID();
    const a = await hashPassword(password),
      b = await hashPassword(password);
    expect(a).not.toBe(b);
    expect(a).not.toContain(password);
    expect(await checkPassword(password, a)).toBe(true);
    expect(await checkPassword('wrong password', a)).toBe(false);
  });
});
