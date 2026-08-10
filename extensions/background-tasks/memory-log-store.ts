interface StoredLog {
  chunks: Buffer[];
  firstChunk: number;
  size: number;
}

/** Bounded in-memory byte store used for per-task stdout and stderr retention. */
export class MemoryLogStore {
  private readonly logs = new Map<string, StoredLog>();

  constructor(readonly maxLogBytes = 4 * 1024 * 1024) {
    if (!Number.isInteger(maxLogBytes) || maxLogBytes < 1) {
      throw new Error("Log capacity must be a positive integer");
    }
  }

  append(key: string, data: Buffer | string): void {
    const chunk = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, "utf8");
    if (chunk.length === 0) return;

    const log = this.logs.get(key) ?? { chunks: [], firstChunk: 0, size: 0 };
    log.chunks.push(chunk);
    log.size += chunk.length;
    this.trim(log);
    this.logs.set(key, log);
  }

  read(key: string): string {
    const log = this.logs.get(key);
    if (!log || log.size === 0) return "";
    return Buffer.concat(log.chunks.slice(log.firstChunk), log.size).toString("utf8");
  }

  delete(key: string): void {
    this.logs.delete(key);
  }

  clear(): void {
    this.logs.clear();
  }

  size(key: string): number {
    return this.logs.get(key)?.size ?? 0;
  }

  private trim(log: StoredLog): void {
    let excess = log.size - this.maxLogBytes;
    while (excess > 0) {
      const first = log.chunks[log.firstChunk];
      if (!first) break;
      if (first.length <= excess) {
        log.firstChunk += 1;
        log.size -= first.length;
        excess -= first.length;
        continue;
      }
      log.chunks[log.firstChunk] = Buffer.from(first.subarray(excess));
      log.size -= excess;
      excess = 0;
    }

    if (log.firstChunk >= 1024 && log.firstChunk * 2 >= log.chunks.length) {
      log.chunks = log.chunks.slice(log.firstChunk);
      log.firstChunk = 0;
    }
  }
}
