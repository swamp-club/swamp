// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import type {
  DataHandle,
  DataHandleMetadata,
  DataWriter,
  DefinitionInfo,
  LogLevel,
  MethodContext,
  MethodExecutionEvent,
} from "./types.ts";
import { createExtensionCelEnvironment } from "./_cel_environment.ts";

/** A resource captured by the test context's writeResource. */
export interface WrittenResource {
  specName: string;
  name: string;
  data: Record<string, unknown>;
  handle: DataHandle;
}

/** A file captured by the test context's createFileWriter. */
export interface WrittenFile {
  specName: string;
  name: string;
  content: Uint8Array;
  handle: DataHandle;
}

/** A log entry captured by the test context's logger. */
export interface CapturedLog {
  level: LogLevel;
  message: string;
  args: unknown[];
}

/** Options for creating a test context. */
export interface ModelTestContextOptions {
  /** Global arguments passed to the execute function (default: {}). */
  globalArgs?: Record<string, unknown>;
  /** Definition metadata overrides. */
  definition?: Partial<DefinitionInfo>;
  /** Method name (default: "run"). */
  methodName?: string;
  /** Repository directory path (default: "/tmp/swamp-test"). */
  repoDir?: string;
  /** Abort signal (default: never-aborted). */
  signal?: AbortSignal;
  /**
   * Pre-seed stored resources so `readResource` returns them.
   *
   * Keys are **instance names** (the `name` parameter from `writeResource`,
   * not the `specName`). For example, if your model writes with
   * `writeResource("state", "main", data)`, seed with `{ "main": data }`.
   */
  storedResources?: Record<string, Record<string, unknown>>;
  /**
   * Optional callback for domain events emitted during execution.
   * If provided, this is set as context.onEvent AND events are captured
   * for inspection via getEvents().
   */
  onEvent?: (event: MethodExecutionEvent) => void;
}

/** The return value from createModelTestContext. */
export interface ModelTestContextResult {
  /** The MethodContext to pass to your execute function. */
  context: MethodContext;
  /** Returns all resources written via writeResource during execution. */
  getWrittenResources(): WrittenResource[];
  /** Returns all files written via createFileWriter during execution. */
  getWrittenFiles(): WrittenFile[];
  /** Returns all log entries captured during execution. */
  getLogs(): CapturedLog[];
  /** Returns log entries filtered by level. */
  getLogsByLevel(level: LogLevel): CapturedLog[];
  /** Returns all events emitted via context.onEvent during execution. */
  getEvents(): MethodExecutionEvent[];
}

/**
 * Creates a test context for unit testing extension model execute functions.
 *
 * The returned context has in-memory implementations of writeResource,
 * readResource, and createFileWriter. All written data and log output
 * can be inspected via the returned helper functions.
 *
 * ```typescript
 * import { createModelTestContext } from "@systeminit/swamp-testing";
 * import { model } from "./my_model.ts";
 *
 * Deno.test("run method writes expected resource", async () => {
 *   const { context, getWrittenResources } = createModelTestContext({
 *     globalArgs: { message: "hello" },
 *   });
 *
 *   await model.methods.run.execute({}, context);
 *
 *   const resources = getWrittenResources();
 *   assertEquals(resources.length, 1);
 *   assertEquals(resources[0].data.message, "HELLO");
 * });
 * ```
 */
export function createModelTestContext(
  options?: ModelTestContextOptions,
): ModelTestContextResult {
  const writtenResources: WrittenResource[] = [];
  const writtenFiles: WrittenFile[] = [];
  const logs: CapturedLog[] = [];
  const events: MethodExecutionEvent[] = [];
  let nextId = 1;

  const storedResources = new Map<string, Record<string, unknown>>(
    Object.entries(options?.storedResources ?? {}),
  );

  const definition: DefinitionInfo = {
    id: options?.definition?.id ?? crypto.randomUUID(),
    name: options?.definition?.name ?? "test-instance",
    version: options?.definition?.version ?? 1,
    tags: options?.definition?.tags ?? {},
  };

  function makeMetadata(
    kind: "resource" | "file",
    contentType?: string,
  ): DataHandleMetadata {
    return {
      contentType: contentType ??
        (kind === "resource" ? "application/json" : "application/octet-stream"),
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: { type: kind },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${definition.name}/${options?.methodName ?? "run"}`,
      },
    };
  }

  function allocateDataId(): string {
    return `test-data-${nextId++}`;
  }

  function makeHandle(
    specName: string,
    name: string,
    kind: "resource" | "file",
    size: number,
    dataId: string,
    contentType?: string,
  ): DataHandle {
    return {
      name,
      specName,
      kind,
      dataId,
      version: 1,
      size,
      tags: {},
      metadata: makeMetadata(kind, contentType),
    };
  }

  const writeResource = (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<DataHandle> => {
    const content = new TextEncoder().encode(JSON.stringify(data));
    const handle = makeHandle(
      specName,
      name,
      "resource",
      content.length,
      allocateDataId(),
    );
    writtenResources.push({ specName, name, data, handle });
    // Also store so subsequent readResource calls can find it
    storedResources.set(name, data);
    return Promise.resolve(handle);
  };

  const readResource = (
    instanceName: string,
    _version?: number,
  ): Promise<Record<string, unknown> | null> => {
    if (typeof _version === "string") {
      throw new Error(
        `readResource(instanceName, version?) received a string as version: "${_version}". ` +
          `Unlike writeResource(specName, name, data), readResource does not take a specName — ` +
          `the first argument is the instance name (the "name" from writeResource). ` +
          `Use readResource("${_version}") instead of readResource("${instanceName}", "${_version}").`,
      );
    }
    const data = storedResources.get(instanceName) ?? null;
    return Promise.resolve(data ? structuredClone(data) : null);
  };

  const createFileWriter = (specName: string, name: string): DataWriter => {
    const dataId = allocateDataId();
    const lines: string[] = [];

    function capture(content: Uint8Array): DataHandle {
      const handle = makeHandle(specName, name, "file", content.length, dataId);
      writtenFiles.push({ specName, name, content, handle });
      return handle;
    }

    return {
      dataId,
      name,
      writeAll(content: Uint8Array): Promise<DataHandle> {
        return Promise.resolve(capture(content));
      },
      writeText(text: string): Promise<DataHandle> {
        return Promise.resolve(
          capture(new TextEncoder().encode(text)),
        );
      },
      writeLine(line: string): Promise<void> {
        lines.push(line);
        return Promise.resolve();
      },
      async writeStream(
        stream: ReadableStream<Uint8Array>,
        _options?: { onLine?: (line: string) => void },
      ): Promise<DataHandle> {
        const chunks: Uint8Array[] = [];
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        return capture(merged);
      },
      getFilePath(): Promise<string> {
        return Promise.resolve(`/tmp/swamp-test/${dataId}`);
      },
      finalize(): Promise<DataHandle> {
        const content = new TextEncoder().encode(lines.join("\n"));
        return Promise.resolve(capture(content));
      },
    };
  };

  function captureLog(level: LogLevel, message: string, args: unknown[]) {
    logs.push({ level, message, args });
  }

  const logger = {
    debug(message: string, ...args: unknown[]) {
      captureLog("debug", message, args);
    },
    info(message: string, ...args: unknown[]) {
      captureLog("info", message, args);
    },
    warn(message: string, ...args: unknown[]) {
      captureLog("warning", message, args);
    },
    error(message: string, ...args: unknown[]) {
      captureLog("error", message, args);
    },
    fatal(message: string, ...args: unknown[]) {
      captureLog("fatal", message, args);
    },
  };

  const onEvent = (event: MethodExecutionEvent) => {
    events.push(event);
    options?.onEvent?.(event);
  };

  const context: MethodContext = {
    signal: options?.signal ?? new AbortController().signal,
    repoDir: options?.repoDir ?? "/tmp/swamp-test",
    globalArgs: options?.globalArgs ?? {},
    definition,
    methodName: options?.methodName ?? "run",
    logger,
    writeResource,
    readResource,
    createFileWriter,
    createCelEnvironment: createExtensionCelEnvironment,
    onEvent,
  };

  return {
    context,
    getWrittenResources: () => [...writtenResources],
    getWrittenFiles: () => [...writtenFiles],
    getLogs: () => [...logs],
    getLogsByLevel: (level: LogLevel) => logs.filter((l) => l.level === level),
    getEvents: () => [...events],
  };
}
