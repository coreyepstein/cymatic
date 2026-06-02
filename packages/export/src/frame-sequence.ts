/**
 * PNG frame-sequence fallback for @cymatic/export.
 *
 * When WebCodecs is unavailable (Node, or a browser without `VideoEncoder`),
 * the export pipeline falls back to emitting one PNG per frame. The frames are
 * silent images; the original audio is muxed back on with ffmpeg afterwards
 * (see `AUDIO-MUX.md`).
 *
 * This module is dependency-light on purpose: rather than pull in a PNG codec,
 * it encodes a valid PNG from RGBA8 by hand. The pixel data is wrapped in
 * zlib's *stored* (uncompressed) block format, so no DEFLATE compressor is
 * needed — the bytes are emitted verbatim with the correct zlib header and
 * Adler-32 checksum, and every chunk carries its CRC-32. The result is a real,
 * spec-valid PNG that any decoder (and ffmpeg) reads. Encoding is fully
 * deterministic: identical RGBA in → byte-identical PNG out.
 *
 * Output goes through an injectable {@link FrameSequenceTarget} sink so the same
 * emitter writes to disk in Node, to an in-memory array in tests, or hands
 * `Blob`s back in the browser.
 */

import type { CapturedFrame, FrameSink } from "./render-offline.js";

/** Receives each encoded PNG. The driver/emitter is blind to where it lands. */
export interface FrameSequenceTarget {
  /**
   * Persist the PNG for frame `index`. `filename` is a zero-padded, sortable
   * name like `frame-00012.png`. `png` is the complete PNG byte stream.
   */
  write(index: number, filename: string, png: Uint8Array): void | Promise<void>;
}

/** Options for {@link FrameSequenceSink}. */
export interface FrameSequenceOptions {
  /** Where encoded PNGs are written. */
  readonly target: FrameSequenceTarget;
  /** Filename prefix. Default `"frame-"`. */
  readonly prefix?: string;
  /** Zero-pad width for the frame index in filenames. Default `5`. */
  readonly pad?: number;
}

/**
 * A {@link FrameSink} that encodes each captured frame to a PNG and hands it to
 * a {@link FrameSequenceTarget}. This is the WebCodecs-absent fallback; the
 * acceptance contract is exactly one PNG per frame (N seconds × F fps = N*F
 * PNGs).
 */
export class FrameSequenceSink implements FrameSink {
  /** Count of PNGs written so far. */
  private count = 0;

  private readonly target: FrameSequenceTarget;
  private readonly prefix: string;
  private readonly pad: number;

  constructor(options: FrameSequenceOptions) {
    this.target = options.target;
    this.prefix = options.prefix ?? "frame-";
    this.pad = options.pad ?? 5;
  }

  /** Number of PNGs emitted. */
  get written(): number {
    return this.count;
  }

  async writeFrame(frame: CapturedFrame): Promise<void> {
    const png = encodePng(frame.width, frame.height, frame.pixels);
    const filename = `${this.prefix}${String(frame.index).padStart(this.pad, "0")}.png`;
    await this.target.write(frame.index, filename, png);
    this.count++;
  }

  finish(): void {
    // Nothing to flush: each PNG is fully written as it arrives.
  }
}

/**
 * Encode RGBA8 pixels (`width * height * 4` bytes, row-major) into a complete
 * PNG byte stream: 8-bit RGBA, no interlacing, a single IDAT carrying a zlib
 * *stored*-block stream of the filtered scanlines (filter type 0 per row).
 * Deterministic and dependency-free.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError("encodePng: width and height must be positive integers");
  }
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new RangeError(
      `encodePng: expected ${expected} RGBA bytes (${width}x${height}), got ${rgba.length}`,
    );
  }

  // Build the raw (unfiltered) image data: each scanline is prefixed with a
  // filter-type byte (0 = none).
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const srcOff = y * stride;
    const dstOff = y * (stride + 1);
    raw[dstOff] = 0; // filter type: none
    raw.set(rgba.subarray(srcOff, srcOff + stride), dstOff + 1);
  }

  const zlibData = zlibStore(raw);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibData),
    chunk("IEND", new Uint8Array(0)),
  ];

  let total = SIGNATURE.length;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(SIGNATURE, off);
  off += SIGNATURE.length;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Build a length-prefixed, CRC-suffixed PNG chunk. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);

  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);

  // CRC covers the type bytes + data.
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/**
 * Wrap `data` in a zlib stream using only *stored* (uncompressed) DEFLATE
 * blocks. No compressor required; output is a valid zlib stream every decoder
 * accepts. Each stored block carries at most 65535 bytes (LEN/NLEN are 16-bit).
 */
function zlibStore(data: Uint8Array): Uint8Array {
  const MAX = 0xffff;
  const blockCount = Math.max(1, Math.ceil(data.length / MAX));
  // 2-byte zlib header + per-block (5-byte header + payload) + 4-byte Adler-32.
  const out = new Uint8Array(2 + blockCount * 5 + data.length + 4);
  let off = 0;

  // zlib header: CMF=0x78 (deflate, 32K window), FLG chosen so (CMF<<8|FLG)%31==0.
  out[off++] = 0x78;
  out[off++] = 0x01;

  let pos = 0;
  for (let b = 0; b < blockCount; b++) {
    const len = Math.min(MAX, data.length - pos);
    const final = b === blockCount - 1 ? 1 : 0;
    out[off++] = final; // BFINAL bit + BTYPE=00 (stored)
    out[off++] = len & 0xff;
    out[off++] = (len >> 8) & 0xff;
    out[off++] = ~len & 0xff;
    out[off++] = (~len >> 8) & 0xff;
    out.set(data.subarray(pos, pos + len), off);
    off += len;
    pos += len;
  }

  const adler = adler32(data);
  out[off++] = (adler >>> 24) & 0xff;
  out[off++] = (adler >>> 16) & 0xff;
  out[off++] = (adler >>> 8) & 0xff;
  out[off++] = adler & 0xff;
  return out;
}

/** Adler-32 checksum (zlib trailer). */
function adler32(data: Uint8Array): number {
  const MOD = 65521;
  let a = 1;
  let s = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + (data[i] ?? 0)) % MOD;
    s = (s + a) % MOD;
  }
  return ((s << 16) | a) >>> 0;
}

/** CRC-32 (PNG chunk checksum), computed with a lazily-built table. */
let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crcTable[(crc ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
