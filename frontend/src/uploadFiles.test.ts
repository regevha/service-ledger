import { describe, expect, it } from 'vitest';
import { chooseIntakeRoute, dropProblem } from './uploadFiles';

const pdf = (name: string) => ({ name, type: 'application/pdf' });
const img = (name: string) => ({ name, type: 'image/jpeg' });

describe('chooseIntakeRoute', () => {
  it('keeps one PDF and one or more photos as one report', () => {
    expect(chooseIntakeRoute([pdf('a.pdf')])).toEqual({ kind: 'single' });
    expect(chooseIntakeRoute([img('a.jpg')])).toEqual({ kind: 'single' });
    expect(chooseIntakeRoute([img('a.jpg'), img('b.jpg'), img('c.jpg')])).toEqual({ kind: 'single' });
  });
  it('sends two or more PDFs to the batch screen', () => {
    expect(chooseIntakeRoute([pdf('a.pdf'), pdf('b.pdf')])).toEqual({ kind: 'batch' });
    expect(chooseIntakeRoute([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')])).toEqual({ kind: 'batch' });
  });
  it('sends a mix with at least two PDFs to the batch screen', () => {
    expect(chooseIntakeRoute([pdf('a.pdf'), img('b.jpg'), pdf('c.pdf')])).toEqual({ kind: 'batch' });
  });
  it('recognises a PDF with no type by its name', () => {
    expect(chooseIntakeRoute([{ name: 'A.PDF', type: '' }, { name: 'b.pdf', type: '' }])).toEqual({ kind: 'batch' });
  });
  it('refuses one PDF mixed with photos, and says what to do', () => {
    const r = chooseIntakeRoute([pdf('a.pdf'), img('b.jpg')]);
    expect(r.kind).toBe('problem');
    if (r.kind === 'problem') expect(r.message).toContain('choose only PDFs');
  });
  it('refuses nothing and unsupported files', () => {
    expect(chooseIntakeRoute([]).kind).toBe('problem');
    expect(chooseIntakeRoute([{ name: 'notes.txt', type: 'text/plain' }]).kind).toBe('problem');
    expect(chooseIntakeRoute([pdf('a.pdf'), { name: 'notes.txt', type: 'text/plain' }]).kind).toBe('problem');
  });
  it('still reports a problem for several PDFs through dropProblem (used when no batch screen is wired)', () => {
    expect(dropProblem([pdf('a.pdf'), pdf('b.pdf')])).toContain('Drop one PDF');
  });
});
