// What the upload accepts: the same list the file picker is limited to. The server
// still checks the file's own bytes; this only gives an instant answer to a drop.
export const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ACCEPTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp'];

function isAcceptedFile(f: { name: string; type: string }): boolean {
  if (ACCEPTED_TYPES.includes(f.type)) return true;
  // Some systems give a dropped file no type at all; fall back to its name.
  return !f.type && ACCEPTED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext));
}

/** The text shown when a drop is refused, or null when the files are fine to use. */
export function dropProblem(files: { name: string; type: string }[]): string | null {
  if (files.length === 0) return 'Nothing was dropped. Drop a PDF or an image file.';
  if (files.length > 1) return 'Drop one file at a time: one file per report.';
  if (!isAcceptedFile(files[0])) return `\u201c${files[0].name}\u201d is not a PDF or an image (PNG, JPEG, GIF or WebP).`;
  return null;
}
