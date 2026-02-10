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
}

/**
 * A LogTape sink that routes log records to per-run log files.
 * Registered once at startup. File targets are added/removed dynamically
 * as runs start and complete.
 */
export class RunFileSink {
  private writers = new Map<string, FileWriter>();

  /**
   * Register a log file for a category prefix.
   * All log records matching this prefix will be written to the file.
   */
  async register(categoryPrefix: string[], filePath: string): Promise<void> {
    const key = prefixKey(categoryPrefix);
    // Close existing writer if any
    const existing = this.writers.get(key);
    if (existing) {
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
    });
  }

  /**
   * Unregister and close the file writer for a category prefix.
   */
  unregister(categoryPrefix: string[]): void {
    const key = prefixKey(categoryPrefix);
    const writer = this.writers.get(key);
    if (writer) {
      writer.fd.close();
      this.writers.delete(key);
    }
  }

  /**
   * The sink function to pass to LogTape configure().
   * Matches the longest registered prefix for each record.
   */
  get sink(): Sink {
    return (record: LogRecord) => {
      // Find the longest matching prefix
      let bestWriter: FileWriter | undefined;
      let bestLength = 0;

      for (const writer of this.writers.values()) {
        if (
          writer.prefix.length > bestLength &&
          categoryMatchesPrefix(record.category, writer.prefix)
        ) {
          bestWriter = writer;
          bestLength = writer.prefix.length;
        }
      }

      if (!bestWriter) return;

      const formatted = formatRecord(record);
      const line = formatted.endsWith("\n") ? formatted : formatted + "\n";
      // Fire-and-forget write - don't block the logger
      bestWriter.fd.write(bestWriter.encoder.encode(line)).catch(() => {
        // Ignore write errors (file may have been closed)
      });
    };
  }

  /**
   * Close all open file writers.
   */
  dispose(): void {
    for (const writer of this.writers.values()) {
      try {
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
