const UNITS: Array<[label: string, ms: number]> = [
  ['d', 24 * 60 * 60 * 1000],
  ['h', 60 * 60 * 1000],
  ['m', 60 * 1000],
];

export function timeAgo(date: Date | string, now: Date = new Date()): string {
  const elapsed = now.getTime() - new Date(date).getTime();
  if (elapsed < 60 * 1000) return 'just now';
  for (const [label, ms] of UNITS) {
    if (elapsed >= ms) return `${Math.floor(elapsed / ms)}${label} ago`;
  }
  return 'just now';
}
