// Floor-plan pictures (Settings → ผังโรงพยาบาล → a floor's background): what kind of image some bytes are and how big,
// read from the file's own header — PNG, JPEG and WebP only (no SVG: it can carry script).
export const IMAGE_MAX_BYTES = 2_500_000, IMAGE_MAX_SIDE = 8000;
export type ImageInfo = { mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number };

export function imageInfo(b: Uint8Array): ImageInfo | null {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1], u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8), u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const ok = (info: ImageInfo) => (info.width >= 1 && info.height >= 1 && info.width <= IMAGE_MAX_SIDE && info.height <= IMAGE_MAX_SIDE ? info : null);
  if (b.length < 32) return null;
  // PNG: signature, then the IHDR chunk with width and height.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52)
    return ok({ mime: 'image/png', width: u32be(16), height: u32be(20) });
  // JPEG: walk the segments to the first start-of-frame.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok({ mime: 'image/jpeg', width: u16be(i + 7), height: u16be(i + 5) });
      i += 2 + u16be(i + 2);
    }
    return null;
  }
  // WebP: RIFF....WEBP, then a lossy (VP8), lossless (VP8L) or extended (VP8X) chunk.
  if (String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') {
    const kind = String.fromCharCode(...b.subarray(12, 16));
    if (kind === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return ok({ mime: 'image/webp', width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff });
    if (kind === 'VP8L' && b[20] === 0x2f) { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return ok({ mime: 'image/webp', width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }); }
    if (kind === 'VP8X') return ok({ mime: 'image/webp', width: u24le(24) + 1, height: u24le(27) + 1 });
  }
  return null;
}
