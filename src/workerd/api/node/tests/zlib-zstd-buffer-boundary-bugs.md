# node:zlib zstd: output-buffer-boundary bugs

Findings from writing `zlib-zstd-buffer-boundary-test.js`, which registers as
`//src/workerd/api/node/tests:zlib-zstd-buffer-boundary-test@`. Against the code
as it stands, 30 of its 44 tests fail and 14 pass. The failures are the bugs
described here; the passing tests are controls that a fix must keep passing.

Related: cloudflare/workerd#6769 (compress), PR #6773 (partial compress fix).

## Status of the evidence

- **Reproduced:** every failure listed under "Observed behaviour" comes from
  running the test target against workerd. The hand-built frames and the frame
  walker used by the tests were checked against Node's native zstd.
- **From reading the source, not verified by a fix:** the causes in the
  "Cause" sections. They fit every measured pattern, but nobody has stepped
  through the loop in a debugger or confirmed them by landing a fix.
- **Not investigated:** why streaming compression starts failing at about 16 KiB.
  It is very likely the same `getError()` check (see Bug 1), but that is an
  inference.

## Background

The sync and callback zstd paths run `syncProcessBuffer` in
`src/workerd/api/node/zlib-util.c++`. Each pass adds a chunk to a
`GrowableBuffer`, calls `ctx.work()`, calls `ctx.getError()`, and loops while
`ctx.getAvailOut() == 0`. The buffer is built from the constant
`ZLIB_PERFORMANT_CHUNK_SIZE` (40960), not from `opts.chunkSize`, and its
capacity doubles, so cumulative capacity is 40960 × 2^k: 40960, 81920, 163840,
and so on. `chunkSize` is validated but has no effect on these paths, and the
tests confirm that it doesn't change either bug.

The encoder and decoder contexts, including `getError()`, are in
`src/workerd/api/compression.c++`.

## Bug 1: compression throws "Unexpected end of file"

### Observed behaviour

- `zstdCompressSync` of random (incompressible) input throws `Z_BUF_ERROR`
  "Unexpected end of file" from about 40951 bytes upward. 40944 bytes works. The
  failure is not limited to the exact 40960 boundary; larger random inputs (50000,
  100 KiB, 200000, 1 MiB) fail as well.
- It fails at every compression level tried (1, 3, 9, 19), with the checksum
  flag set, with `pledgedSrcSize` set, and through the callback variant
  (`zstdCompress`).
- **Streaming compression is also affected.** `zlib.createZstdCompress()` fails on
  random input from about 16 KiB (16383, 16384, 16385, 20000, 30000 all fail;
  8192 and smaller pass), and fails for every `chunkSize` tried (64, 1024, 16384,
  65536) at 100 KiB. This matches the stream's own 16 KiB output chunk.
- Compressible input (constant bytes) is not affected at any size.

### Cause

`ZstdEncoderContext::getError()` returns "Unexpected end of file" when
`flush_ == ZSTD_e_end && lastResult != 0`. `ZSTD_compressStream2(..., ZSTD_e_end)`
returns a non-zero value when it still has output to flush, which is exactly the
case when the output buffer filled before the frame was finished. `getError()` is
called before the loop gets a chance to supply another chunk, so pending output
is reported as an error. This is a defect in the check, not in the loop
condition alone, so a fix to the loop condition has to move or remove the check
as well.

### Spurious trailing frame

Separately, at some sizes the compressor appends a 9-byte empty frame (magic,
descriptor, window descriptor, empty last block header) after the real frame.
For example 40950 random bytes produces two frames. This appears to be the same
over-iteration as Bug 2: the output buffer fills exactly at the end of the
frame, so the loop runs once more and `ZSTD_compressStream2` starts a new frame.
Node's native implementation does the same. Decoders accept it, so it is not a
correctness failure, but a fix that simply loops while the output is full will
produce it more often. `zstdCompressProducesSingleFrameTest` asserts that the
output is exactly one frame; whether that should be a requirement is a judgement
call for whoever fixes this.

## Bug 2: decompression throws "unexpected end of file" on valid data

### Observed behaviour

- A valid frame whose decompressed size is exactly 40960 × 2^k bytes fails with
  `unexpected end of file`. Sizes tested: 40960, 81920, 163840, 327680, 655360.
- The tests build frames by hand from raw and RLE blocks, with no compressor
  involved. In every variant, **only** the exact boundary sizes fail. All
  neighbouring sizes (±1, ±16, ±32) decode correctly. The variants are random and
  repetitive content, with and without a content size in the frame header, and
  single and multi-block layouts (including a trailing empty last block).
- It fails through the sync and callback paths, and for every `chunkSize` tried.
- **Streaming decompression is not affected** at any boundary size, `chunkSize`,
  or write size. It is covered by passing tests.

### Cause (hypothesis from source, not verified in a debugger)

When the last byte of a complete frame lands exactly at the end of the output
buffer, `availOut == 0`, so `syncProcessBuffer` loops again with a fresh,
empty-looking chunk and no input left. `ZSTD_decompressStream` treats that call as
the start of a new frame and returns a non-zero hint. `ZstdDecoderContext::work()`
sets `frameInProgress_ = (lastResult > 0)`, and `getError()` reports truncation
because `flush_ == ZSTD_e_end && frameInProgress_ && output_.pos < output_.size`
(the fresh chunk has `pos < size`).

The truncation check is a heuristic. In `work()`, `input_.size > 0` tests the total
input size, not the remaining input, so it is true on the empty follow-up call as
well.

## Multi-frame input is already mishandled

This was not part of the original report, which assumed concatenated frames work.

- **Sync and callback:** a later frame is decoded only when the previous frame
  happened to end exactly on a buffer boundary. That is the same over-iteration as
  Bug 2, which accidentally works here. Otherwise the remaining input is silently
  dropped with no error. For example `[40959, 1]`, `[1, 40959]` and `[5, 81915]`
  return output that differs from the concatenated payloads. The tests compare
  bytes and don't record how much was returned, so "only the first frame" is the
  likely explanation, not a measurement.
- **Streaming:** all ten concatenation cases fail, including the ones where the
  first frame ends exactly on a boundary, so later frames are apparently never
  decoded.
- Frames from workerd's own compressor behave the same (1000, 5000 and 3000 bytes
  concatenated do not decode to the concatenated payloads).
- Node 22's native decoder also returns only the first frame (checked with a
  small script), so this may be
  intended compatibility behaviour rather than a bug. It needs a decision from the
  fixer: either support multi-frame input or remove the `zstdConcatenated*` tests
  that expect it. A Bug 2 fix must not regress the cases that currently work.

## Truncation detection must be preserved

All truncation tests pass today, but partly for the wrong reason: at an exact
output fill they throw because of Bug 2. They are there to guard the fix. A fix
that stops looping as soon as the output is full, or as soon as the input is
consumed, without checking that the frame actually ended, would silently accept
truncated input. The cases cover, at 40959, 40960, 40961 and 81920 bytes:

- the final block not marked as last;
- the next block header missing after a non-last block;
- the checksum flag set with the checksum missing or partial;
- the last byte missing, and a partial block header;

through sync, callback and stream. They also cover every cut point of a small
multi-block frame, compressor output cut near the end, and a complete first frame
that exactly fills the buffer followed by a truncated second frame.

## Test results

Run with `bazel test //src/workerd/api/node/tests:zlib-zstd-buffer-boundary-test@
--test_output=all`.

Failing (30):

- Compression: `zstdCompressRandom40960Test`, `zstdCompressRandomLargeTest`,
  `zstdCompressRandomBoundarySweepTest`, `zstdCompressOutputExactlyFillsBufferTest`,
  `zstdCompressWithChecksumBoundaryTest`,
  `zstdCompressWithPledgedSrcSizeBoundaryTest`, `zstdCompressLevelsRandomTest`,
  `zstdCompressChunkSizeIgnoredTest`, `zstdCompressCallbackBoundaryTest`,
  `zstdCompressProducesSingleFrameTest`
- Streaming compression: `zstdCompressStreamBoundaryTest`,
  `zstdCompressStreamSmallWritesBoundaryTest`, `zstdCompressStreamRandomSizesTest`,
  `zstdCompressStreamChunkSizesTest`
- Decompression: `zstdDecompressExactBoundaryTest`,
  `zstdDecompressHandBuilt{Repetitive,Random}{NoContentSize,WithContentSize}Test`
  (4), `zstdDecompressMultiBlockBoundaryTest`, `zstdDecompressChunkSizeIgnoredTest`,
  `zstdDecompressCallbackBoundaryTest`
- Round trips: `zstdRoundTripRandomSyncTest`, `zstdRoundTripRepetitiveSyncTest`,
  `zstdRoundTripCallbackTest`, `zstdRoundTripStreamTest`
- Multi-frame: `zstdConcatenatedFramesSyncTest`, `zstdConcatenatedFramesCallbackTest`,
  `zstdConcatenatedFramesStreamTest`, `zstdConcatenatedCompressorFramesTest`

Passing (14), to be kept passing: `zstdCompressRepetitiveBoundaryTest`,
`zstdDecompressStreamBoundaryTest`, `zstdDecompressStreamChunkSizesTest`,
`zstdDecompressStreamSmallWritesTest`, `zstdDecompressMaxOutputLengthBoundaryTest`,
`zstdDecompressEmptyFrameTest`, `zstdTruncatedAtBoundarySyncTest`,
`zstdTruncatedAtBoundaryCallbackTest`, `zstdTruncatedAtBoundaryStreamTest`,
`zstdTruncatedEveryCutPointTest`, `zstdTruncatedCompressedAtBufferSizeTest`,
`zstdConcatenatedSecondFrameTruncatedTest`, and the two helper self-checks
`zstdHelperFramesAreWellFormedTest` and `zstdHelperWalkerRejectsTruncationTest`.

Some failures are counted in more than one category because a round trip fails if
either end fails: the round-trip tests fail from Bug 1 for random data and from
Bug 2 for exact boundary sizes. The compression and hand-built decompression tests
are the ones that separate the two.

## Suggested fix directions (untested)

1. Remove the `lastResult != 0` check from `ZstdEncoderContext::getError()` (as
   PR #6773 does) and let the loop continue while the encoder reports pending
   output, so the stream and sync paths both stop failing. Stop once the frame has
   ended instead of looping again after it, to avoid the spurious empty frame.
2. For the decoder, stop the loop once `isStreamEnd()` is true and the input is
   fully consumed, rather than running an extra empty iteration. Do not stop when
   input remains, so that later frames are still decoded where they are today.
3. Whichever is chosen, truncation must still be detected when the output buffer
   is exactly full: an incomplete frame whose data happens to fill the buffer must
   still throw.
