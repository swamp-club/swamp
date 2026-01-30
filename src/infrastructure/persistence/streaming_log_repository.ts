import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { LogRepository } from "../../domain/models/repositories.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  createModelLogId,
  LogEntry,
  ModelLog,
  type ModelLogId,
} from "../../domain/models/model_log.ts";

/**
 * Metadata stored alongside the log entries.
 */
interface LogMetadata {
  id: string;
  version: number;
  createdAt: string;
  [key: string]: unknown;
}

/**
 * Streaming implementation of LogRepository using plain text lines format.
 *
 * Stores log artifacts in two files:
 * - Metadata: {repoDir}/data/logs/{normalized-type}/{id}.yaml
 * - Entries:  {repoDir}/data/logs/{normalized-type}/{id}.log
 *
 * The .log format stores raw lines, allowing appending entries without
 * reading/rewriting the whole file.
 */
export class StreamingLogRepository implements LogRepository {
  constructor(private readonly repoDir: string) {}

  async findById(
    type: ModelType,
    id: ModelLogId,
  ): Promise<ModelLog | null> {
    const metadataPath = this.getMetadataPath(type, id);
    try {
      const metadataContent = await Deno.readTextFile(metadataPath);
      const metadata = parseYaml(metadataContent) as LogMetadata;

      // Read entries from log file
      const entriesPath = this.getPath(type, id);
      let entriesContent = "";
      try {
        entriesContent = await Deno.readTextFile(entriesPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
        // No entries file yet is fine
      }

      return ModelLog.fromLines(
        metadata.id,
        metadata.version,
        new Date(metadata.createdAt),
        entriesContent,
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async findAll(type: ModelType): Promise<ModelLog[]> {
    const dir = this.getTypeDir(type);
    const logs: ModelLog[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const id = entry.name.slice(0, -5); // Remove .yaml
          const log = await this.findById(type, createModelLogId(id));
          if (log) {
            logs.push(log);
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return logs;
  }

  async save(type: ModelType, log: ModelLog): Promise<void> {
    const dir = this.getTypeDir(type);
    await ensureDir(dir);

    // Save metadata
    const metadataPath = this.getMetadataPath(type, log.id);
    const metadata: LogMetadata = {
      id: log.id,
      version: log.version,
      createdAt: log.createdAt.toISOString(),
    };
    const metadataContent = stringifyYaml(metadata as Record<string, unknown>);
    await Deno.writeTextFile(metadataPath, metadataContent);

    // Save entries as plain text lines (overwrites existing) using streaming writes
    // to avoid "Invalid string length" errors with very large logs
    const entriesPath = this.getPath(type, log.id);
    const file = await Deno.open(entriesPath, {
      write: true,
      create: true,
      truncate: true,
    });
    try {
      const encoder = new TextEncoder();
      for (const entry of log.entries) {
        await file.write(encoder.encode(entry.toLine() + "\n"));
      }
    } finally {
      file.close();
    }
  }

  async append(
    type: ModelType,
    id: ModelLogId,
    entry: LogEntry,
  ): Promise<void> {
    const dir = this.getTypeDir(type);
    await ensureDir(dir);

    const entriesPath = this.getPath(type, id);
    const line = entry.toLine() + "\n";

    // Append to file (creates if doesn't exist)
    const file = await Deno.open(entriesPath, {
      write: true,
      create: true,
      append: true,
    });
    try {
      await file.write(new TextEncoder().encode(line));
    } finally {
      file.close();
    }
  }

  async *stream(
    type: ModelType,
    id: ModelLogId,
  ): AsyncIterable<LogEntry> {
    const entriesPath = this.getPath(type, id);

    let file: Deno.FsFile;
    try {
      file = await Deno.open(entriesPath, { read: true });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return;
      }
      throw error;
    }

    try {
      const decoder = new TextDecoder();
      let buffer = "";

      // Read in chunks
      const chunk = new Uint8Array(4096);
      let bytesRead: number | null;

      while ((bytesRead = await file.read(chunk)) !== null) {
        buffer += decoder.decode(chunk.subarray(0, bytesRead), {
          stream: true,
        });

        // Process complete lines
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (line.length > 0) {
            yield LogEntry.fromLine(line);
          }
        }
      }

      // Process any remaining content
      if (buffer.length > 0) {
        yield LogEntry.fromLine(buffer);
      }
    } finally {
      file.close();
    }
  }

  async delete(type: ModelType, id: ModelLogId): Promise<void> {
    const metadataPath = this.getMetadataPath(type, id);
    const entriesPath = this.getPath(type, id);

    // Delete both files, ignoring NotFound errors
    try {
      await Deno.remove(metadataPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    try {
      await Deno.remove(entriesPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  nextId(): ModelLogId {
    return createModelLogId(crypto.randomUUID());
  }

  getPath(type: ModelType, id: ModelLogId): string {
    return join(this.getTypeDir(type), `${id}.log`);
  }

  private getMetadataPath(type: ModelType, id: ModelLogId): string {
    return join(this.getTypeDir(type), `${id}.yaml`);
  }

  private getTypeDir(type: ModelType): string {
    return join(this.repoDir, "data", "logs", type.toDirectoryPath());
  }
}
