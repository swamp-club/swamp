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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { assertNotEquals } from "@std/assert/not-equals";
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
import { SecretRedactor } from "../../../secrets/mod.ts";

/**
 * Wraps `Deno.test` with a Windows skip. The `shellModel.methods.execute`
 * tests below shell out to POSIX-style commands (`echo`, `false`,
 * `>&2`, `$VAR`, pipes, `/tmp` paths). On native Windows hosts where
 * `selectShellStrategy()` returns `PowerShellStrategy`, those
 * invocations wouldn't run as written. PR 3 of the Windows shell
 * series will add PowerShell-aware variants and re-enable these.
 */
function posixOnlyTest(
  name: string,
  fn: () => Promise<void> | void,
): void {
  Deno.test({ name, ignore: Deno.build.os === "windows", fn });
}

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
    removeLatestMarker: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
    getLatestVersionSync: () => null,
    findByNameSync: () => null,
    listVersionsSync: () => [],
    getContentSync: () => null,
    findAllForModelSync: () => [],
    findAllGlobalSync: () => [],
    rename: () => {
      throw new Error("not implemented");
    },
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
    signal: new AbortController().signal,
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
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
    ...overrides,
  };
  return { context, getResults };
}

Deno.test("SHELL_MODEL_TYPE has correct normalized type", () => {
  assertEquals(SHELL_MODEL_TYPE.normalized, "command/shell");
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
posixOnlyTest("shellModel.methods.execute runs simple command", async () => {
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

posixOnlyTest("shellModel.methods.execute captures stderr", async () => {
  const args: ShellInputAttributes = { run: "echo error >&2" };

  const { context, getResults } = createTestContext();
  await shellModel.methods.execute.execute(args, context);

  const attrs = getResultAttributes(getResults(), "result");
  assertEquals(attrs?.exitCode, 0);

  // Check output contains stderr
  const logContent = getOutputLogContent(getResults());
  assertStringIncludes(logContent, "error");
});

posixOnlyTest(
  "shellModel.methods.execute throws on non-zero exit code",
  async () => {
    const args: ShellInputAttributes = { run: "exit 42" };

    const { context } = createTestContext();
    await assertRejects(
      () => shellModel.methods.execute.execute(args, context),
      Error,
      "Command exited with code 42",
    );
  },
);

posixOnlyTest(
  "shellModel.methods.execute throws on command failure",
  async () => {
    const args: ShellInputAttributes = { run: "false" };

    const { context } = createTestContext();
    await assertRejects(
      () => shellModel.methods.execute.execute(args, context),
      Error,
      "Command exited with code 1",
    );
  },
);

Deno.test({
  name: "shellModel.methods.execute respects workingDir",
  // Hardcoded POSIX path (`/tmp`) and shell builtin (`pwd`).
  ignore: Deno.build.os === "windows",
  fn: async () => {
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
  },
});

posixOnlyTest("shellModel.methods.execute respects env variables", async () => {
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

posixOnlyTest("shellModel.methods.execute handles pipes", async () => {
  const args: ShellInputAttributes = { run: "echo 'hello world' | tr 'h' 'H'" };

  const { context, getResults } = createTestContext();
  await shellModel.methods.execute.execute(args, context);

  const attrs = getResultAttributes(getResults(), "result");
  assertEquals(attrs?.exitCode, 0);

  // Check output contains the piped output
  const logContent = getOutputLogContent(getResults());
  assertStringIncludes(logContent, "Hello world");
});

posixOnlyTest(
  "shellModel.methods.execute handles complex commands",
  async () => {
    const args: ShellInputAttributes = { run: "cd /tmp && pwd" };

    const { context, getResults } = createTestContext();
    await shellModel.methods.execute.execute(args, context);

    const attrs = getResultAttributes(getResults(), "result");
    assertEquals(attrs?.exitCode, 0);

    // Check output contains /tmp (cd /tmp && pwd outputs the logical path)
    const logContent = getOutputLogContent(getResults());
    assertStringIncludes(logContent, "/tmp");
  },
);

Deno.test("ShellInputAttributesSchema rejects invalid attributes", () => {
  const result = ShellInputAttributesSchema.safeParse({ notRun: "value" });
  assertEquals(result.success, false);
});

Deno.test("ShellInputAttributesSchema rejects empty run command via schema", () => {
  const result = ShellInputAttributesSchema.safeParse({ run: "" });
  assertEquals(result.success, false);
});

posixOnlyTest(
  "shellModel.methods.execute throws on nonexistent command",
  async () => {
    const args: ShellInputAttributes = { run: "nonexistent_command_12345" };

    const { context } = createTestContext();
    await assertRejects(
      () => shellModel.methods.execute.execute(args, context),
      Error,
    );
  },
);

posixOnlyTest(
  "shellModel.methods.execute records execution duration",
  async () => {
    const args: ShellInputAttributes = { run: "sleep 0.1" };

    const { context, getResults } = createTestContext();
    await shellModel.methods.execute.execute(args, context);

    const attrs = getResultAttributes(getResults(), "result");
    const durationMs = attrs?.durationMs as number;
    // Should be at least 100ms (sleep 0.1 seconds)
    assertEquals(durationMs >= 100, true);
  },
);

posixOnlyTest("shellModel.methods.execute returns dataHandles", async () => {
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

posixOnlyTest(
  "shellModel.methods.execute returns output for no output command",
  async () => {
    const args: ShellInputAttributes = { run: "true" }; // Command with no output

    const { context } = createTestContext();
    const result = await shellModel.methods.execute.execute(args, context);

    // Should still have data handles
    assertEquals(result.dataHandles !== undefined, true);
  },
);

// Secret redaction tests
posixOnlyTest(
  "shellModel.methods.execute redacts secrets from stdout in result attributes",
  async () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("super-secret-value");

    const args: ShellInputAttributes = { run: "echo super-secret-value" };
    const { context, getResults } = createTestContext({ redactor });
    await shellModel.methods.execute.execute(args, context);

    const attrs = getResultAttributes(getResults(), "result");
    assertNotEquals(attrs?.stdout, undefined);
    assertStringIncludes(attrs?.stdout as string, "***");
    assertEquals(
      (attrs?.stdout as string).includes("super-secret-value"),
      false,
    );
  },
);

posixOnlyTest(
  "shellModel.methods.execute redacts secrets from stderr in result attributes",
  async () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("stderr-secret");

    const args: ShellInputAttributes = { run: "echo stderr-secret >&2" };
    const { context, getResults } = createTestContext({ redactor });
    await shellModel.methods.execute.execute(args, context);

    const attrs = getResultAttributes(getResults(), "result");
    assertNotEquals(attrs?.stderr, undefined);
    assertStringIncludes(attrs?.stderr as string, "***");
    assertEquals((attrs?.stderr as string).includes("stderr-secret"), false);
  },
);

posixOnlyTest(
  "shellModel.methods.execute redacts secrets from output log file",
  async () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("log-file-secret");

    const args: ShellInputAttributes = {
      run: "echo log-file-secret && echo log-file-secret >&2",
    };
    const { context, getResults } = createTestContext({ redactor });
    await shellModel.methods.execute.execute(args, context);

    const logContent = getOutputLogContent(getResults());
    assertStringIncludes(logContent, "***");
    assertEquals(logContent.includes("log-file-secret"), false);
  },
);

posixOnlyTest(
  "shellModel.methods.execute redacts secrets from command in result attributes",
  async () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("command-secret");

    const args: ShellInputAttributes = { run: "echo command-secret" };
    const { context, getResults } = createTestContext({ redactor });
    await shellModel.methods.execute.execute(args, context);

    const attrs = getResultAttributes(getResults(), "result");
    assertNotEquals(attrs?.command, undefined);
    assertStringIncludes(attrs?.command as string, "***");
    assertEquals((attrs?.command as string).includes("command-secret"), false);
  },
);

posixOnlyTest(
  "shellModel.methods.execute redacts secrets from error messages on failure",
  async () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("error-secret");

    // Use a command that will produce an error containing the secret
    const args: ShellInputAttributes = {
      run: "echo error-secret >&2 && exit 1",
    };
    const { context } = createTestContext({ redactor });
    await assertRejects(
      () => shellModel.methods.execute.execute(args, context),
      Error,
      "Command exited with code 1",
    );
  },
);

posixOnlyTest(
  "shellModel.methods.execute ignoreExitCode suppresses throw",
  async () => {
    const args: ShellInputAttributes = { run: "exit 42", ignoreExitCode: true };

    const { context, getResults } = createTestContext();
    const result = await shellModel.methods.execute.execute(args, context);

    const attrs = getResultAttributes(getResults(), "result");
    assertEquals(attrs?.exitCode, 42);
    assertEquals(result.dataHandles !== undefined, true);
  },
);

posixOnlyTest(
  "shellModel.methods.execute exit code 0 returns normally",
  async () => {
    const args: ShellInputAttributes = { run: "true" };

    const { context, getResults } = createTestContext();
    const result = await shellModel.methods.execute.execute(args, context);

    const attrs = getResultAttributes(getResults(), "result");
    assertEquals(attrs?.exitCode, 0);
    assertEquals(result.dataHandles !== undefined, true);
  },
);

posixOnlyTest(
  "shellModel.methods.execute does not persist data on failure",
  async () => {
    const args: ShellInputAttributes = {
      run: "echo 'some output' && exit 1",
    };

    const { context, getResults } = createTestContext();
    await assertRejects(
      () => shellModel.methods.execute.execute(args, context),
      Error,
      "Command exited with code 1",
    );

    // No data should be written for a failed command
    assertEquals(getResults().length, 0);
  },
);
