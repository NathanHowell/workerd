# Add brotli and zstd to CompressionStream and DecompressionStream

Temporary file; deleted when the PR is opened. Stacked on the zstd
buffer-boundary fixes for `node:zlib`.

---

`CompressionStream` and `DecompressionStream` now accept `"brotli"`, which the
Compression Streams standard defines, and `"zstd"`, which it does not and which
is therefore opt-in behind a new compatibility flag.

## Codec-neutral CodecStage

`CodecStage`, the shared engine behind the legacy C++ streams and the
TypeScript implementation, was written directly against `ZlibStream`. It now
drives a small `CodecBackend` interface whose `step()` reports `error`,
`progress`, `streamEnd`, `needsInput` and the produced bytes. The strict-mode
checks (trailing bytes, incomplete input at `close()`) and the pump loop are
expressed in those terms, so they behave identically for every format.
`ZlibBackend` wraps the existing deflate, deflate-raw and gzip path with no
behaviour change.

Format validation for the legacy pair, the TypeScript pair and
`newCompressionCodec` now goes through one `requireCodecFormat()`, which
returns a `CodecFormat` enum instead of passing format strings around.

## brotli

brotli is part of the standard and is not gated. It reuses the `node:zlib`
`BrotliEncoderContext` and `BrotliDecoderContext` through
`ContextBackend<Context>`, at the encoder's default quality, as `node:zlib`
does. Decoders are never given a finish directive, so the stage's own strict
checks apply and produce the same `TypeError`s as the zlib formats. The
`CompressionFormat` union in the generated types gains `"brotli"`, and the
brotli entries in the WPT expected-failure lists are removed.

## zstd behind `compression_stream_zstd`

`"zstd"` is accepted only with `compression_stream_zstd`, a dateless opt-in
flag in the style of `web_crypto_modern_algorithms`. Without it the format is
rejected like any other unknown format. The generated types do not list
`"zstd"`, since types cannot vary by flag.

Decompression decodes every frame of a concatenated stream, as RFC 8878
requires, and a truncated final frame rejects `close()` under strict checks.
One behaviour differs from the other formats and is pinned by tests: a byte
after the last frame is not reported as trailing data. zstd treats it as the
start of another frame, so it fails as corrupt input with `Decompression
failed.`.

To support the stage, `ZstdDecoderContext::isStreamEnd()` now reports an
explicit completed-frame flag. It previously returned true before any input
had been decoded, which made closing an empty zstd stream look successful.
`node:zlib` is unaffected.

## Tests

A new `formats.js` module in the compression suite cross-checks both formats
against `node:zlib` in both directions and covers the 16 KiB scratch-buffer
boundaries, empty streams, strict checks, corrupt input, concatenated zstd
frames and a truncated second frame. The construction, round-trip and
chunk-boundary tests include brotli and zstd, and a legacy-cell test pins that
zstd is rejected without the flag. The main cells pin `nodejs_zlib` for the
reference codecs and enable `compression_stream_zstd`. The WPT `compression`
and `compression-ts` targets pass with the brotli expectations removed.
