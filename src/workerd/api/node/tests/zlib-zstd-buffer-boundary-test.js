// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Regression tests for the zstd sync/callback paths when the output buffer
// fills up. Those paths drive the codec in a loop over a growable output buffer
// whose cumulative capacity is 40960 * 2^k bytes (40960, 81920, 163840, ...).
//
// Two failure modes are covered:
//
//  * Compression: when the compressed output does not fit in the buffer on the
//    first pass, the encoder still has data to flush and the sync loop reports
//    "Unexpected end of file" instead of continuing. This is only reachable
//    with poorly compressible input.
//
//  * Decompression: when the last byte of a *valid* frame lands exactly on a
//    buffer boundary, the loop runs once more with no input and reports
//    truncation. This is only reachable when the decompressed size is exactly
//    40960 * 2^k.
//
// To keep the two bugs independent, the decompression tests use frames built
// by hand from raw/RLE blocks (see buildFrame) instead of frames produced by
// zstdCompressSync, and the compression tests verify the output structurally
// (see walkFrame) instead of decompressing it with zstdDecompressSync.

import assert from 'node:assert';
import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';

const BASE = 40960;
const ZSTD_MAGIC = 0xfd2fb528;
const MAX_BLOCK_SIZE = 128 * 1024;

// Output buffer boundaries (cumulative capacity of the growable buffer).
const BOUNDARIES = [BASE, BASE * 2, BASE * 4, BASE * 8, BASE * 16];
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

const DATA_KINDS = {
  random: randomBuffer,
  repetitive: repetitiveBuffer,
};

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

function callbackDecompress(input, opts) {
  return new Promise((resolve, reject) => {
    zlib.zstdDecompress(input, opts ?? {}, (err, res) =>
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
// Sanity checks for the helpers themselves. These must pass regardless of the
// state of the zstd bugs; if they fail the matrix below is meaningless.

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
// Bug 1: compression reports "Unexpected end of file" when the compressed
// output needs more than one buffer chunk.

// Issue repro: 40944 random bytes compress, 40960 random bytes throw.
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

// Compressible data produces tiny output and must never have been affected;
// this guards against a fix that regresses the common case.
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

// The output should be exactly one frame. Looping once more after the frame
// is complete (for example because the output buffer happened to fill exactly)
// would start a new, empty frame and append it. Decoders tolerate that, but it
// is wasted bytes and the same over-iteration that breaks decompression.
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
// syncProcessBuffer but shares the encoder's end-of-stream check, and fails the
// same way once the output exceeds the stream's own chunk size.
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
// sync buffer, so the failure starts at a correspondingly smaller input size.
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

// Full round trip. Both ends are workerd, so a failure here may come from
// either bug; the tests above and below say which.
export const zstdRoundTripRandomSyncTest = {
  test() {
    forEachCase(sizeCases(DELTAS), ({ n }) => {
      const raw = randomBuffer(n);
      const out = zlib.zstdDecompressSync(zlib.zstdCompressSync(raw));
      assert(out.equals(raw), `n=${n} round trip mismatch`);
    });
  },
};

export const zstdRoundTripRepetitiveSyncTest = {
  test() {
    forEachCase(sizeCases(DELTAS), ({ n }) => {
      const raw = repetitiveBuffer(n);
      const out = zlib.zstdDecompressSync(zlib.zstdCompressSync(raw));
      assert(out.equals(raw), `n=${n} round trip mismatch`);
    });
  },
};

export const zstdRoundTripCallbackTest = {
  async test() {
    const cases = [];
    for (const kind of Object.keys(DATA_KINDS)) {
      for (const n of [BASE - 1, BASE, BASE + 1, BASE * 2]) {
        cases.push({ kind, n, label: `${kind} n=${n}` });
      }
    }
    await forEachCaseAsync(cases, async ({ kind, n }) => {
      const raw = DATA_KINDS[kind](n);
      const compressed = await callbackCompress(raw);
      const out = await callbackDecompress(compressed);
      assert(out.equals(raw), 'round trip mismatch');
    });
  },
};

export const zstdRoundTripStreamTest = {
  async test() {
    const cases = [];
    for (const kind of Object.keys(DATA_KINDS)) {
      for (const n of [BASE - 1, BASE, BASE + 1, BASE * 2]) {
        cases.push({ kind, n, label: `${kind} n=${n}` });
      }
    }
    await forEachCaseAsync(cases, async ({ kind, n }) => {
      const raw = DATA_KINDS[kind](n);
      const compressed = await streamThrough(zlib.createZstdCompress(), raw);
      const out = await streamThrough(zlib.createZstdDecompress(), compressed);
      assert(out.equals(raw), 'round trip mismatch');
    });
  },
};

// ---------------------------------------------------------------------------
// Bug 2: decompression reports "unexpected end of file" when a valid frame's
// decompressed size is exactly 40960 * 2^k.

export const zstdDecompressExactBoundaryTest = {
  test() {
    // Issue repro: constant bytes at 40960, 81920 and 163840.
    for (const n of [40960, 81920, 163840]) {
      const raw = repetitiveBuffer(n);
      const out = zlib.zstdDecompressSync(zlib.zstdCompressSync(raw));
      assert(out.equals(raw), `n=${n} should round trip`);
    }
  },
};

function rawFor(kind, n) {
  return kind === 'repetitive' ? repetitiveBuffer(n) : randomBuffer(n);
}

// Decode hand-built frames (no workerd compressor involved) at every size
// around each buffer boundary.
function handBuiltDecompressTest(kind, contentSize) {
  return {
    test() {
      forEachCase(sizeCases(DELTAS), ({ n }) => {
        const frame = buildFrameFor(kind, n, { contentSize });
        const out = zlib.zstdDecompressSync(frame);
        assert(out.equals(rawFor(kind, n)), `n=${n} decoded bytes differ`);
      });
    },
  };
}

export const zstdDecompressHandBuiltRepetitiveNoContentSizeTest =
  handBuiltDecompressTest('repetitive', false);
export const zstdDecompressHandBuiltRepetitiveWithContentSizeTest =
  handBuiltDecompressTest('repetitive', true);
export const zstdDecompressHandBuiltRandomNoContentSizeTest =
  handBuiltDecompressTest('random', false);
export const zstdDecompressHandBuiltRandomWithContentSizeTest =
  handBuiltDecompressTest('random', true);

// Splits `total` bytes into blocks no larger than the zstd maximum.
function splitBlocks(total) {
  const sizes = [];
  for (let left = total; left > 0; left -= MAX_BLOCK_SIZE) {
    sizes.push(Math.min(left, MAX_BLOCK_SIZE));
  }
  return sizes;
}

// Frames made of several blocks, so the output boundary can fall between
// blocks as well as inside one.
export const zstdDecompressMultiBlockBoundaryTest = {
  test() {
    const cases = [];
    for (const n of BOUNDARIES.slice(0, 4)) {
      const q = n / 4;
      cases.push({ n, sizes: [q, q, q, q], label: `n=${n} 4 equal blocks` });
      cases.push({
        n,
        sizes: [...splitBlocks(n - 1), 1],
        label: `n=${n} trailing 1-byte block`,
      });
      cases.push({
        n,
        sizes: [1, ...splitBlocks(n - 1)],
        label: `n=${n} leading 1-byte block`,
      });
      cases.push({
        n,
        sizes: [...splitBlocks(n), 0],
        label: `n=${n} trailing empty last block`,
      });
    }
    forEachCase(cases, ({ n, sizes }) => {
      const raw = randomBuffer(n);
      const frame = buildFrame(raw, 'raw', { blockSizes: sizes });
      const out = zlib.zstdDecompressSync(frame);
      assert(out.equals(raw), 'decoded bytes differ');
    });
  },
};

// chunkSize is validated but doesn't size the output buffer, so it must not
// change the outcome at the boundary.
export const zstdDecompressChunkSizeIgnoredTest = {
  test() {
    const frame = buildFrameFor('repetitive', BASE);
    const raw = repetitiveBuffer(BASE);
    forEachCase(
      [64, 1024, 16384, 40960, 65536, 1024 * 1024].map((chunkSize) => ({
        chunkSize,
        label: `chunkSize=${chunkSize}`,
      })),
      ({ chunkSize }) => {
        const out = zlib.zstdDecompressSync(frame, { chunkSize });
        assert(out.equals(raw), 'decoded bytes differ');
      }
    );
  },
};

// maxOutputLength equal to the exact decoded size is allowed; one less is not.
export const zstdDecompressMaxOutputLengthBoundaryTest = {
  test() {
    forEachCase(sizeCases([0]), ({ n }) => {
      const frame = buildFrameFor('repetitive', n);
      const out = zlib.zstdDecompressSync(frame, { maxOutputLength: n });
      assert.strictEqual(out.length, n);
      assert.throws(
        () => zlib.zstdDecompressSync(frame, { maxOutputLength: n - 1 }),
        { name: 'RangeError', message: /Memory limit exceeded/ }
      );
    });
  },
};

export const zstdDecompressCallbackBoundaryTest = {
  async test() {
    const cases = [];
    for (const kind of ['repetitive', 'random']) {
      for (const n of [BASE - 1, BASE, BASE + 1, BASE * 2, BASE * 4]) {
        cases.push({ kind, n, label: `${kind} n=${n}` });
      }
    }
    await forEachCaseAsync(cases, async ({ kind, n }) => {
      const out = await callbackDecompress(buildFrameFor(kind, n));
      assert(out.equals(rawFor(kind, n)), 'decoded bytes differ');
    });
  },
};

// The streaming decoder is not affected by Bug 2; these are regression guards
// so a fix to the sync path doesn't change it.
export const zstdDecompressStreamBoundaryTest = {
  async test() {
    const cases = [];
    for (const kind of ['repetitive', 'random']) {
      for (const n of [BASE - 1, BASE, BASE + 1, BASE * 2, BASE * 4]) {
        cases.push({ kind, n, label: `${kind} n=${n}` });
      }
    }
    await forEachCaseAsync(cases, async ({ kind, n }) => {
      const out = await streamThrough(
        zlib.createZstdDecompress(),
        buildFrameFor(kind, n)
      );
      assert(out.equals(rawFor(kind, n)), 'decoded bytes differ');
    });
  },
};

export const zstdDecompressStreamChunkSizesTest = {
  async test() {
    const cases = [];
    for (const chunkSize of [64, 1024, 16384, 40960, 65536]) {
      for (const n of [BASE, BASE * 2]) {
        cases.push({ chunkSize, n, label: `chunkSize=${chunkSize} n=${n}` });
      }
    }
    await forEachCaseAsync(cases, async ({ chunkSize, n }) => {
      const out = await streamThrough(
        zlib.createZstdDecompress({ chunkSize }),
        buildFrameFor('repetitive', n)
      );
      assert(out.equals(repetitiveBuffer(n)), 'decoded bytes differ');
    });
  },
};

// Input arriving in small writes, so the exact fill happens mid-write.
export const zstdDecompressStreamSmallWritesTest = {
  async test() {
    const cases = [BASE, BASE * 2].map((n) => ({ n, label: `n=${n}` }));
    await forEachCaseAsync(cases, async ({ n }) => {
      const out = await streamThrough(
        zlib.createZstdDecompress(),
        buildFrameFor('random', n),
        1000
      );
      assert(out.equals(randomBuffer(n)), 'decoded bytes differ');
    });
  },
};

// Empty frames must keep working.
export const zstdDecompressEmptyFrameTest = {
  test() {
    for (const contentSize of [false, true]) {
      const frame = buildFrame(Buffer.alloc(0), 'raw', { contentSize });
      assert.strictEqual(zlib.zstdDecompressSync(frame).length, 0);
    }
    assert.strictEqual(
      zlib.zstdDecompressSync(zlib.zstdCompressSync(Buffer.alloc(0))).length,
      0
    );
  },
};

// ---------------------------------------------------------------------------
// Truncation must still be detected, including when the decoder has already
// produced exactly as many bytes as fit in the output buffer. A fix for Bug 2
// that stops looping as soon as the output is full, or as soon as the input is
// consumed, would turn these into silent successes.

function truncatedFrames(n) {
  const raw = randomBuffer(n);
  const frames = [];

  // All data present, but the final block isn't marked as last.
  frames.push({
    label: `n=${n} no last-block flag`,
    frame: buildFrame(raw, 'raw', { lastBlock: false }),
  });

  // All data present in a non-last block; the next block header is missing.
  frames.push({
    label: `n=${n} missing next block header`,
    frame: buildFrame(raw, 'raw', {
      blockSizes: [...splitBlocks(n - 1), 1],
      lastBlock: false,
    }),
  });

  // Checksum flag set, all blocks present, checksum bytes missing.
  frames.push({
    label: `n=${n} missing checksum`,
    frame: buildFrame(raw, 'raw', { checksum: true }),
  });

  // Checksum flag set, only part of the checksum present.
  frames.push({
    label: `n=${n} partial checksum`,
    frame: buildFrame(raw, 'raw', {
      checksum: true,
      checksumBytes: Buffer.from([1, 2]),
    }),
  });

  // Final block's data is one byte short.
  const complete = buildFrame(raw, 'raw');
  frames.push({
    label: `n=${n} last byte missing`,
    frame: complete.subarray(0, complete.length - 1),
  });

  // The frame ends partway through a block header.
  const withTrailingBlock = buildFrame(raw, 'raw', {
    blockSizes: [...splitBlocks(n), 0],
  });
  frames.push({
    label: `n=${n} partial block header`,
    frame: withTrailingBlock.subarray(0, withTrailingBlock.length - 1),
  });
  return frames;
}

function truncatedCases(sizes) {
  const cases = [];
  for (const n of sizes) cases.push(...truncatedFrames(n));
  return cases;
}

const TRUNCATION_SIZES = [BASE - 1, BASE, BASE + 1, BASE * 2];

export const zstdTruncatedAtBoundarySyncTest = {
  test() {
    forEachCase(truncatedCases(TRUNCATION_SIZES), ({ frame }) => {
      assert.throws(() => zlib.zstdDecompressSync(frame), Error);
    });
  },
};

export const zstdTruncatedAtBoundaryCallbackTest = {
  async test() {
    await forEachCaseAsync(
      truncatedCases(TRUNCATION_SIZES),
      async ({ frame }) => {
        await assert.rejects(callbackDecompress(frame), Error);
      }
    );
  },
};

export const zstdTruncatedAtBoundaryStreamTest = {
  async test() {
    await forEachCaseAsync(
      truncatedCases(TRUNCATION_SIZES),
      async ({ frame }) => {
        await assert.rejects(
          streamThrough(zlib.createZstdDecompress(), frame),
          Error
        );
      }
    );
  },
};

// Every possible cut point of a small multi-block frame must be rejected.
export const zstdTruncatedEveryCutPointTest = {
  test() {
    const frame = buildFrame(randomBuffer(300), 'raw', {
      blockSizes: [100, 100, 100],
      checksum: true,
      checksumBytes: Buffer.alloc(4),
    });
    const cases = [];
    for (let cut = 1; cut < frame.length; cut++) {
      cases.push({ cut, label: `cut=${cut}` });
    }
    forEachCase(cases, ({ cut }) => {
      assert.throws(
        () => zlib.zstdDecompressSync(frame.subarray(0, cut)),
        Error
      );
    });
  },
};

// Same, for compressor-produced output that is cut exactly where the output
// buffer would have filled.
export const zstdTruncatedCompressedAtBufferSizeTest = {
  test() {
    const compressed = zlib.zstdCompressSync(repetitiveBuffer(BASE * 2));
    forEachCase(
      [compressed.length - 1, compressed.length - 4].map((cut) => ({
        cut,
        label: `cut=${cut}`,
      })),
      ({ cut }) => {
        assert.throws(
          () => zlib.zstdDecompressSync(compressed.subarray(0, cut)),
          Error
        );
      }
    );
  },
};

// ---------------------------------------------------------------------------
// Concatenated frames. These use hand-built frames so they're independent of
// both bugs, and must decode to the concatenation of the payloads.
//
// Note: today the sync and callback decoders only decode a later frame when
// the previous frame happened to end exactly on an output buffer boundary
// (that is the same over-iteration as Bug 2, which accidentally works here);
// otherwise the remaining input is silently dropped. The streaming decoder
// never decodes more than the first frame. Whether multi-frame input is meant
// to be supported is a decision for whoever fixes Bug 2, since a fix must not
// regress the cases that work today either way.

function concatCases() {
  const cases = [];
  const pairs = [
    [BASE, BASE],
    [BASE, 1],
    [BASE - 1, 1],
    [1, BASE - 1],
    [BASE - 16, 16],
    [BASE * 2, 5],
    [BASE, BASE * 2],
    [5, BASE * 2 - 5],
  ];
  for (const [a, b] of pairs) {
    cases.push({ sizes: [a, b], label: `[${a}, ${b}]` });
  }
  cases.push({ sizes: [BASE, BASE, BASE], label: `[${BASE} x3]` });
  cases.push({ sizes: [BASE, 0, BASE], label: `[${BASE}, empty, ${BASE}]` });
  return cases;
}

function concatFrames(sizes) {
  const raws = sizes.map((n, i) => randomBuffer(n, 0x1000 + i));
  const frame = Buffer.concat(
    raws.map((raw, i) => buildFrame(raw, 'raw', { contentSize: i % 2 === 0 }))
  );
  return { raw: Buffer.concat(raws), frame };
}

export const zstdConcatenatedFramesSyncTest = {
  test() {
    forEachCase(concatCases(), ({ sizes }) => {
      const { raw, frame } = concatFrames(sizes);
      const out = zlib.zstdDecompressSync(frame);
      assert(out.equals(raw), 'decoded bytes differ');
    });
  },
};

export const zstdConcatenatedFramesCallbackTest = {
  async test() {
    await forEachCaseAsync(concatCases(), async ({ sizes }) => {
      const { raw, frame } = concatFrames(sizes);
      const out = await callbackDecompress(frame);
      assert(out.equals(raw), 'decoded bytes differ');
    });
  },
};

export const zstdConcatenatedFramesStreamTest = {
  async test() {
    await forEachCaseAsync(concatCases(), async ({ sizes }) => {
      const { raw, frame } = concatFrames(sizes);
      const out = await streamThrough(zlib.createZstdDecompress(), frame);
      assert(out.equals(raw), 'decoded bytes differ');
    });
  },
};

// Frames from workerd's own compressor, kept well away from the boundaries so
// this exercises multi-frame handling on its own.
export const zstdConcatenatedCompressorFramesTest = {
  test() {
    const a = randomBuffer(1000, 1);
    const b = repetitiveBuffer(5000);
    const c = randomBuffer(3000, 3);
    const frame = Buffer.concat([a, b, c].map((x) => zlib.zstdCompressSync(x)));
    const out = zlib.zstdDecompressSync(frame);
    assert(out.equals(Buffer.concat([a, b, c])), 'decoded bytes differ');
  },
};

// A complete first frame that exactly fills the output buffer, followed by a
// truncated second frame, must still be reported as truncated.
export const zstdConcatenatedSecondFrameTruncatedTest = {
  test() {
    const first = buildFrameFor('random', BASE);
    const second = buildFrameFor('random', 100);
    const cases = [];
    for (const cut of [1, 3, 5, 8, second.length - 1]) {
      cases.push({ cut, label: `second frame cut=${cut}` });
    }
    forEachCase(cases, ({ cut }) => {
      const frame = Buffer.concat([first, second.subarray(0, cut)]);
      assert.throws(() => zlib.zstdDecompressSync(frame), Error);
    });
  },
};
