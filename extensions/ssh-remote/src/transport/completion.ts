export interface SshRunCompletion {
  /** Random, operation-scoped frame prefix written after the remote command finishes. */
  startMarker: Buffer;
  /** Frame terminator following a decimal exit code or `?` when it is unknown. */
  endMarker: Buffer;
  /** Brief drain period before a lingering transport channel is finalized locally. */
  graceMs: number;
}

export interface SshCompletionMatch {
  exitCode: number | null;
}

export interface SshCompletionChunk {
  data: Buffer;
  completion?: SshCompletionMatch;
}

const MAX_COMPLETION_PAYLOAD_BYTES = 16;

function longestStartPrefixSuffix(data: Buffer, marker: Buffer): number {
  for (let length = Math.min(data.length, marker.length - 1); length > 0; length--) {
    if (data.subarray(data.length - length).equals(marker.subarray(0, length))) {
      return length;
    }
  }
  return 0;
}

function parseExitCode(payload: Buffer): number | null | undefined {
  const text = payload.toString("ascii");
  if (text === "?") return null;
  if (!/^-?\d{1,10}$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Removes one private completion frame from streamed stderr while preserving
 * ordinary output across arbitrary chunk boundaries.
 */
export class SshCompletionFrameFilter {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private matched = false;

  constructor(readonly completion: SshRunCompletion) {
    const { startMarker, endMarker, graceMs } = completion;
    if (startMarker.length < 1 || startMarker.length > 512) {
      throw new Error("SSH completion start marker must contain 1 to 512 bytes");
    }
    if (endMarker.length < 1 || endMarker.length > 32) {
      throw new Error("SSH completion end marker must contain 1 to 32 bytes");
    }
    if (!Number.isInteger(graceMs) || graceMs < 1 || graceMs > 30_000) {
      throw new Error("SSH completion grace must be an integer from 1 to 30000 milliseconds");
    }
  }

  push(chunk: Buffer): SshCompletionChunk {
    if (chunk.length === 0 || this.matched) {
      return { data: Buffer.alloc(0) };
    }
    const combined = this.pending.length > 0
      ? Buffer.concat([this.pending, chunk])
      : chunk;
    this.pending = Buffer.alloc(0);

    const startIndex = combined.indexOf(this.completion.startMarker);
    if (startIndex === -1) {
      const retained = longestStartPrefixSuffix(
        combined,
        this.completion.startMarker,
      );
      if (retained > 0) {
        this.pending = combined.subarray(combined.length - retained);
      }
      return {
        data: combined.subarray(0, combined.length - retained),
      };
    }

    const payloadStart = startIndex + this.completion.startMarker.length;
    const endIndex = combined.indexOf(this.completion.endMarker, payloadStart);
    if (endIndex === -1) {
      if (combined.length - payloadStart <= MAX_COMPLETION_PAYLOAD_BYTES) {
        this.pending = combined.subarray(startIndex);
        return { data: combined.subarray(0, startIndex) };
      }
      // A matching prefix with an oversized payload is ordinary stderr. Emit
      // the prefix and continue scanning the remaining bytes for a real frame.
      const prefix = combined.subarray(
        0,
        startIndex + this.completion.startMarker.length,
      );
      const rest = this.push(combined.subarray(prefix.length));
      return {
        data: rest.data.length > 0 ? Buffer.concat([prefix, rest.data]) : prefix,
        completion: rest.completion,
      };
    }

    const exitCode = parseExitCode(combined.subarray(payloadStart, endIndex));
    if (exitCode === undefined) {
      const invalidFrameEnd = endIndex + this.completion.endMarker.length;
      const prefix = combined.subarray(0, invalidFrameEnd);
      const rest = this.push(combined.subarray(invalidFrameEnd));
      return {
        data: rest.data.length > 0 ? Buffer.concat([prefix, rest.data]) : prefix,
        completion: rest.completion,
      };
    }

    this.matched = true;
    return {
      data: combined.subarray(0, startIndex),
      completion: { exitCode },
    };
  }

  flush(discardPartialFrame = false): Buffer {
    if (this.matched || this.pending.length === 0) return Buffer.alloc(0);
    const pending = this.pending;
    this.pending = Buffer.alloc(0);
    if (
      discardPartialFrame
      && (
        pending.indexOf(this.completion.startMarker) !== -1
        || this.completion.startMarker.subarray(0, pending.length).equals(pending)
      )
    ) {
      return Buffer.alloc(0);
    }
    return pending;
  }
}
