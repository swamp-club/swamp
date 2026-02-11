import { assertEquals, assertStringIncludes } from "@std/assert";
import { createDefinitionId } from "../../../definitions/definition.ts";
import {
  SHELL_MODEL_TYPE,
  ShellDataAttributesSchema,
  type ShellInputAttributes,
  ShellInputAttributesSchema,
  shellModel,
} from "./shell_model.ts";
import type { DataHandle, DataWriter, MethodContext } from "../../model.ts";
import type { UnifiedDataRepository } from "../../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../../definitions/repositories.ts";
import { type DataId, generateDataId } from "../../../data/data_id.ts";
import { getLogger } from "@logtape/logtape";

/**
 * Stored result from mock data writer.
 */
interface MockWriterResult {
  handle: DataHandle;
  content: Uint8Array;
}

/**
 * Creates mock writeResource and createFileWriter functions that store written content in memory.
 */
function createMockWriters(): {
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  createFileWriter: (specName: string, name: string) => DataWriter;
  getResults: () => MockWriterResult[];
} {
  const results: MockWriterResult[] = [];
  const getResults = (): MockWriterResult[] => results;
  let nextId = 1;

  const writeResource = (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<DataHandle> => {
    const dataId = `mock-data-${nextId++}` as DataId;
    const content = new TextEncoder().encode(JSON.stringify(data));
    const handle: DataHandle = {
      name,
      specName,
      kind: "resource",
      dataId,
      version: 1,
      size: content.length,
      tags: {},
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: {},
        ownerDefinition: {
          definitionHash: "test-hash",
          ownerType: "model-method",
          ownerRef: "test",
        },
      },
    };
    results.push({ handle, content });
    return Promise.resolve(handle);
  };

  const createFileWriter = (specName: string, name: string): DataWriter => {
    const dataId = `mock-data-${nextId++}` as DataId;

    const buildHandle = (content: Uint8Array): DataHandle => ({
      name,
      specName,
      kind: "file",
      dataId,
      version: 1,
      size: content.length,
      tags: {},
      metadata: {
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: {},
        ownerDefinition: {
          definitionHash: "test-hash",
          ownerType: "model-method",
          ownerRef: "test",
        },
      },
    });

    return {
      dataId,
      name,
      writeAll(content: Uint8Array): Promise<DataHandle> {
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      writeText(text: string): Promise<DataHandle> {
        const content = new TextEncoder().encode(text);
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      writeLine(_line: string): Promise<void> {
        return Promise.resolve();
      },
      writeStream(
        _stream: ReadableStream<Uint8Array>,
      ): Promise<DataHandle> {
        const content = new Uint8Array();
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      getFilePath(): Promise<string> {
        return Promise.resolve("/tmp/mock");
      },
      finalize(): Promise<DataHandle> {
        const content = new Uint8Array();
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
    } as DataWriter;
  };

  return { writeResource, createFileWriter, getResults };
}

/**
 * Helper to get parsed JSON content from mock results by name.
 */
function getResultAttributes(
  results: MockWriterResult[],
  namePart: string,
): Record<string, unknown> | undefined {
  const result = results.find((r) => r.handle.name.includes(namePart));
  if (!result) return undefined;
  return JSON.parse(new TextDecoder().decode(result.content));
}

/**
 * Helper to get output log content as string.
 */
function getOutputLogContent(results: MockWriterResult[]): string {
  const logResult = results.find((r) =>
    r.handle.kind === "file" && r.handle.specName === "log"
  );
  if (!logResult) return "";
  return new TextDecoder().decode(logResult.content);
}

/**
 * Creates a mock UnifiedDataRepository for testing.
 */
function createMockDataRepo(): UnifiedDataRepository {
  return {
    findAllGlobal: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    removeLatestSymlink: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
  };
}

/**
 * Creates a mock DefinitionRepository for testing.
 */
function createMockDefinitionRepo(): DefinitionRepository {
  return {
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findByNameGlobal: () => Promise.resolve(null),
    findAllGlobal: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => createDefinitionId(crypto.randomUUID()),
    getPath: () => "",
  };
}

/**
 * Creates a test MethodContext with mocked repositories.
 */
function createTestContext(
  overrides?: Partial<MethodContext>,
): {
  context: MethodContext;
  getResults: () => MockWriterResult[];
} {
  const { writeResource, createFileWriter, getResults } = createMockWriters();
  const context: MethodContext = {
    repoDir: "/tmp",
    modelType: SHELL_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    globalArgs: {},
    definition: {
      id: crypto.randomUUID(),
      name: "test-shell",
      version: 1,
      tags: {},
    },
    methodName: "execute",
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    writeResource,
    createFileWriter,
    ...overrides,
  };
  return { context, getResults };
}

Deno.test("SHELL_MODEL_TYPE has correct normalized type", () => {
  assertEquals(SHELL_MODEL_TYPE.normalized, "keeb/shell");
});

Deno.test("shellModel has correct version", () => {
  assertEquals(shellModel.version, "2026.02.09.1");
});

Deno.test("shellModel.type equals SHELL_MODEL_TYPE", () => {
  assertEquals(shellModel.type.equals(SHELL_MODEL_TYPE), true);
});

// Input schema validation tests
Deno.test("ShellInputAttributesSchema validates run command", () => {
  const result = ShellInputAttributesSchema.safeParse({ run: "echo hello" });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.run, "echo hello");
  }
});

Deno.test("ShellInputAttributesSchema validates all optional fields", () => {
  const result = ShellInputAttributesSchema.safeParse({
    run: "echo hello",
    workingDir: "/tmp",
    timeout: 5000,
    env: { FOO: "bar" },
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.run, "echo hello");
    assertEquals(result.data.workingDir, "/tmp");
    assertEquals(result.data.timeout, 5000);
    assertEquals(result.data.env, { FOO: "bar" });
  }
});

Deno.test("ShellInputAttributesSchema rejects empty run command", () => {
  const result = ShellInputAttributesSchema.safeParse({ run: "" });
  assertEquals(result.success, false);
});

Deno.test("ShellInputAttributesSchema rejects missing run command", () => {
  const result = ShellInputAttributesSchema.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("ShellInputAttributesSchema rejects negative timeout", () => {
  const result = ShellInputAttributesSchema.safeParse({
    run: "echo hello",
    timeout: -1,
  });
  assertEquals(result.success, false);
});

Deno.test("ShellInputAttributesSchema rejects zero timeout", () => {
  const result = ShellInputAttributesSchema.safeParse({
    run: "echo hello",
    timeout: 0,
  });
  assertEquals(result.success, false);
});

// Data schema validation tests
Deno.test("ShellDataAttributesSchema validates correct data", () => {
  const result = ShellDataAttributesSchema.safeParse({
    exitCode: 0,
    executedAt: "2024-01-15T10:30:00.000Z",
    command: "echo hello",
    durationMs: 15,
  });
  assertEquals(result.success, true);
});

Deno.test("ShellDataAttributesSchema validates without durationMs", () => {
  const result = ShellDataAttributesSchema.safeParse({
    exitCode: 0,
    executedAt: "2024-01-15T10:30:00.000Z",
    command: "echo hello",
  });
  assertEquals(result.success, true);
});

Deno.test("ShellDataAttributesSchema rejects invalid timestamp", () => {
  const result = ShellDataAttributesSchema.safeParse({
    stdout: "",
    stderr: "",
    exitCode: 0,
    executedAt: "not-a-date",
    command: "echo hello",
  });
  assertEquals(result.success, false);
});

// Method definition tests
Deno.test("shellModel has execute method", () => {
  assertEquals("execute" in shellModel.methods, true);
  assertEquals(
    shellModel.methods.execute.description,
    "Execute the shell command and capture stdout, stderr, and exit code",
  );
});

// Execute method tests
Deno.test("shellModel.methods.execute runs simple command", async () => {
  const args: ShellInputAttributes = { run: "echo hello" };

  const { context, getResults } = createTestContext();
  await shellModel.methods.execute.execute(args, context);

  // Check data attributes
  const attrs = getResultAttributes(getResults(), "result");
  assertEquals(attrs?.exitCode, 0);
  assertEquals(attrs?.command, "echo hello");
  assertEquals(typeof attrs?.executedAt, "string");
  assertEquals(typeof attrs?.durationMs, "number");

  // Check output contains stdout
  const logContent = getOutputLogContent(getResults());
  assertStringIncludes(logContent, "hello");
});

Deno.test("shellModel.methods.execute captures stderr", async () => {
  const args: ShellInputAttributes = { run: "echo error >&2" };

  const { context, getResults } = createTestContext();
  await shellModel.methods.execute.execute(args, context);

  const attrs = getResultAttributes(getResults(), "result");
  assertEquals(attrs?.exitCode, 0);

  // Check output contains stderr
  const logContent = getOutputLogContent(getResults());
  assertStringIncludes(logContent, "error");
});

Deno.test("shellModel.methods.execute captures exit code", async () => {
  const args: ShellInputAttributes = { run: "exit 42" };

  const { context, getResults } = createTestContext();
  await shellModel.methods.execute.execute(args, context);

  const attrs = getResultAttributes(getResults(), "result");
  assertEquals(attrs?.exitCode, 42);
});

Deno.test("shellModel.methods.execute handles command failure gracefully", async () => {
  const args: ShellInputAttributes = { run: "false" };

  const { context, getResults } = createTestContext();
  await shellModel.methods.execute.execute(args, context);

  const attrs = getResultAttributes(getResults(), "result");
  assertEquals(attrs?.exitCode, 1);
});

Deno.test("shellModel.methods.execute respects workingDir", async () => {
  const args: ShellInputAttributes = {
    run: "pwd",
    workingDir: "/tmp",
  };

  const { context, getResults } = createTestContext();
  await shellModel.methods.execute.execute(args, context);

  // Use realPathSync to handle symlinks (e.g., /tmp -> /private/tmp on macOS)
  const expectedPath = Deno.realPathSync("/tmp");
  const attrs = getResultAttributes(getResults(), "result");
  assertEquals(attrs?.exitCode, 0);

  // Check output contains the working directory
  const logContent = getOutputLogContent(getResults());
  assertStringIncludes(logContent, expectedPath);
});

Deno.test("shellModel.methods.execute respects env variables", async () => {
  const args: ShellInputAttributes = {
    run: "echo $MY_TEST_VAR",
    env: { MY_TEST_VAR: "test_value" },
  };

  const { context, getResults } = createTestContext();
  await shellModel.methods.execute.execute(args, context);

  const attrs = getResultAttributes(getResults(), "result");
  assertEquals(attrs?.exitCode, 0);

  // Check output contains the env variable value
  const logContent = getOutputLogContent(getResults());
  assertStringIncludes(logContent, "test_value");
});

Deno.test("shellModel.methods.execute handles pipes", async () => {
  const args: ShellInputAttributes = { run: "echo 'hello world' | tr 'h' 'H'" };

  const { context, getResults } = createTestContext();
  await shellModel.methods.execute.execute(args, context);

  const attrs = getResultAttributes(getResults(), "result");
  assertEquals(attrs?.exitCode, 0);

  // Check output contains the piped output
  const logContent = getOutputLogContent(getResults());
  assertStringIncludes(logContent, "Hello world");
});

Deno.test("shellModel.methods.execute handles complex commands", async () => {
  const args: ShellInputAttributes = { run: "cd /tmp && pwd" };

  const { context, getResults } = createTestContext();
  await shellModel.methods.execute.execute(args, context);

  const attrs = getResultAttributes(getResults(), "result");
  assertEquals(attrs?.exitCode, 0);

  // Check output contains /tmp (cd /tmp && pwd outputs the logical path)
  const logContent = getOutputLogContent(getResults());
  assertStringIncludes(logContent, "/tmp");
});

Deno.test("ShellInputAttributesSchema rejects invalid attributes", () => {
  const result = ShellInputAttributesSchema.safeParse({ notRun: "value" });
  assertEquals(result.success, false);
});

Deno.test("ShellInputAttributesSchema rejects empty run command via schema", () => {
  const result = ShellInputAttributesSchema.safeParse({ run: "" });
  assertEquals(result.success, false);
});

Deno.test("shellModel.methods.execute handles nonexistent command", async () => {
  const args: ShellInputAttributes = { run: "nonexistent_command_12345" };

  const { context, getResults } = createTestContext();
  await shellModel.methods.execute.execute(args, context);

  // Should return non-zero exit code and error in output
  const attrs = getResultAttributes(getResults(), "result");
  assertEquals(attrs?.exitCode !== 0, true);

  // Check output contains error about nonexistent command
  const logContent = getOutputLogContent(getResults());
  assertStringIncludes(logContent, "nonexistent_command_12345");
});

Deno.test("shellModel.methods.execute records execution duration", async () => {
  const args: ShellInputAttributes = { run: "sleep 0.1" };

  const { context, getResults } = createTestContext();
  await shellModel.methods.execute.execute(args, context);

  const attrs = getResultAttributes(getResults(), "result");
  const durationMs = attrs?.durationMs as number;
  // Should be at least 100ms (sleep 0.1 seconds)
  assertEquals(durationMs >= 100, true);
});

Deno.test("shellModel.methods.execute returns dataHandles", async () => {
  const args: ShellInputAttributes = { run: "echo hello && echo error >&2" };

  const { context, getResults } = createTestContext();
  const result = await shellModel.methods.execute.execute(args, context);

  // Should have data handles (result and output)
  assertEquals(result.dataHandles !== undefined, true);
  assertEquals(result.dataHandles!.length >= 1, true);

  // Output should contain both stdout and stderr
  const logContent = getOutputLogContent(getResults());
  assertStringIncludes(logContent, "hello");
  assertStringIncludes(logContent, "error");
});

Deno.test("shellModel.methods.execute returns output for no output command", async () => {
  const args: ShellInputAttributes = { run: "true" }; // Command with no output

  const { context } = createTestContext();
  const result = await shellModel.methods.execute.execute(args, context);

  // Should still have data handles
  assertEquals(result.dataHandles !== undefined, true);
});
