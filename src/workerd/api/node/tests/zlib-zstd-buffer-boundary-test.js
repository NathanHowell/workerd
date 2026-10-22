// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Regression tests for the zstd sync, callback and streaming paths when
// output crosses or exactly fills the output buffer. The sync and callback paths
// drive the codec in a loop over a growable output buffer whose cumulative
// capacity is 40960 * 2^k bytes (40960, 81920, 163840, ...).
//
// Covered:
//
//  * Compression: output that doesn't fit in the buffer on the first pass
//    needs further passes to flush the rest of the frame. This is only
//    reachable with poorly compressible input.
//
// The compression tests verify the output structurally (see walkFrame) rather
// than by decompressing it with zstdDecompressSync.

import assert from 'node:assert';
import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';

const BASE = 40960;
const ZSTD_MAGIC = 0xfd2fb528;
const MAX_BLOCK_SIZE = 128 * 1024;

// Output buffer boundaries (cumulative capacity of the growable buffer).
const BOUNDARIES = [BASE, BASE * 2, BASE * 4, BASE * 8, BASE * 16, BASE * 32];
// Offsets around each boundary. Frame overhead moves the compressed-size
// boundary relative to the raw-size boundary, so we look on both sides.
const DELTAS = [-32, -16, -1, 0, 1, 16, 32];

// ---------------------------------------------------------------------------
// Helpers

// Deterministic, incompressible filler (xorshift32).
function randomBuffer(n, seed = 0x12345678) {
  const out = Buffer.alloc(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i += 4) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    for (let j = 0; j < 4 && i + j < n; j++) {
      out[i + j] = (s >>> (8 * j)) & 0xff;
    }
  }
  return out;
}

// Highly compressible filler.
function repetitiveBuffer(n) {
  return Buffer.alloc(n, 7);
}

// Build a valid zstd frame out of uncompressed blocks. `kind` selects raw
// blocks (which carry the data verbatim, so any content works) or RLE blocks
// (which require `data` to be a single repeated byte). No compressor is
// involved, so the result doesn't depend on zstdCompressSync being correct.
//
// Options:
//   contentSize: record the content size in the frame header.
//   checksum:    set the checksum flag in the header. The 4 checksum bytes are
//                only appended if `checksumBytes` is given, since computing
//                XXH64 is not worth it here; this lets us build frames whose
//                trailing checksum is missing.
//   blockSizes:  explicit list of block sizes (must sum to data.length).
//   lastBlock:   set to false to omit the "last block" flag from the final
//                block, producing an unterminated frame.
function buildFrame(data, kind, opts = {}) {
  const {
    contentSize = false,
    checksum = false,
    checksumBytes = null,
    blockSizes = null,
    lastBlock = true,
  } = opts;

  const parts = [];
  const magic = Buffer.alloc(4);
  magic.writeUInt32LE(ZSTD_MAGIC);
  parts.push(magic);

  // Frame header descriptor: bits 7-6 = FCS field size (2 => 4 bytes),
  // bit 5 = single segment, bit 2 = content checksum.
  const descriptor = (contentSize ? 0x80 : 0x00) | (checksum ? 0x04 : 0x00);
  parts.push(Buffer.from([descriptor]));
  // Window descriptor (present because single-segment is not set): 1 MiB.
  parts.push(Buffer.from([10 << 3]));
  if (contentSize) {
    const fcs = Buffer.alloc(4);
    fcs.writeUInt32LE(data.length);
    parts.push(fcs);
  }

  let sizes = blockSizes;
  if (sizes == null) {
    sizes = [];
    let remaining = data.length;
    do {
      const n = Math.min(remaining, MAX_BLOCK_SIZE);
      sizes.push(n);
      remaining -= n;
    } while (remaining > 0);
  }
  assert.strictEqual(
    sizes.reduce((a, b) => a + b, 0),
    data.length,
    'blockSizes must cover the data'
  );

  let offset = 0;
  sizes.forEach((size, i) => {
    const isLast = lastBlock && i === sizes.length - 1;
    const type = kind === 'rle' ? 1 : 0;
    const header = (size << 3) | (type << 1) | (isLast ? 1 : 0);
    parts.push(
      Buffer.from([header & 0xff, (header >> 8) & 0xff, header >> 16])
    );
    if (kind === 'rle') {
      parts.push(Buffer.from([data[offset]]));
    } else {
      parts.push(data.subarray(offset, offset + size));
    }
    offset += size;
  });

  if (checksum && checksumBytes != null) {
    parts.push(checksumBytes);
  }
  return Buffer.concat(parts);
}

// Frames that only the raw/RLE builder can express without a compressor.
// `repetitive` data uses RLE blocks; `random` data uses raw blocks.
function buildFrameFor(kind, n, opts) {
  if (kind === 'repetitive') {
    return buildFrame(repetitiveBuffer(n), 'rle', opts);
  }
  return buildFrame(randomBuffer(n), 'raw', opts);
}

// Structural walk over a single zstd frame. Returns the number of bytes the
// frame occupies and throws if the buffer ends before the frame is complete.
// This is an independent check that a compressor produced a complete frame.
function walkFrame(buf, start = 0) {
  let pos = start;
  const need = (n, what) => {
    if (pos + n > buf.length) {
      throw new Error(
        `frame truncated at ${pos} (needed ${n} more bytes for ${what}, ` +
          `buffer is ${buf.length} bytes)`
      );
    }
  };

  need(4, 'magic');
  assert.strictEqual(buf.readUInt32LE(pos), ZSTD_MAGIC, 'bad zstd magic');
  pos += 4;

  need(1, 'frame header descriptor');
  const descriptor = buf[pos++];
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const hasChecksum = (descriptor & 0x04) !== 0;
  const dictIdFlag = descriptor & 0x03;

  if (!singleSegment) {
    need(1, 'window descriptor');
    pos += 1;
  }
  pos += [0, 1, 2, 4][dictIdFlag];
  pos += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag];
  need(0, 'frame header');

  for (;;) {
    need(3, 'block header');
    const header = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
    pos += 3;
    const isLast = (header & 1) !== 0;
    const type = (header >> 1) & 3;
    const size = header >> 3;
    // RLE blocks store a single byte; all other block types store `size`.
    const stored = type === 1 ? 1 : size;
    need(stored, 'block body');
    pos += stored;
    if (isLast) break;
  }

  if (hasChecksum) {
    need(4, 'content checksum');
    pos += 4;
  }
  return pos - start;
}

// Asserts that `buf` is a sequence of complete frames with nothing left over.
// Returns the number of frames.
function assertCompleteFrames(buf, label) {
  let pos = 0;
  let frames = 0;
  while (pos < buf.length) {
    try {
      pos += walkFrame(buf, pos);
    } catch (err) {
      assert.fail(`${label}: ${err.message}`);
    }
    frames++;
  }
  assert(frames > 0, `${label}: output is empty`);
  return frames;
}

// Run `fn` for each case and fail once at the end with every failing case
// listed, so a single run shows the full failure matrix rather than just the
// first failure.
function forEachCase(cases, fn) {
  const failures = [];
  for (const c of cases) {
    try {
      fn(c);
    } catch (err) {
      failures.push(`  ${c.label}: ${err.message.split('\n')[0]}`);
    }
  }
  assert.strictEqual(
    failures.length,
    0,
    `${failures.length}/${cases.length} cases failed:\n${failures.join('\n')}`
  );
}

async function forEachCaseAsync(cases, fn) {
  const failures = [];
  for (const c of cases) {
    try {
      await fn(c);
    } catch (err) {
      failures.push(`  ${c.label}: ${err.message.split('\n')[0]}`);
    }
  }
  assert.strictEqual(
    failures.length,
    0,
    `${failures.length}/${cases.length} cases failed:\n${failures.join('\n')}`
  );
}

function sizeCases(deltas) {
  const cases = [];
  for (const boundary of BOUNDARIES) {
    for (const delta of deltas) {
      cases.push({ n: boundary + delta, label: `n=${boundary + delta}` });
    }
  }
  return cases;
}

function callbackCompress(input, opts) {
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(input, opts ?? {}, (err, res) =>
      err ? reject(err) : resolve(res)
    );
  });
}

async function streamThrough(stream, input, writeSize = 0) {
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  if (writeSize > 0) {
    for (let i = 0; i < input.length; i += writeSize) {
      stream.write(input.subarray(i, i + writeSize));
    }
    stream.end();
  } else {
    stream.end(input);
  }
  await done;
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Sanity checks for the helpers themselves; the tests below are only
// meaningful if these pass.

export const zstdHelperFramesAreWellFormedTest = {
  test() {
    for (const n of [0, 1, 1000, MAX_BLOCK_SIZE, MAX_BLOCK_SIZE + 1]) {
      for (const kind of ['repetitive', 'random']) {
        for (const contentSize of [false, true]) {
          const frame = buildFrameFor(kind, n, { contentSize });
          assertCompleteFrames(frame, `${kind} n=${n} fcs=${contentSize}`);
        }
      }
    }
    // The frames must also be decodable for sizes that are nowhere near a
    // buffer boundary, which pins the builder to the actual zstd format.
    for (const n of [1, 1000, 30000]) {
      for (const kind of ['repetitive', 'random']) {
        for (const contentSize of [false, true]) {
          const raw =
            kind === 'repetitive' ? repetitiveBuffer(n) : randomBuffer(n);
          const frame = buildFrameFor(kind, n, { contentSize });
          assert(
            zlib.zstdDecompressSync(frame).equals(raw),
            `${kind} n=${n} fcs=${contentSize} should decode`
          );
        }
      }
    }
  },
};

export const zstdHelperWalkerRejectsTruncationTest = {
  test() {
    const frame = buildFrameFor('random', 1000, { contentSize: true });
    for (const cut of [0, 3, 5, 9, 12, 500, frame.length - 1]) {
      assert.throws(
        () => walkFrame(frame.subarray(0, cut)),
        /truncated/,
        `walker should reject frame cut at ${cut}`
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Compression of output that needs more than one buffer chunk.

// cloudflare/workerd#6769: 40944 random bytes fit in the first chunk, 40960 do
// not.
export const zstdCompressRandom40960Test = {
  test() {
    const ok = zlib.zstdCompressSync(randomBuffer(40944));
    assertCompleteFrames(ok, 'n=40944');
    const out = zlib.zstdCompressSync(randomBuffer(40960));
    assertCompleteFrames(out, 'n=40960');
  },
};

// Incompressible input whose output spans several chunks.
export const zstdCompressRandomLargeTest = {
  test() {
    forEachCase(
      [50000, 100 * 1024, 200000, 1024 * 1024].map((n) => ({
        n,
        label: `n=${n}`,
      })),
      ({ n }) => {
        assertCompleteFrames(zlib.zstdCompressSync(randomBuffer(n)), `n=${n}`);
      }
    );
  },
};

// Sweep every size near each buffer boundary with incompressible data. The
// failing range depends on frame overhead, so a single point isn't enough.
export const zstdCompressRandomBoundarySweepTest = {
  test() {
    const cases = [];
    for (const boundary of BOUNDARIES.slice(0, 4)) {
      for (let delta = -40; delta <= 40; delta++) {
        cases.push({ n: boundary + delta, label: `n=${boundary + delta}` });
      }
    }
    forEachCase(cases, ({ n }) => {
      assertCompleteFrames(zlib.zstdCompressSync(randomBuffer(n)), `n=${n}`);
    });
  },
};

// Compressible data produces output far smaller than a chunk, so it never needs
// a second pass.
export const zstdCompressRepetitiveBoundaryTest = {
  test() {
    forEachCase(sizeCases(DELTAS), ({ n }) => {
      assertCompleteFrames(
        zlib.zstdCompressSync(repetitiveBuffer(n)),
        `n=${n}`
      );
    });
  },
};

// Output where the compressed size is exactly the buffer size or an exact
// multiple of it. Compress at several sizes and look for any whose compressed
// output lands exactly on a boundary, to make sure that case is exercised.
export const zstdCompressOutputExactlyFillsBufferTest = {
  test() {
    // Raw-block frames add a fixed overhead of 9 bytes for data under 128 KiB
    // (4 magic + 1 descriptor + 1 window + 3 block header = 9), so aim there.
    const sizes = [];
    for (const boundary of BOUNDARIES.slice(0, 3)) {
      for (let overhead = 4; overhead <= 24; overhead++) {
        sizes.push(boundary - overhead);
      }
    }
    let hitExact = 0;
    forEachCase(
      sizes.map((n) => ({ n, label: `n=${n}` })),
      ({ n }) => {
        const out = zlib.zstdCompressSync(randomBuffer(n));
        assertCompleteFrames(out, `n=${n}`);
        if (BOUNDARIES.includes(out.length)) hitExact++;
      }
    );
    assert(
      hitExact > 0,
      'expected at least one case where compressed output is exactly 40960 * 2^k bytes'
    );
  },
};

// The output is exactly one frame. Calling the encoder again once the frame is
// complete, as the sync loop does when the output buffer fills exactly, must
// not start a new, empty frame.
export const zstdCompressProducesSingleFrameTest = {
  test() {
    const cases = [];
    for (const boundary of BOUNDARIES.slice(0, 4)) {
      for (let delta = -40; delta <= 8; delta++) {
        cases.push({ n: boundary + delta, label: `n=${boundary + delta}` });
      }
    }
    for (const n of [1000, 100 * 1024]) {
      cases.push({ n, label: `n=${n}` });
    }
    forEachCase(cases, ({ n }) => {
      const out = zlib.zstdCompressSync(randomBuffer(n));
      assert.strictEqual(
        assertCompleteFrames(out, `n=${n}`),
        1,
        `n=${n}: expected a single frame`
      );
    });
  },
};

// Pending output can consist only of the trailing checksum.
export const zstdCompressWithChecksumBoundaryTest = {
  test() {
    const cases = [];
    for (const boundary of BOUNDARIES.slice(0, 3)) {
      for (let delta = -24; delta <= 8; delta++) {
        cases.push({ n: boundary + delta, label: `n=${boundary + delta}` });
      }
    }
    forEachCase(cases, ({ n }) => {
      const out = zlib.zstdCompressSync(randomBuffer(n), {
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      });
      assertCompleteFrames(out, `n=${n}`);
    });
  },
};

export const zstdCompressWithPledgedSrcSizeBoundaryTest = {
  test() {
    forEachCase(sizeCases([-16, 0, 16]), ({ n }) => {
      const out = zlib.zstdCompressSync(randomBuffer(n), {
        pledgedSrcSize: n,
      });
      assertCompleteFrames(out, `n=${n}`);
    });
  },
};

export const zstdCompressLevelsRandomTest = {
  test() {
    const cases = [];
    for (const level of [1, 3, 9, 19]) {
      for (const n of [BASE, BASE * 2, 100 * 1024]) {
        cases.push({ n, level, label: `level=${level} n=${n}` });
      }
    }
    forEachCase(cases, ({ n, level }) => {
      const out = zlib.zstdCompressSync(randomBuffer(n), {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: level },
      });
      assertCompleteFrames(out, `level=${level} n=${n}`);
    });
  },
};

// chunkSize is validated but does not size the output buffer, so it must not
// change the outcome either way.
export const zstdCompressChunkSizeIgnoredTest = {
  test() {
    const cases = [];
    for (const chunkSize of [64, 1024, 16384, 40960, 65536, 1024 * 1024]) {
      cases.push({ chunkSize, label: `chunkSize=${chunkSize}` });
    }
    forEachCase(cases, ({ chunkSize }) => {
      const out = zlib.zstdCompressSync(randomBuffer(BASE), { chunkSize });
      assertCompleteFrames(out, `chunkSize=${chunkSize}`);
    });
  },
};

// Same input through the callback variant.
export const zstdCompressCallbackBoundaryTest = {
  async test() {
    const cases = [
      ...sizeCases([-16, 0, 16]),
      { n: 100 * 1024, label: 'n=102400' },
    ];
    await forEachCaseAsync(cases, async ({ n }) => {
      const out = await callbackCompress(randomBuffer(n));
      assertCompleteFrames(out, `n=${n}`);
    });
  },
};

// The streaming path (zlib.createZstdCompress) does not go through
// syncProcessBuffer but shares the encoder's end-of-stream handling.
export const zstdCompressStreamBoundaryTest = {
  async test() {
    const cases = [
      ...sizeCases([-16, 0, 16]),
      { n: 100 * 1024, label: 'n=102400' },
    ];
    await forEachCaseAsync(cases, async ({ n }) => {
      const out = await streamThrough(
        zlib.createZstdCompress(),
        randomBuffer(n)
      );
      assertCompleteFrames(out, `n=${n}`);
    });
  },
};

export const zstdCompressStreamSmallWritesBoundaryTest = {
  async test() {
    const cases = sizeCases([0]).slice(0, 3);
    await forEachCaseAsync(cases, async ({ n }) => {
      const out = await streamThrough(
        zlib.createZstdCompress(),
        randomBuffer(n),
        1000
      );
      assertCompleteFrames(out, `n=${n}`);
    });
  },
};

// Streaming compression of incompressible input at sizes that are not near any
// 40960 * 2^k boundary. The stream's output chunk size is much smaller than the
// sync buffer, so multi-chunk output starts at a correspondingly smaller input
// size.
export const zstdCompressStreamRandomSizesTest = {
  async test() {
    const cases = [1, 1000, 8192, 16383, 16384, 16385, 20000, 30000].map(
      (n) => ({ n, label: `n=${n}` })
    );
    await forEachCaseAsync(cases, async ({ n }) => {
      const out = await streamThrough(
        zlib.createZstdCompress(),
        randomBuffer(n)
      );
      assertCompleteFrames(out, `n=${n}`);
    });
  },
};

export const zstdCompressStreamChunkSizesTest = {
  async test() {
    const cases = [];
    for (const chunkSize of [64, 1024, 16384, 65536]) {
      cases.push({ chunkSize, label: `chunkSize=${chunkSize}` });
    }
    await forEachCaseAsync(cases, async ({ chunkSize }) => {
      const out = await streamThrough(
        zlib.createZstdCompress({ chunkSize }),
        randomBuffer(100 * 1024)
      );
      assertCompleteFrames(out, `chunkSize=${chunkSize}`);
    });
  },
};
