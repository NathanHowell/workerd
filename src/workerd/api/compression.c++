// Copyright (c) 2017-2022 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

#include "compression.h"

#include <workerd/io/features.h>
#include <workerd/jsg/util.h>

#include <nbytes.h>

namespace workerd::api {

CompressionAllocator::CompressionAllocator(
    kj::Arc<const jsg::ExternalMemoryTarget>&& externalMemoryTarget)
    : externalMemoryTarget(kj::mv(externalMemoryTarget)) {}

void* CompressionAllocator::AllocForZlib(void* data, uInt items, uInt size) {
  size_t real_size =
      nbytes::MultiplyWithOverflowCheck(static_cast<size_t>(items), static_cast<size_t>(size));
  return AllocForBrotli(data, real_size);
}

void* CompressionAllocator::AllocForBrotli(void* opaque, size_t size) {
  auto* allocator = static_cast<CompressionAllocator*>(opaque);
  auto data = kj::heapArray<kj::byte>(size);
  auto begin = data.begin();

  allocator->allocations.insert(begin,
      {.data = kj::mv(data),
        .memoryAdjustment = allocator->externalMemoryTarget->getAdjustment(size)});
  return begin;
}

void CompressionAllocator::FreeForZlib(void* opaque, void* pointer) {
  if (KJ_UNLIKELY(pointer == nullptr)) return;
  auto* allocator = static_cast<CompressionAllocator*>(opaque);
  // No need to destroy memoryAdjustment here.
  // Dropping the allocation from the hashmap will defer the adjustment
  // until the isolate lock is held.
  JSG_REQUIRE(allocator->allocations.erase(pointer), Error, "Zlib allocation should exist"_kj);
}

// =======================================================================================
// ZlibStream

ZlibStream::ZlibStream(CompressionAllocator& allocator) {
  stream.zalloc = CompressionAllocator::AllocForZlib;
  stream.zfree = CompressionAllocator::FreeForZlib;
  stream.opaque = &allocator;
}

ZlibStream::~ZlibStream() noexcept(false) {
  end();
}

kj::Maybe<int> ZlibStream::init(Mode mode, Options options) {
  KJ_ASSERT(!initialized, "ZlibStream::init() may only be called once");
  this->mode = mode;
  int result = [&]() {
    switch (mode) {
      case Mode::COMPRESS:
        return deflateInit2(&stream, options.level, Z_DEFLATED, options.windowBits,
            options.memLevel, options.strategy);
      case Mode::DECOMPRESS:
        return inflateInit2(&stream, options.windowBits);
    }
    KJ_UNREACHABLE;
  }();
  if (result != Z_OK) {
    return result;
  }
  initialized = true;
  return kj::none;
}

kj::Maybe<int> ZlibStream::reset() {
  KJ_ASSERT(initialized, "ZlibStream::reset() requires an initialized stream");
  int result = [&]() {
    switch (mode) {
      case Mode::COMPRESS:
        return deflateReset(&stream);
      case Mode::DECOMPRESS:
        return inflateReset(&stream);
    }
    KJ_UNREACHABLE;
  }();
  if (result != Z_OK) {
    return result;
  }
  return kj::none;
}

int ZlibStream::end() {
  if (!initialized || ended) {
    return Z_OK;
  }
  ended = true;
  switch (mode) {
    case Mode::COMPRESS:
      return deflateEnd(&stream);
    case Mode::DECOMPRESS:
      return inflateEnd(&stream);
  }
  KJ_UNREACHABLE;
}

int ZlibStream::run(int flush) {
  KJ_ASSERT(initialized && !ended, "ZlibStream::run() requires a live stream");
  switch (mode) {
    case Mode::COMPRESS:
      return deflate(&stream, flush);
    case Mode::DECOMPRESS:
      return inflate(&stream, flush);
  }
  KJ_UNREACHABLE;
}

void ZlibStream::setInput(kj::ArrayPtr<const kj::byte> input) {
  // zlib's next_in is non-const for historical reasons; deflate/inflate do not write
  // through it.
  stream.next_in = const_cast<kj::byte*>(input.begin());
  stream.avail_in = input.size();
}

void ZlibStream::setOutput(kj::ArrayPtr<kj::byte> output) {
  stream.next_out = output.begin();
  stream.avail_out = output.size();
}

size_t ZlibStream::availIn() const {
  return stream.avail_in;
}

size_t ZlibStream::availOut() const {
  return stream.avail_out;
}

kj::StringPtr ZlibStream::msg() const {
  if (stream.msg == nullptr) return nullptr;
  return kj::StringPtr(stream.msg);
}

kj::StringPtr ZlibStream::errorCodeName(int code) {
  switch (code) {
    case Z_OK:
      return "Z_OK"_kj;
    case Z_STREAM_END:
      return "Z_STREAM_END"_kj;
    case Z_NEED_DICT:
      return "Z_NEED_DICT"_kj;
    case Z_ERRNO:
      return "Z_ERRNO"_kj;
    case Z_STREAM_ERROR:
      return "Z_STREAM_ERROR"_kj;
    case Z_DATA_ERROR:
      return "Z_DATA_ERROR"_kj;
    case Z_MEM_ERROR:
      return "Z_MEM_ERROR"_kj;
    case Z_BUF_ERROR:
      return "Z_BUF_ERROR"_kj;
    case Z_VERSION_ERROR:
      return "Z_VERSION_ERROR"_kj;
    default:
      return "Z_UNKNOWN_ERROR"_kj;
  }
}

// =======================================================================================
// CodecStage

CodecFormat requireCodecFormat(jsg::Lock& js, kj::StringPtr format) {
  if (format == "deflate") return CodecFormat::DEFLATE;
  if (format == "deflate-raw") return CodecFormat::DEFLATE_RAW;
  if (format == "gzip") return CodecFormat::GZIP;
  if (format == "brotli") return CodecFormat::BROTLI;
  if (format == "zstd" && FeatureFlags::get(js).getCompressionStreamZstd()) {
    return CodecFormat::ZSTD;
  }
  JSG_FAIL_REQUIRE(TypeError,
      "The compression format must be either 'deflate', 'deflate-raw', 'gzip' or 'brotli'.");
}

namespace {

// deflate/inflate over the shared ZlibStream core.
class ZlibBackend final: public CodecBackend {
 public:
  ZlibBackend(CompressionAllocator& allocator, ZlibStream::Mode mode, CodecFormat format)
      : stream(allocator) {
    KJ_REQUIRE(
        stream.init(mode, ZlibStream::Options{.windowBits = windowBitsFor(format)}) == kj::none,
        "Failed to initialize compression context.");
  }

  void setInput(kj::ArrayPtr<const kj::byte> input) override {
    stream.setInput(input);
  }

  Step step(int flush, kj::ArrayPtr<kj::byte> output) override {
    stream.setOutput(output);
    int result = stream.run(flush);
    return Step{
      .error = !(result == Z_OK || result == Z_BUF_ERROR || result == Z_STREAM_END),
      // Z_OK with no output still means input was consumed into the window; pump again.
      .progress = result == Z_OK,
      .streamEnd = result == Z_STREAM_END,
      // zlib reports Z_BUF_ERROR when it can make no progress; with the whole scratch buffer
      // available that means it is waiting for input.
      .needsInput = result == Z_BUF_ERROR,
      .buffer = output.first(output.size() - stream.availOut()),
    };
  }

  size_t availIn() const override {
    return stream.availIn();
  }

 private:
  // 15 is the default value of the windowBits parameter for zlib; adding 16 selects the
  // gzip wrapper, and negating selects a raw (headerless) stream.
  static int windowBitsFor(CodecFormat format) {
    switch (format) {
      case CodecFormat::DEFLATE:
        return 15;
      case CodecFormat::DEFLATE_RAW:
        return -15;
      case CodecFormat::GZIP:
        return 15 + 16;
    }
    KJ_UNREACHABLE;
  }

  ZlibStream stream;
};

// The other codec libraries, over the node:zlib-shaped contexts below. Decoders are never given
// a finish directive: the stage's own strict checks decide what an incomplete stream means, so
// the contexts' finish-time truncation heuristics (Node semantics) stay out of the way.
template <typename Context>
class ContextBackend final: public CodecBackend {
 public:
  template <typename... Params>
  explicit ContextBackend(Params&&... params): context(kj::fwd<Params>(params)...) {}

  Context& getContext() {
    return context;
  }

  void setInput(kj::ArrayPtr<const kj::byte> input) override {
    context.setInputBuffer(input);
  }

  Step step(int flush, kj::ArrayPtr<kj::byte> output) override {
    context.setOutputBuffer(output);
    setFlush(flush);
    context.work();

    uint32_t availIn = 0;
    uint32_t availOut = 0;
    context.getAfterWriteResult(&availIn, &availOut);
    bool streamEnd = context.isStreamEnd();
    return Step{
      .error = context.getError() != kj::none,
      // A full output buffer may be hiding more output, and input left unconsumed before the
      // end of the stream is still to be processed.
      .progress = availOut == 0 || (!streamEnd && availIn > 0),
      .streamEnd = streamEnd,
      .needsInput = !streamEnd && availIn == 0 && availOut > 0,
      .buffer = output.first(output.size() - availOut),
    };
  }

  size_t availIn() const override {
    uint32_t availIn = 0;
    uint32_t availOut = 0;
    context.getAfterWriteResult(&availIn, &availOut);
    return availIn;
  }

 private:
  void setFlush(int flush);

  Context context;
};

template <>
void ContextBackend<BrotliEncoderContext>::setFlush(int flush) {
  context.setFlush(flush == Z_FINISH ? BROTLI_OPERATION_FINISH : BROTLI_OPERATION_PROCESS);
}
template <>
void ContextBackend<BrotliDecoderContext>::setFlush(int flush) {}
template <>
void ContextBackend<ZstdEncoderContext>::setFlush(int flush) {
  context.setFlush(flush == Z_FINISH ? ZSTD_e_end : ZSTD_e_continue);
}
template <>
void ContextBackend<ZstdDecoderContext>::setFlush(int flush) {}

kj::Own<CodecBackend> newCodecBackend(
    CompressionAllocator& allocator, ZlibStream::Mode mode, CodecFormat format) {
  switch (format) {
    case CodecFormat::DEFLATE:
    case CodecFormat::DEFLATE_RAW:
    case CodecFormat::GZIP:
      return kj::heap<ZlibBackend>(allocator, mode, format);
    case CodecFormat::BROTLI:
      switch (mode) {
        case ZlibStream::Mode::COMPRESS:
          return kj::heap<ContextBackend<BrotliEncoderContext>>(allocator, ZlibMode::BROTLI_ENCODE);
        case ZlibStream::Mode::DECOMPRESS:
          return kj::heap<ContextBackend<BrotliDecoderContext>>(allocator, ZlibMode::BROTLI_DECODE);
      }
      KJ_UNREACHABLE;
    case CodecFormat::ZSTD:
      switch (mode) {
        case ZlibStream::Mode::COMPRESS:
          return kj::heap<ContextBackend<ZstdEncoderContext>>(ZlibMode::ZSTD_ENCODE);
        case ZlibStream::Mode::DECOMPRESS:
          return kj::heap<ContextBackend<ZstdDecoderContext>>(ZlibMode::ZSTD_DECODE);
      }
      KJ_UNREACHABLE;
  }
  KJ_UNREACHABLE;
}

}  // namespace

CodecStage::Context::Context(Mode mode,
    CodecFormat format,
    Flags flags,
    kj::Arc<const jsg::ExternalMemoryTarget>&& externalMemoryTarget)
    : mode(mode),
      allocator(kj::mv(externalMemoryTarget)),
      backend(newCodecBackend(allocator, mode, format)),
      strictCompression(flags) {}

void CodecStage::Context::setInput(kj::ArrayPtr<const kj::byte> input) {
  backend->setInput(input);
}

CodecStage::Context::Result CodecStage::Context::pumpOnce(int flush) {
  auto result = backend->step(flush, kj::arrayPtr(buffer, sizeof(buffer)));

  switch (mode) {
    case Mode::COMPRESS:
      JSG_REQUIRE(!result.error, TypeError, "Compression failed.");
      break;
    case Mode::DECOMPRESS:
      JSG_REQUIRE(!result.error, TypeError, "Decompression failed.");
      break;
  }

  return result;
}

void CodecStage::Context::enforceStrictChecks(int flush, const Result& result) {
  if (mode != Mode::DECOMPRESS || strictCompression != Flags::STRICT) {
    return;
  }
  // The spec requires that a TypeError is produced if there is trailing data after the end
  // of the compression stream. Called AFTER the caller has buffered the iteration's output:
  // the final valid bytes (produced by the very pump step that observed the trailing junk)
  // are still delivered to any read that consumes them before the error lands, which is the
  // WPT-pinned observable order.
  JSG_REQUIRE(!(result.streamEnd && backend->availIn() > 0), TypeError,
      "Trailing bytes after end of compressed data");
  // Same applies to closing a stream before the complete decompressed data is available.
  JSG_REQUIRE(!(flush == Z_FINISH && result.needsInput && result.buffer.size() == 0), TypeError,
      "Called close() on a decompression stream with incomplete data");
}

void CodecStage::OutputBuffer::write(kj::ArrayPtr<const kj::byte> chunk) {
  if (chunk.size() == 0) return;
  blocks.push_back(kj::heapArray(chunk));
  total += chunk.size();
}

size_t CodecStage::OutputBuffer::pull(kj::ArrayPtr<kj::byte> dest) {
  size_t copied = 0;
  while (dest.size() > 0 && !blocks.empty()) {
    auto remaining = blocks.front().slice(headOffset);
    auto piece = remaining.first(kj::min(remaining.size(), dest.size()));
    dest.write(piece);
    copied += piece.size();
    headOffset += piece.size();
    if (headOffset == blocks.front().size()) {
      blocks.pop_front();
      headOffset = 0;
    }
  }
  total -= copied;
  if (blocks.empty()) blocks.shrinkToInitial();
  return copied;
}

void CodecStage::OutputBuffer::clear() {
  blocks.clear();
  blocks.shrinkToInitial();
  headOffset = 0;
  total = 0;
}

CodecStage::CodecStage(Mode mode,
    CodecFormat format,
    Flags flags,
    kj::Arc<const jsg::ExternalMemoryTarget>&& externalMemoryTarget)
    : context(mode, format, flags, kj::mv(externalMemoryTarget)) {}

void CodecStage::push(kj::ArrayPtr<const kj::byte> input) {
  context.setInput(input);
  pump(Z_NO_FLUSH);
}

void CodecStage::end() {
  if (finished) return;
  finished = true;
  pump(Z_FINISH);
}

size_t CodecStage::pull(kj::ArrayPtr<kj::byte> dest) {
  return output.pull(dest);
}

size_t CodecStage::available() {
  return output.size();
}

bool CodecStage::empty() {
  return output.empty();
}

void CodecStage::clear() {
  output.clear();
}

void CodecStage::pump(int flush) {
  while (true) {
    auto result = context.pumpOnce(flush);
    // Buffer any produced output BEFORE the strict checks run: an iteration can both produce
    // the stream's final bytes and observe the strict-mode error condition (e.g. trailing
    // junk after the end of the compressed data), and the bytes must remain deliverable.
    if (result.buffer.size() > 0) {
      output.write(result.buffer);
    }
    context.enforceStrictChecks(flush, result);
    if (result.buffer.size() == 0 && !result.progress) {
      return;
    }
  }
  KJ_UNREACHABLE;
}

// =======================================================================================
// CompressionCodec

CompressionCodec::CompressionCodec(CodecStage::Mode mode,
    CodecFormat format,
    CodecStage::Flags flags,
    kj::Arc<const jsg::ExternalMemoryTarget>&& externalMemoryTarget)
    : stage(mode, format, flags, kj::mv(externalMemoryTarget)) {}

void CompressionCodec::push(jsg::JsBufferSource chunk) {
  stage.push(chunk.asArrayPtr());
}

void CompressionCodec::end() {
  stage.end();
}

uint32_t CompressionCodec::pullInto(jsg::JsBufferSource view) {
  return static_cast<uint32_t>(stage.pull(view.asArrayPtr()));
}

double CompressionCodec::available() {
  return static_cast<double>(stage.available());
}

void CompressionCodec::clear() {
  stage.clear();
}

void newCompressionCodecCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
  // liftKj converts thrown kj/jsg exceptions (e.g. the validation TypeErrors below) into JS
  // exceptions (without it they would escape the raw callback and take down the process) and
  // sets the returned value as the callback's return value.
  jsg::liftKj(info, [&]() -> v8::Local<v8::Value> {
    auto& js = jsg::Lock::from(info.GetIsolate());

    auto modeStr = JSG_REQUIRE_NONNULL(jsg::JsValue(info[0]).tryCast<jsg::JsString>(), TypeError,
        "newCompressionCodec() expects a string mode argument");
    auto formatStr = JSG_REQUIRE_NONNULL(jsg::JsValue(info[1]).tryCast<jsg::JsString>(), TypeError,
        "newCompressionCodec() expects a string format argument");
    auto mode = modeStr.toString(js);
    auto format = requireCodecFormat(js, formatStr.toString(js));

    CodecStage::Mode codecMode;
    CodecStage::Flags codecFlags = CodecStage::Flags::NONE;
    if (mode == "compress") {
      codecMode = CodecStage::Mode::COMPRESS;
    } else if (mode == "decompress") {
      codecMode = CodecStage::Mode::DECOMPRESS;
      if (FeatureFlags::get(js).getStrictCompression()) {
        codecFlags = CodecStage::Flags::STRICT;
      }
    } else {
      JSG_FAIL_REQUIRE(TypeError, "The codec mode must be either 'compress' or 'decompress'.");
    }

    auto& handler = KJ_ASSERT_NONNULL(js.tryGetTypeHandler<jsg::Ref<CompressionCodec>>());
    return handler.wrap(js,
        js.alloc<CompressionCodec>(codecMode, format, codecFlags, js.getExternalMemoryTarget()));
  });
}

// =======================================================================================
// Brotli / Zstd contexts

void BrotliContext::setBuffers(kj::ArrayPtr<kj::byte> input, kj::ArrayPtr<kj::byte> output) {
  nextIn = reinterpret_cast<const uint8_t*>(input.begin());
  nextOut = output.begin();
  availIn = input.size();
  availOut = output.size();
}

void BrotliContext::setInputBuffer(kj::ArrayPtr<const kj::byte> input) {
  nextIn = input.begin();
  availIn = input.size();
}

void BrotliContext::setOutputBuffer(kj::ArrayPtr<kj::byte> output) {
  nextOut = output.begin();
  availOut = output.size();
}

uint BrotliContext::getAvailOut() const {
  return availOut;
}

void BrotliContext::setFlush(int _flush) {
  flush = static_cast<BrotliEncoderOperation>(_flush);
}

void BrotliContext::getAfterWriteResult(uint32_t* _availIn, uint32_t* _availOut) const {
  *_availIn = availIn;
  *_availOut = availOut;
}

BrotliEncoderContext::BrotliEncoderContext(CompressionAllocator& allocator, ZlibMode _mode)
    : BrotliContext(allocator, _mode) {
  // NOTE: Ignores any returned errors.
  // TODO(soon): It's possible that initialization doesn't need to happen until `initialize` is
  //   called elsewhere. I'm keeping it like this to avoid changing the existing behaviour.
  auto _ = initialize();
}

void BrotliEncoderContext::work() {
  JSG_REQUIRE(mode == ZlibMode::BROTLI_ENCODE, Error, "Mode should be BROTLI_ENCODE"_kj);
  JSG_REQUIRE_NONNULL(state.get(), Error, "State should not be empty"_kj);

  const uint8_t* internalNext = nextIn;
  lastResult = BrotliEncoderCompressStream(
      state.get(), flush, &availIn, &internalNext, &availOut, &nextOut, nullptr);
  nextIn += internalNext - nextIn;

  streamEnd = lastResult && BrotliEncoderIsFinished(state.get());
}

kj::Maybe<CompressionError> BrotliEncoderContext::initialize() {
  auto instance = BrotliEncoderCreateInstance(
      CompressionAllocator::AllocForBrotli, CompressionAllocator::FreeForZlib, &allocator);
  state = kj::disposeWith<BrotliEncoderDestroyInstance>(kj::mv(instance));

  if (state.get() == nullptr) {
    return CompressionError(
        "Could not initialize Brotli instance"_kj, "ERR_ZLIB_INITIALIZATION_FAILED"_kj, -1);
  }

  return kj::none;
}

kj::Maybe<CompressionError> BrotliEncoderContext::resetStream() {
  return initialize();
}

kj::Maybe<CompressionError> BrotliEncoderContext::setParams(int key, uint32_t value) {
  if (!BrotliEncoderSetParameter(state.get(), static_cast<BrotliEncoderParameter>(key), value)) {
    return CompressionError("Setting parameter failed", "ERR_BROTLI_PARAM_SET_FAILED", -1);
  }

  return kj::none;
}

kj::Maybe<CompressionError> BrotliEncoderContext::getError() const {
  if (!lastResult) {
    return CompressionError("Compression failed", "ERR_BROTLI_COMPRESSION_FAILED", -1);
  }

  return kj::none;
}

bool BrotliEncoderContext::isStreamEnd() const {
  return streamEnd;
}

BrotliDecoderContext::BrotliDecoderContext(CompressionAllocator& allocator, ZlibMode _mode)
    : BrotliContext(allocator, _mode) {
  // NOTE: Ignores any returned errors.
  // TODO(soon): It's possible that initialization doesn't need to happen until `initialize` is
  //   called elsewhere. I'm keeping it like this to avoid changing the existing behaviour.
  auto _ = initialize();
}

kj::Maybe<CompressionError> BrotliDecoderContext::initialize() {
  auto instance = BrotliDecoderCreateInstance(
      CompressionAllocator::AllocForBrotli, CompressionAllocator::FreeForZlib, &allocator);
  state = kj::disposeWith<BrotliDecoderDestroyInstance>(kj::mv(instance));

  if (state.get() == nullptr) {
    return CompressionError(
        "Could not initialize Brotli instance", "ERR_ZLIB_INITIALIZATION_FAILED", -1);
  }

  return kj::none;
}

void BrotliDecoderContext::work() {
  JSG_REQUIRE(mode == ZlibMode::BROTLI_DECODE, Error, "Mode should have been BROTLI_DECODE"_kj);
  JSG_REQUIRE_NONNULL(state.get(), Error, "State should not be empty"_kj);
  const uint8_t* internalNext = nextIn;
  lastResult = BrotliDecoderDecompressStream(
      state.get(), &availIn, &internalNext, &availOut, &nextOut, nullptr);
  nextIn += internalNext - nextIn;

  if (lastResult == BROTLI_DECODER_RESULT_ERROR) {
    error = BrotliDecoderGetErrorCode(state.get());
    errorString = kj::str("ERR_", BrotliDecoderErrorString(error));
  }
}

kj::Maybe<CompressionError> BrotliDecoderContext::resetStream() {
  return initialize();
}

kj::Maybe<CompressionError> BrotliDecoderContext::setParams(int key, uint32_t value) {
  if (!BrotliDecoderSetParameter(state.get(), static_cast<BrotliDecoderParameter>(key), value)) {
    return CompressionError("Setting parameter failed", "ERR_BROTLI_PARAM_SET_FAILED", -1);
  }

  return kj::none;
}

kj::Maybe<CompressionError> BrotliDecoderContext::getError() const {
  if (error != BROTLI_DECODER_NO_ERROR) {
    return CompressionError("Compression failed", errorString, -1);
  }

  if (flush == BROTLI_OPERATION_FINISH && lastResult == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT) {
    // Match zlib behavior, as brotli doesn't have its own code for this.
    return CompressionError("Unexpected end of file", "Z_BUF_ERROR", Z_BUF_ERROR);
  }

  return kj::none;
}

bool BrotliDecoderContext::isStreamEnd() const {
  return lastResult == BROTLI_DECODER_RESULT_SUCCESS;
}

// =======================================================================================
// Zstd Implementation

void ZstdContext::setBuffers(kj::ArrayPtr<kj::byte> input, kj::ArrayPtr<kj::byte> output) {
  setInputBuffer(input);
  setOutputBuffer(output);
}

void ZstdContext::setInputBuffer(kj::ArrayPtr<const kj::byte> input) {
  input_.src = input.begin();
  input_.size = input.size();
  input_.pos = 0;
}

void ZstdContext::setOutputBuffer(kj::ArrayPtr<kj::byte> output) {
  output_.dst = output.begin();
  output_.size = output.size();
  output_.pos = 0;
}

void ZstdContext::setFlush(int flush) {
  KJ_DASSERT(flush >= ZSTD_e_continue && flush <= ZSTD_e_end,
      "flush must be a valid ZSTD_EndDirective value");
  flush_ = static_cast<ZSTD_EndDirective>(flush);
}

kj::uint ZstdContext::getAvailOut() const {
  return output_.size - output_.pos;
}

void ZstdContext::getAfterWriteResult(uint32_t* availIn, uint32_t* availOut) const {
  *availIn = input_.size - input_.pos;
  *availOut = output_.size - output_.pos;
}

namespace {
// Helper to check ZSTD errors and return a CompressionError if present.
// Also sets the error code in the provided reference for later retrieval.
kj::Maybe<CompressionError> zstdCheckError(
    size_t result, ZSTD_ErrorCode& error, kj::StringPtr errorCode) {
  if (ZSTD_isError(result)) {
    error = ZSTD_getErrorCode(result);
    return CompressionError(ZSTD_getErrorName(result), errorCode, -1);
  }
  return kj::none;
}

// Wrappers for ZSTD free functions that return void (for use with kj::disposeWith).
void zstdFreeCCtx(ZSTD_CCtx* cctx) {
  ZSTD_freeCCtx(cctx);
}
void zstdFreeDCtx(ZSTD_DCtx* dctx) {
  ZSTD_freeDCtx(dctx);
}
}  // namespace

ZstdEncoderContext::ZstdEncoderContext(ZlibMode _mode)
    : ZstdContext(_mode),
      cctx_(kj::disposeWith<zstdFreeCCtx>(ZSTD_createCCtx())) {}

kj::Maybe<CompressionError> ZstdEncoderContext::initialize(uint64_t pledgedSrcSize) {
  if (cctx_.get() == nullptr) {
    return CompressionError(
        "Could not initialize Zstd instance"_kj, "ERR_ZLIB_INITIALIZATION_FAILED"_kj, -1);
  }

  if (pledgedSrcSize != ZSTD_CONTENTSIZE_UNKNOWN) {
    size_t result = ZSTD_CCtx_setPledgedSrcSize(cctx_.get(), pledgedSrcSize);
    KJ_IF_SOME(err, zstdCheckError(result, error_, "ERR_ZSTD_COMPRESSION_FAILED"_kj)) {
      return kj::mv(err);
    }
  }

  return kj::none;
}

void ZstdEncoderContext::work() {
  JSG_REQUIRE(mode == ZlibMode::ZSTD_ENCODE, Error, "Mode should be ZSTD_ENCODE"_kj);
  JSG_REQUIRE(cctx_.get() != nullptr, Error, "Zstd context should not be null"_kj);

  // Once a frame has been ended, ZSTD_compressStream2() starts a new frame on the next call,
  // so calling it with no input would emit a spurious empty frame. Callers re-invoke work()
  // whenever the previous call filled the output buffer, so that case must be a no-op.
  if (frameComplete_ && input_.pos >= input_.size) {
    return;
  }

  lastResult = ZSTD_compressStream2(cctx_.get(), &output_, &input_, flush_);

  if (ZSTD_isError(lastResult)) {
    error_ = ZSTD_getErrorCode(lastResult);
  } else {
    // With ZSTD_e_end, a return of 0 means the frame is complete and fully flushed; any
    // other value means more output space is needed to finish it.
    frameComplete_ = (flush_ == ZSTD_e_end && lastResult == 0);
  }
}

kj::Maybe<CompressionError> ZstdEncoderContext::resetStream() {
  if (cctx_.get() != nullptr) {
    size_t result = ZSTD_CCtx_reset(cctx_.get(), ZSTD_reset_session_only);
    KJ_IF_SOME(err, zstdCheckError(result, error_, "ERR_ZSTD_COMPRESSION_FAILED"_kj)) {
      return kj::mv(err);
    }
  }
  frameComplete_ = false;
  return kj::none;
}

kj::Maybe<CompressionError> ZstdEncoderContext::setParams(int key, int value) {
  KJ_DASSERT(key >= ZSTD_c_compressionLevel,
      "key must be a valid ZSTD_cParameter (first valid value is ZSTD_c_compressionLevel)");
  size_t result = ZSTD_CCtx_setParameter(cctx_.get(), static_cast<ZSTD_cParameter>(key), value);
  if (ZSTD_isError(result)) {
    return CompressionError(kj::str("Setting parameter failed: ", ZSTD_getErrorName(result)),
        "ERR_ZSTD_PARAM_SET_FAILED"_kj, -1);
  }
  return kj::none;
}

kj::Maybe<CompressionError> ZstdEncoderContext::getError() const {
  if (error_ != ZSTD_error_no_error) {
    return CompressionError(kj::str("Zstd compression failed: ", ZSTD_getErrorString(error_)),
        kj::str("ERR_ZSTD_COMPRESSION_FAILED"), -1);
  }

  return kj::none;
}

bool ZstdEncoderContext::isStreamEnd() const {
  return frameComplete_;
}

ZstdDecoderContext::ZstdDecoderContext(ZlibMode _mode)
    : ZstdContext(_mode),
      dctx_(kj::disposeWith<zstdFreeDCtx>(ZSTD_createDCtx())) {}

kj::Maybe<CompressionError> ZstdDecoderContext::initialize() {
  // dctx_ is created in the constructor. It can only be nullptr if ZSTD_createDCtx()
  // failed due to memory allocation failure.
  if (dctx_.get() == nullptr) {
    return CompressionError(
        "Could not initialize Zstd instance"_kj, "ERR_ZLIB_INITIALIZATION_FAILED"_kj, -1);
  }

  return kj::none;
}

void ZstdDecoderContext::work() {
  JSG_REQUIRE(mode == ZlibMode::ZSTD_DECODE, Error, "Mode should be ZSTD_DECODE"_kj);
  JSG_REQUIRE(dctx_.get() != nullptr, Error, "Zstd context should not be null"_kj);

  // Once a frame is complete, ZSTD_decompressStream() treats the next call as the start of a
  // new frame; given no input it just reports how many header bytes it wants. Callers re-invoke
  // work() whenever the previous call filled the output buffer, so that case must leave the
  // completed-frame result untouched or the truncation check below would misfire.
  if (!frameInProgress_ && input_.pos >= input_.size) {
    return;
  }

  do {
    lastResult = ZSTD_decompressStream(dctx_.get(), &output_, &input_);
    if (ZSTD_isError(lastResult)) {
      error_ = ZSTD_getErrorCode(lastResult);
      return;
    }
    // A return of 0 means a frame has been fully decoded and flushed. A zstd stream may consist
    // of several concatenated frames, so any remaining input is the next frame (or trailing
    // garbage, which the next call rejects); keep decoding while there is room for output.
  } while (lastResult == 0 && input_.pos < input_.size && output_.pos < output_.size);

  // lastResult > 0 means the decoder needs more input or output to finish the current frame.
  frameInProgress_ = (lastResult > 0);
  frameComplete_ = !frameInProgress_;
}

kj::Maybe<CompressionError> ZstdDecoderContext::resetStream() {
  if (dctx_.get() != nullptr) {
    size_t result = ZSTD_DCtx_reset(dctx_.get(), ZSTD_reset_session_only);
    KJ_IF_SOME(err, zstdCheckError(result, error_, "ERR_ZSTD_DECOMPRESSION_FAILED"_kj)) {
      return kj::mv(err);
    }
  }
  frameInProgress_ = false;
  frameComplete_ = false;
  return kj::none;
}

kj::Maybe<CompressionError> ZstdDecoderContext::setParams(int key, int value) {
  KJ_DASSERT(dctx_.get() != nullptr, "Zstd decompression context should not be null");
  size_t result = ZSTD_DCtx_setParameter(dctx_.get(), static_cast<ZSTD_dParameter>(key), value);
  if (ZSTD_isError(result)) {
    return CompressionError(kj::str("Setting parameter failed: ", ZSTD_getErrorName(result)),
        "ERR_ZSTD_PARAM_SET_FAILED"_kj, -1);
  }
  return kj::none;
}

kj::Maybe<CompressionError> ZstdDecoderContext::getError() const {
  if (error_ != ZSTD_error_no_error) {
    return CompressionError(kj::str("Zstd decompression failed: ", ZSTD_getErrorString(error_)),
        kj::str("ERR_ZSTD_DECOMPRESSION_FAILED"), -1);
  }

  // If this is the final flush, we're mid-frame (frame was started but never
  // completed), and the output buffer is not full (decoder had space but
  // couldn't produce more output), the input was truncated.
  if (flush_ == ZSTD_e_end && frameInProgress_ && output_.pos < output_.size) {
    return CompressionError("unexpected end of file"_kj, "ERR_ZSTD_DECOMPRESSION_FAILED"_kj, -1);
  }

  return kj::none;
}

bool ZstdDecoderContext::isStreamEnd() const {
  // True once at least one frame has been completely decoded and flushed with none in
  // progress; false before any input has been decoded.
  return frameComplete_;
}

}  // namespace workerd::api
