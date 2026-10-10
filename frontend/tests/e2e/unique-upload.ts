import { readFileSync } from 'node:fs';
import path from 'node:path';

// An upload whose bytes differ every call. The backend refuses the exact same
// file when a report holding it has already been read (409 "already on file"),
// so specs that read a file and later load "the same" fixture again must not
// share bytes. A trailing PDF comment keeps the file's text layer unchanged.
export function uniquePdf(contents: Buffer | string): Buffer {
  return Buffer.concat([Buffer.from(contents), Buffer.from(`\n% unique ${Date.now()}-${Math.random()}\n`)]);
}

export function uniqueFixture(fixturePath: string) {
  return { name: path.basename(fixturePath), mimeType: 'application/pdf', buffer: uniquePdf(readFileSync(fixturePath)) };
}
