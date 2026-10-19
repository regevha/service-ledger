/**
 * A word-level difference between two short texts, for the template
 * comparison's notes: the words only one side has are marked, the rest is
 * shown as is. Longest-common-subsequence over whitespace-separated words.
 * Past MAX_WORDS on either side the texts are shown whole (all marked) rather
 * than spending a quadratic table on a wall of text.
 */
export interface Segment {
  text: string;
  changed: boolean;
}

const MAX_WORDS = 1500;

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function join(parts: { word: string; changed: boolean }[]): Segment[] {
  const out: Segment[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.changed === p.changed) last.text += ` ${p.word}`;
    else out.push({ text: p.word, changed: p.changed });
  }
  return out;
}

export function diffWords(a: string, b: string): { left: Segment[]; right: Segment[] } {
  const x = words(a);
  const y = words(b);
  if (x.length > MAX_WORDS || y.length > MAX_WORDS) {
    return { left: join(x.map((word) => ({ word, changed: true }))), right: join(y.map((word) => ({ word, changed: true }))) };
  }
  // lcs[i][j]: length of the common subsequence of x[i..] and y[j..].
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const left: { word: string; changed: boolean }[] = [];
  const right: { word: string; changed: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      left.push({ word: x[i], changed: false });
      right.push({ word: y[j], changed: false });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      left.push({ word: x[i], changed: true });
      i += 1;
    } else {
      right.push({ word: y[j], changed: true });
      j += 1;
    }
  }
  for (; i < x.length; i += 1) left.push({ word: x[i], changed: true });
  for (; j < y.length; j += 1) right.push({ word: y[j], changed: true });
  return { left: join(left), right: join(right) };
}
