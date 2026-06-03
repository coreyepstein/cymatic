/**
 * Minimal dependency-free PNG decoder for e2e pixel assertions. Playwright's
 * `locator.screenshot()` returns a PNG buffer; these specs decode it to raw RGBA
 * so they can measure real compositor pixels without a native image lib.
 *
 * Supports 8-bit RGB (colorType 2) and RGBA (colorType 6) with all five PNG
 * scanline filters — the only shapes Chromium's screenshots produce here. Not a
 * test file (no `.spec`/`.test` suffix), so Playwright ignores it for discovery.
 */
import zlib from "node:zlib";

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function readU32(buf: Buffer, off: number): number {
  return ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(png: Buffer): DecodedImage {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i++) {
    if (png[i] !== sig[i]) throw new Error("not a PNG");
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  let off = 8;
  while (off < png.length) {
    const len = readU32(png, off);
    const type = png.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    if (type === "IHDR") {
      width = readU32(png, dataStart);
      height = readU32(png, dataStart + 4);
      bitDepth = png[dataStart + 8]!;
      colorType = png[dataStart + 9]!;
    } else if (type === "IDAT") {
      idat.push(png.subarray(dataStart, dataStart + len));
    } else if (type === "IEND") {
      break;
    }
    off = dataStart + len + 4;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * channels);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!;
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos++]!;
      const a = x >= channels ? out[rowStart + x - channels]! : 0;
      const b = y > 0 ? out[prevRowStart + x]! : 0;
      const c = x >= channels && y > 0 ? out[prevRowStart + x - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      out[rowStart + x] = value & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < out.length; i += channels, j += 4) {
    rgba[j] = out[i]!;
    rgba[j + 1] = out[i + 1]!;
    rgba[j + 2] = out[i + 2]!;
    rgba[j + 3] = channels === 4 ? out[i + 3]! : 255;
  }
  return { width, height, rgba };
}

/** Rec. 709-ish luminance of an 8-bit RGB triple. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.114 * b;
}

/** The RGBA of the pixel at (x, y), clamped to image bounds. */
export function pixelAt(
  img: DecodedImage,
  x: number,
  y: number,
): { r: number; g: number; b: number; a: number } {
  const cx = Math.min(Math.max(Math.round(x), 0), img.width - 1);
  const cy = Math.min(Math.max(Math.round(y), 0), img.height - 1);
  const i = (cy * img.width + cx) * 4;
  return { r: img.rgba[i]!, g: img.rgba[i + 1]!, b: img.rgba[i + 2]!, a: img.rgba[i + 3]! };
}
