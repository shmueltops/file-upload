import { MAX_FILE_SIZE } from '../contracts';

export type Verdict = { result: 'clean' | 'infected'; reason: string | null; provider: string };
export function scanDurationMs(size: number) {
  const fraction = Math.max(0, Math.min(1, (size - 1000) / (MAX_FILE_SIZE - 1000)));
  return Math.round(10_000 + fraction * 20_000);
}
export async function scanFile(
  filename: string,
  size: number,
  random: () => number = Math.random,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<Verdict> {
  // Simulate scanner latency without reading file bytes or blocking the Worker CPU.
  await wait(scanDurationMs(size));
  const name = filename.toLowerCase();
  const reason = name.includes('virus')
    ? 'virus in name'
    : name.includes('communism')
      ? 'communism in name'
      : random() < 0.1
        ? 'virus found'
        : null;
  return { result: reason ? 'infected' : 'clean', reason, provider: 'fake-scanner-v1' };
}
