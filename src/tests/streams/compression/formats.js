// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// The formats beyond the zlib family. Their framing is cross-checked against
// node:zlib's codecs, so the web pair is verified independently of itself, and
// the codec-neutral stage behaviors (strict checks, empty streams, corrupt
// input, the 16 KiB scratch-buffer boundary) are pinned per format.

import { ok, strictEqual, rejects } from 'node:assert';
import zlib from 'node:zlib';
import { pump } from 'round-trip';

// format -> node:zlib reference codec, plus the error a byte appended after
// the end of the stream produces. brotli stops at the end of its stream, so
// the stage's trailing-data check sees the byte; zstd treats anything after a
// frame as the start of another frame, so the byte is corrupt input.
export const referenceCodecs = {
  brotli: {
    compress: (bytes) => zlib.brotliCompressSync(bytes),
    decompress: (bytes) => zlib.brotliDecompressSync(bytes),
    trailingMessage: 'Trailing bytes after end of compressed data',
  },
  zstd: {
    compress: (bytes) => zlib.zstdCompressSync(bytes),
    decompress: (bytes) => zlib.zstdDecompressSync(bytes),
    trailingMessage: 'Decompression failed.',
  },
};

export const formats = Object.keys(referenceCodecs);

// Compressible but non-trivial: a byte pattern with a slowly drifting phase.
function patterned(length, seed = 0) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (i * 7 + (i >> 8) + seed) & 0xff;
  }
  return out;
}

// Incompressible bytes from a seeded xorshift32, so sizes are reproducible.
function pseudoRandom(length, seed) {
  const out = new Uint8Array(length);
  let x = seed | 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function equalBytes(a, b) {
  return a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
}

export const interopWithNodeZlib = {
  async test() {
    const payload = patterned(100_000);
    for (const format of formats) {
      const ref = referenceCodecs[format];
      const compressed = await pump(new CompressionStream(format), [payload]);
      ok(
        compressed.byteLength < payload.byteLength,
        `${format} should compress the payload`
      );
      ok(
        equalBytes(new Uint8Array(ref.decompress(compressed)), payload),
        `${format}: node:zlib decodes the web pair's output`
      );
      const restored = await pump(new DecompressionStream(format), [
        new Uint8Array(ref.compress(payload)),
      ]);
      ok(
        equalBytes(restored, payload),
        `${format}: the web pair decodes node:zlib's output`
      );
    }
  },
};

// The stage pumps through a 16 KiB scratch buffer; output that exactly fills
// it must neither be lost nor duplicated, and a decompressor must not
// misreport the stream as incomplete or trailing when it ends on the boundary.
export const scratchBufferBoundaries = {
  async test() {
    const sizes = [];
    for (const k of [1, 2, 4]) {
      sizes.push(16384 * k - 1, 16384 * k, 16384 * k + 1);
    }
    for (const format of formats) {
      const ref = referenceCodecs[format];
      for (const size of sizes) {
        // Incompressible payload so the compressed size tracks the input.
        const raw = pseudoRandom(size, size);
        const compressed = await pump(new CompressionStream(format), [raw]);
        ok(
          equalBytes(new Uint8Array(ref.decompress(compressed)), raw),
          `${format} compress ${size}`
        );
        const restored = await pump(new DecompressionStream(format), [
          new Uint8Array(ref.compress(raw)),
        ]);
        ok(equalBytes(restored, raw), `${format} decompress ${size}`);
      }
    }
  },
};

export const emptyStreams = {
  async test() {
    for (const format of formats) {
      const ref = referenceCodecs[format];
      const compressed = await pump(new CompressionStream(format), []);
      ok(compressed.byteLength > 0, `${format}: empty stream has framing`);
      strictEqual(
        ref.decompress(compressed).byteLength,
        0,
        `${format}: empty stream decodes to nothing`
      );
      const restored = await pump(new DecompressionStream(format), [
        new Uint8Array(ref.compress(new Uint8Array(0))),
      ]);
      strictEqual(restored.byteLength, 0, `${format}: decompress empty`);
    }
  },
};

export const strictChecks = {
  async test() {
    const payload = new TextEncoder().encode('hello world');
    for (const format of formats) {
      const compressed = new Uint8Array(
        referenceCodecs[format].compress(payload)
      );

      // A byte after the end of the stream rejects the write.
      {
        const trailing = new Uint8Array(compressed.byteLength + 1);
        trailing.set(compressed);
        trailing[compressed.byteLength] = 0xff;
        const writer = new DecompressionStream(format).writable.getWriter();
        await rejects(writer.write(trailing), {
          constructor: TypeError,
          message: referenceCodecs[format].trailingMessage,
        });
      }

      // Closing with no data at all rejects.
      {
        const writer = new DecompressionStream(format).writable.getWriter();
        await rejects(writer.close(), {
          constructor: TypeError,
          message:
            'Called close() on a decompression stream with incomplete data',
        });
      }

      // A truncated stream is only detectable at close.
      {
        const writer = new DecompressionStream(format).writable.getWriter();
        await writer.write(compressed.subarray(0, compressed.byteLength - 2));
        await rejects(writer.close(), {
          constructor: TypeError,
          message:
            'Called close() on a decompression stream with incomplete data',
        });
      }
    }
  },
};

export const corruptInputRejectsWrite = {
  async test() {
    for (const format of formats) {
      const writer = new DecompressionStream(format).writable.getWriter();
      await rejects(
        writer.write(new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa])),
        { constructor: TypeError, message: 'Decompression failed.' }
      );
    }
  },
};

// A zstd stream is a sequence of frames (RFC 8878); the decompressor decodes
// all of them, including across write boundaries and an empty frame.
export const zstdConcatenatedFrames = {
  async test() {
    const parts = [
      patterned(20_000, 1),
      new Uint8Array(0),
      patterned(40_000, 2),
    ];
    const frames = parts.map((p) => new Uint8Array(zlib.zstdCompressSync(p)));
    const expected = new Uint8Array(60_000);
    expected.set(parts[0]);
    expected.set(parts[2], 20_000);

    const oneWrite = await pump(new DecompressionStream('zstd'), [
      new Uint8Array([...frames[0], ...frames[1], ...frames[2]]),
    ]);
    ok(equalBytes(oneWrite, expected), 'frames in one write');

    const perFrame = await pump(new DecompressionStream('zstd'), frames);
    ok(equalBytes(perFrame, expected), 'one frame per write');

    // A frame boundary inside a write, with the rest of the second frame later.
    const joined = new Uint8Array([...frames[0], ...frames[2]]);
    const cut = frames[0].byteLength + 5;
    const split = await pump(new DecompressionStream('zstd'), [
      joined.subarray(0, cut),
      joined.subarray(cut),
    ]);
    ok(
      equalBytes(split, new Uint8Array([...parts[0], ...parts[2]])),
      'frame boundary mid-write'
    );
  },
};

// The second frame of a concatenated stream is subject to the same incomplete
// close check as the first.
export const zstdTruncatedSecondFrameRejectsClose = {
  async test() {
    const first = new Uint8Array(zlib.zstdCompressSync(patterned(1000, 3)));
    const second = new Uint8Array(zlib.zstdCompressSync(patterned(1000, 4)));
    const writer = new DecompressionStream('zstd').writable.getWriter();
    await writer.write(first);
    await writer.write(second.subarray(0, second.byteLength - 3));
    await rejects(writer.close(), {
      constructor: TypeError,
      message: 'Called close() on a decompression stream with incomplete data',
    });
  },
};
