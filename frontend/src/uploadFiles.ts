// What the upload accepts: the same list the file picker is limited to. The server
// still checks the file's own bytes; this only gives an instant answer to a drop.
export const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ACCEPTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp'];

function isAcceptedFile(f: { name: string; type: string }): boolean {
  if (ACCEPTED_TYPES.includes(f.type)) return true;
  // Some systems give a dropped file no type at all; fall back to its name.
  return !f.type && ACCEPTED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext));
}

/** The text shown when a drop is refused, or null when the files are fine to use.
 *  One PDF, or one or more images (several photos become one PDF); never a mix. */
export function dropProblem(files: { name: string; type: string }[]): string | null {
  if (files.length === 0) return 'Nothing was dropped. Drop a PDF or an image file.';
  const bad = files.find((f) => !isAcceptedFile(f));
  if (bad) return `\u201c${bad.name}\u201d is not a PDF or an image (PNG, JPEG, GIF or WebP).`;
  if (files.length > 1 && files.some(isPdfFile)) return 'Drop one PDF, or photos of the pages — not both. To upload several reports, choose only PDFs.';
  return null;
}

export function isPdfFile(f: { name: string; type: string }): boolean {
  return f.type === 'application/pdf' || (!f.type && f.name.toLowerCase().endsWith('.pdf'));
}

export type IntakeChoice =
  | { kind: 'single' } // one PDF, or one or more photos: the usual one-report flow
  | { kind: 'batch' } // two or more PDFs: each becomes its own report on the batch screen
  | { kind: 'problem'; message: string };

/** Where chosen or dropped files on the New report screen go. Two or more PDFs (with or
 *  without images) go to the batch screen, which checks the file types and the size of the batch. */
export function chooseIntakeRoute(files: { name: string; type: string }[]): IntakeChoice {
  if (files.filter(isPdfFile).length >= 2) return { kind: 'batch' };
  const message = dropProblem(files);
  return message ? { kind: 'problem', message } : { kind: 'single' };
}
