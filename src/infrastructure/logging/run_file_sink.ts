import { getTextFormatter, type LogRecord, type Sink } from "@logtape/logtape";

/**
 * Formats a LogRecord as a plain text line for file output.
 */
const formatRecord = getTextFormatter();

/**
 * Converts a category prefix array to a string key for map lookups.
 */
function prefixKey(prefix: string[]): string {
  return prefix.join("\x00");
}

/**
 * Checks whether `category` starts with `prefix`.
 */
function categoryMatchesPrefix(
  category: readonly string[],
  prefix: string[],
): boolean {
  if (category.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (category[i] !== prefix[i]) return false;
  }
  return true;
}

interface FileWriter {
  fd: Deno.FsFile;
  encoder: TextEncoder;
  prefix: string[];
  /** Promise chain that serialises writes so they complete in order. */
  writeQueue: Promise<void>;
}

/**
 * A LogTape sink that routes log records to per-run log files.
 * Registered once at startup. File targets are added/removed dynamically
 * as runs start and complete.
 *
 * Writes are chained through a promise queue per writer so they execute
 * sequentially. unregister() awaits the queue before closing the fd,
 * preventing silent data loss from in-flight writes.
 */
export class RunFileSink {
  private writers = new Map<string, FileWriter>();

  /**
   * Register a log file for a category prefix.
   * All log records matching this prefix will be written to the file.
   */
  async register(categoryPrefix: string[], filePath: string): Promise<void> {
    const key = prefixKey(categoryPrefix);
    // Await and close existing writer if any
    const existing = this.writers.get(key);
    if (existing) {
      await existing.writeQueue;
      existing.fd.close();
    }

    // Ensure parent directory exists
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir) {
      await Deno.mkdir(dir, { recursive: true });
    }

    const fd = await Deno.open(filePath, {
      write: true,
      create: true,
      truncate: true,
    });
    this.writers.set(key, {
      fd,
      encoder: new TextEncoder(),
      prefix: categoryPrefix,
      writeQueue: Promise.resolve(),
    });
  }

  /**
   * Unregister and close the file writer for a category prefix.
   * Awaits any pending writes before closing the file descriptor.
   */
  async unregister(categoryPrefix: string[]): Promise<void> {
    const key = prefixKey(categoryPrefix);
    const writer = this.writers.get(key);
    if (writer) {
      await writer.writeQueue;
      writer.fd.close();
      this.writers.delete(key);
    }
  }

  /**
   * The sink function to pass to LogTape configure().
   * Writes to all registered prefixes that match the record's category.
   * Each write is chained onto the writer's queue so writes are serialised.
   */
  get sink(): Sink {
    return (record: LogRecord) => {
      const formatted = formatRecord(record);
      const line = formatted.endsWith("\n") ? formatted : formatted + "\n";

      for (const writer of this.writers.values()) {
        if (categoryMatchesPrefix(record.category, writer.prefix)) {
          const data = writer.encoder.encode(line);
          writer.writeQueue = writer.writeQueue
            .then(() => writer.fd.write(data))
            .then(() => {})
            .catch(() => {});
        }
      }
    };
  }

  /**
   * Close all open file writers. Awaits pending writes first.
   */
  async dispose(): Promise<void> {
    for (const writer of this.writers.values()) {
      try {
        await writer.writeQueue;
        writer.fd.close();
      } catch {
        // Already closed
      }
    }
    this.writers.clear();
  }
}

/**
 * Global singleton RunFileSink instance.
 * Created once at startup and registered with LogTape.
 */
export const runFileSink = new RunFileSink();
