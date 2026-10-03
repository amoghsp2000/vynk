/**
 * Detects the real file type from magic bytes. Client-declared MIME types and
 * extensions are never trusted on their own.
 */
export function sniffMime(buf: Buffer): string | null {
  const at = (offset: number, ...bytes: number[]) => bytes.every((b, i) => buf[offset + i] === b);
  const ascii = (offset: number, s: string) => buf.subarray(offset, offset + s.length).toString('latin1') === s;

  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm'; // EBML (webm/mkv)
  if (ascii(4, 'ftyp')) {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'qt  ') return 'video/quicktime';
    if (/^(heic|heix|mif1|msf1)$/.test(brand)) return 'image/heic';
    return 'video/mp4';
  }
  return null;
}
