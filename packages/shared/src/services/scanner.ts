export type Verdict = { result: 'clean' | 'infected'; reason: string | null; provider: string };
export async function scanFile(
  filename: string,
  random: () => number = Math.random,
): Promise<Verdict> {
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
