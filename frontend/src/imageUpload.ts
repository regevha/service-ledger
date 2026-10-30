// Getting photos ready to upload: a phone photo is often 5-10 MB and 4000+ px,
// far more than reading a printed form needs. Each image is scaled down in the
// browser to MAX_SIDE px on its long side and re-encoded as JPEG; several images
// become one PDF (one page per image, in the order chosen) so a multi-page form
// is still one report with one attachment.

export const MAX_SIDE = 2000;
const JPEG_QUALITY = 0.85;

/** Size after scaling so the long side is at most `max`; never scales up. */
export function scaledSize(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const longSide = Math.max(width, height);
  if (longSide <= max) return { width, height };
  const k = max / longSide;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export type Jpeg = { bytes: Uint8Array; width: number; height: number };

async function toJpeg(file: File): Promise<Jpeg> {
  // imageOrientation 'from-image' applies the EXIF rotation phones record.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { width, height } = scaledSize(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize images.');
  ctx.fillStyle = '#fff'; // PNG transparency would turn black in a JPEG
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('This browser cannot resize images.');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

const ascii = (s: string) => new TextEncoder().encode(s);

/** A PDF with one page per JPEG, each page the image's own pixel size. */
export function jpegsToPdf(images: Jpeg[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Uint8Array) => {
    parts.push(chunk);
    length += chunk.length;
  };
  const object = (n: number, body: Uint8Array[]) => {
    offsets[n] = length;
    push(ascii(`${n} 0 obj\n`));
    body.forEach(push);
    push(ascii('\nendobj\n'));
  };

  // Objects: 1 catalog, 2 pages, then per image: page, content, image.
  push(ascii('%PDF-1.4\n'));
  object(1, [ascii('<< /Type /Catalog /Pages 2 0 R >>')]);
  const pageIds = images.map((_, i) => 3 + i * 3);
  object(2, [ascii(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${images.length} >>`)]);
  images.forEach((img, i) => {
    const page = 3 + i * 3;
    const content = ascii(`q ${img.width} 0 0 ${img.height} 0 0 cm /Im0 Do Q`);
    object(page, [
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${img.width} ${img.height}] ` +
          `/Resources << /XObject << /Im0 ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`,
      ),
    ]);
    object(page + 1, [ascii(`<< /Length ${content.length} >>\nstream\n`), content, ascii('\nendstream')]);
    object(page + 2, [
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
      ),
      img.bytes,
      ascii('\nendstream'),
    ]);
  });

  const count = 3 + images.length * 3;
  const xrefAt = length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(ascii(`${xref}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of parts) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const baseName = (name: string) => name.replace(/\.[^.]+$/, '') || 'photo';

/**
 * The one file to upload for what the technician chose: a PDF goes up as it is;
 * one image goes up shrunk (JPEG); several images go up as one PDF. GIFs are
 * left alone (they may be animated and are rare for scans).
 */
export async function prepareUpload(files: File[]): Promise<File> {
  if (files.length === 1 && (files[0].type === 'application/pdf' || files[0].type === 'image/gif')) return files[0];
  const images = await Promise.all(files.map(toJpeg));
  if (images.length === 1) {
    return new File([images[0].bytes as BlobPart], `${baseName(files[0].name)}.jpg`, { type: 'image/jpeg' });
  }
  return new File([jpegsToPdf(images) as BlobPart], `${baseName(files[0].name)}-and-${images.length - 1}-more.pdf`, {
    type: 'application/pdf',
  });
}
