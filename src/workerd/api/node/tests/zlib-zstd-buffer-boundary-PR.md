# Fix node:zlib zstd output-buffer-boundary bugs

Temporary file; deleted when the PR is opened.

---

`node:zlib`'s zstd bindings had two bugs that only showed up when compressed or
decompressed output crossed or exactly filled the internal 40960-byte output
chunk. The sync, callback and streaming paths were all affected.

## Compression threw on output larger than one chunk

`ZstdEncoderContext::getError()` reported `Z_BUF_ERROR` ("Unexpected end of
file") whenever a `ZSTD_e_end` call returned non-zero. That return value only
means the output buffer filled before the frame could be finished and the
caller should grow or drain the buffer and call again. Because the sync and
callback loops check for an error before checking remaining output space, any
compression whose output exceeded the first chunk — random input of roughly
40 KiB and up — threw. The streaming compressor failed the same way when the
final write did not fit in one chunk. Compressible input was unaffected.

The encoder now tracks frame completion explicitly. Once a frame has ended,
calling `work()` again with no input is a no-op. Previously
`ZSTD_compressStream2` started a new frame and emitted a spurious empty 9-byte
frame whenever the finished frame happened to fill the output buffer exactly
(Node's native zstd does the same).

## Decompression threw on valid input of exactly 40960 × 2^k bytes

When the decompressed size exactly filled the output buffer, the sync and
callback loops called `work()` once more with no input left.
`ZSTD_decompressStream` then began looking for a new frame header and returned
a positive size hint, which the truncation check mistook for an unfinished
frame. `ZstdDecoderContext::work()` now returns early when no frame is in
progress and there is no input, leaving the completed-frame result in place.

## Concatenated frames are now decoded

Decoding used to stop after the first frame unless that frame happened to end
on an output-buffer boundary, in which case the extra iteration decoded the
next one by accident. The streaming path never decoded more than the first
frame because the JS layer ends the stream when input is left unconsumed.

RFC 8878 defines a zstd stream as one or more frames, and `zstd(1)` and
`pzstd` emit multi-frame output, so `work()` now keeps calling
`ZSTD_decompressStream` while a frame has completed and input remains,
mirroring the gzip member loop in `ZlibContext`. This is a deliberate departure
from Node's native zstd decoder, which silently drops everything after the
first frame: concatenated frames decode to the concatenated payloads, and
trailing garbage or a truncated later frame is reported as an error instead of
being ignored. Truncation detection for the first frame is unchanged.

## Tests

`zlib-zstd-buffer-boundary-test` covers compression and decompression through
the sync, callback and streaming APIs at and around every boundary up to
1 MiB, with compressible and random data, with and without checksums, content
sizes and `pledgedSrcSize`, plus truncation at every cut point, concatenated
frames, `maxOutputLength` exact fits and the single-frame output property.
Compression output is verified structurally with a frame walker and
decompression inputs are hand-built frames, so neither bug could mask the
other. All variants of the existing zlib, brotli and zstd tests still pass.

No `syncProcessBuffer` or zlib/brotli changes.
