import { z } from "zod";

/**
 * Branded type for ModelLog IDs.
 */
export type ModelLogId = string & { readonly _brand: unique symbol };

/**
 * Creates a ModelLogId from a string.
 */
export function createModelLogId(id: string): ModelLogId {
  return id as ModelLogId;
}

/**
 * Zod schema for a single log entry.
 * Simplified to store just the raw message string.
 */
export const LogEntrySchema = z.object({
  message: z.string(),
});

/**
 * Type representing a single log entry.
 */
export type LogEntryData = z.infer<typeof LogEntrySchema>;

/**
 * Zod schema for the core properties of a ModelLog.
 */
export const ModelLogSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  entries: z.array(LogEntrySchema).default([]),
});

/**
 * Type representing the data stored in a ModelLog.
 */
export type ModelLogData = z.infer<typeof ModelLogSchema>;

/**
 * A single log entry containing a raw message string.
 */
export class LogEntry {
  private constructor(
    readonly message: string,
  ) {}

  /**
   * Creates a new LogEntry instance.
   */
  static create(message: string): LogEntry {
    const validated = LogEntrySchema.parse({ message });
    return new LogEntry(validated.message);
  }

  /**
   * Reconstructs a LogEntry from persisted data.
   */
  static fromData(data: LogEntryData): LogEntry {
    const validated = LogEntrySchema.parse(data);
    return new LogEntry(validated.message);
  }

  /**
   * Converts the entry to a plain data object for persistence.
   */
  toData(): LogEntryData {
    return { message: this.message };
  }

  /**
   * Converts the entry to a plain text line for storage.
   * Returns just the raw message without JSON wrapping.
   */
  toJsonLine(): string {
    return this.message;
  }

  /**
   * Parses a LogEntry from a plain text line.
   */
  static fromJsonLine(line: string): LogEntry {
    return new LogEntry(line);
  }
}

/**
 * Properties required to create a new ModelLog.
 */
export interface CreateModelLogProps {
  id?: string;
  version?: number;
  createdAt?: Date;
  entries?: LogEntry[];
}

/**
 * ModelLog is an entity representing execution logs and output.
 *
 * Each log artifact has a unique ID (UUID), creation timestamp,
 * version, and an array of log entries. Supports streaming/async writes.
 *
 * Log entries are raw message strings - no timestamps, levels, or metadata
 * are added by swamp. This allows capturing raw output from external commands
 * like journalctl exactly as they appear.
 */
export class ModelLog {
  private constructor(
    readonly id: ModelLogId,
    readonly version: number,
    readonly createdAt: Date,
    private _entries: LogEntry[],
  ) {}

  /**
   * Creates a new ModelLog instance.
   *
   * @param props - Properties for the new log artifact
   * @returns A new ModelLog instance
   */
  static create(props: CreateModelLogProps): ModelLog {
    const id = props.id ?? crypto.randomUUID();
    const version = props.version ?? 1;
    const createdAt = props.createdAt ?? new Date();

    const validated = ModelLogSchema.parse({
      id,
      version,
      createdAt: createdAt.toISOString(),
      entries: (props.entries ?? []).map((e) => e.toData()),
    });

    return new ModelLog(
      createModelLogId(validated.id),
      validated.version,
      new Date(validated.createdAt),
      validated.entries.map((e) => LogEntry.fromData(e)),
    );
  }

  /**
   * Reconstructs a ModelLog from persisted data.
   *
   * @param data - The persisted data
   * @returns A ModelLog instance
   */
  static fromData(data: ModelLogData): ModelLog {
    const validated = ModelLogSchema.parse(data);
    return new ModelLog(
      createModelLogId(validated.id),
      validated.version,
      new Date(validated.createdAt),
      validated.entries.map((e) => LogEntry.fromData(e)),
    );
  }

  /**
   * Returns a copy of the entries.
   */
  get entries(): LogEntry[] {
    return [...this._entries];
  }

  /**
   * Returns the number of entries.
   */
  get entryCount(): number {
    return this._entries.length;
  }

  /**
   * Appends a new log entry.
   */
  append(entry: LogEntry): void {
    this._entries.push(entry);
  }

  /**
   * Appends a new log entry by creating it from a message string.
   */
  log(message: string): void {
    this.append(LogEntry.create(message));
  }

  /**
   * Gets the last N entries.
   */
  lastEntries(count: number): LogEntry[] {
    if (count >= this._entries.length) {
      return [...this._entries];
    }
    return this._entries.slice(-count);
  }

  /**
   * Converts the log artifact to a plain data object for persistence.
   */
  toData(): ModelLogData {
    return {
      id: this.id,
      version: this.version,
      createdAt: this.createdAt.toISOString(),
      entries: this._entries.map((e) => e.toData()),
    };
  }

  /**
   * Converts entries to plain text lines format for streaming persistence.
   * Each entry is stored as a raw line.
   */
  toJsonLines(): string {
    return this._entries.map((e) => e.toJsonLine()).join("\n");
  }

  /**
   * Creates a ModelLog from plain text lines format.
   */
  static fromJsonLines(
    id: string,
    version: number,
    createdAt: Date,
    lines: string,
  ): ModelLog {
    const entries = lines
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => LogEntry.fromJsonLine(line));

    return new ModelLog(
      createModelLogId(id),
      version,
      createdAt,
      entries,
    );
  }
}
