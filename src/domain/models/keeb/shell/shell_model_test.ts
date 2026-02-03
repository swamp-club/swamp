import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createDefinitionId,
  Definition,
} from "../../../definitions/definition.ts";
import {
  SHELL_MODEL_TYPE,
  ShellDataAttributesSchema,
  ShellInputAttributesSchema,
  shellModel,
} from "./shell_model.ts";
import type { MethodContext } from "../../model.ts";
import type { UnifiedDataRepository } from "../../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../../definitions/repositories.ts";
import { generateDataId } from "../../../data/data_id.ts";

/**
 * Creates a mock UnifiedDataRepository for testing.
 */
function createMockDataRepo(): UnifiedDataRepository {
  return {
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
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
): MethodContext {
  return {
    repoDir: "/tmp",
    modelType: SHELL_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    ...overrides,
  };
}

/**
 * Helper to get attributes from a DataOutput by name.
 */
function getDataOutputAttributes(
  dataOutputs: { name: string; content: Uint8Array }[] | undefined,
  name: string,
): Record<string, unknown> | undefined {
  const dataOutput = dataOutputs?.find((d) => d.name.includes(name));
  if (!dataOutput) return undefined;
  const content = new TextDecoder().decode(dataOutput.content);
  return JSON.parse(content);
}

/**
 * Helper to get output log content as string.
 */
function getOutputLogContent(
  dataOutputs: { name: string; content: Uint8Array }[] | undefined,
): string {
  const logOutput = dataOutputs?.find((d) => d.name.includes("output"));
  if (!logOutput) return "";
  return new TextDecoder().decode(logOutput.content);
}

Deno.test("SHELL_MODEL_TYPE has correct normalized type", () => {
  assertEquals(SHELL_MODEL_TYPE.normalized, "keeb/shell");
});

Deno.test("shellModel has correct version", () => {
  assertEquals(shellModel.version, 1);
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
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "echo hello" },
  });

  const context = createTestContext();
  const result = await shellModel.methods.execute.execute(definition, context);

  // Check data attributes
  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  assertEquals(attrs?.exitCode, 0);
  assertEquals(attrs?.command, "echo hello");
  assertEquals(typeof attrs?.executedAt, "string");
  assertEquals(typeof attrs?.durationMs, "number");

  // Check output contains stdout
  const logContent = getOutputLogContent(result.dataOutputs);
  assertStringIncludes(logContent, "hello");
});

Deno.test("shellModel.methods.execute captures stderr", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "echo error >&2" },
  });

  const context = createTestContext();
  const result = await shellModel.methods.execute.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  assertEquals(attrs?.exitCode, 0);

  // Check output contains stderr
  const logContent = getOutputLogContent(result.dataOutputs);
  assertStringIncludes(logContent, "error");
});

Deno.test("shellModel.methods.execute captures exit code", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "exit 42" },
  });

  const context = createTestContext();
  const result = await shellModel.methods.execute.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  assertEquals(attrs?.exitCode, 42);
});

Deno.test("shellModel.methods.execute handles command failure gracefully", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "false" },
  });

  const context = createTestContext();
  const result = await shellModel.methods.execute.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  assertEquals(attrs?.exitCode, 1);
});

Deno.test("shellModel.methods.execute respects workingDir", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: {
      run: "pwd",
      workingDir: "/tmp",
    },
  });

  const context = createTestContext();
  const result = await shellModel.methods.execute.execute(definition, context);

  // Use realPathSync to handle symlinks (e.g., /tmp -> /private/tmp on macOS)
  const expectedPath = Deno.realPathSync("/tmp");
  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  assertEquals(attrs?.exitCode, 0);

  // Check output contains the working directory
  const logContent = getOutputLogContent(result.dataOutputs);
  assertStringIncludes(logContent, expectedPath);
});

Deno.test("shellModel.methods.execute respects env variables", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: {
      run: "echo $MY_TEST_VAR",
      env: { MY_TEST_VAR: "test_value" },
    },
  });

  const context = createTestContext();
  const result = await shellModel.methods.execute.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  assertEquals(attrs?.exitCode, 0);

  // Check output contains the env variable value
  const logContent = getOutputLogContent(result.dataOutputs);
  assertStringIncludes(logContent, "test_value");
});

Deno.test("shellModel.methods.execute handles pipes", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "echo 'hello world' | tr 'h' 'H'" },
  });

  const context = createTestContext();
  const result = await shellModel.methods.execute.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  assertEquals(attrs?.exitCode, 0);

  // Check output contains the piped output
  const logContent = getOutputLogContent(result.dataOutputs);
  assertStringIncludes(logContent, "Hello world");
});

Deno.test("shellModel.methods.execute handles complex commands", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "cd /tmp && pwd" },
  });

  const context = createTestContext();
  const result = await shellModel.methods.execute.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  assertEquals(attrs?.exitCode, 0);

  // Check output contains /tmp (cd /tmp && pwd outputs the logical path)
  const logContent = getOutputLogContent(result.dataOutputs);
  assertStringIncludes(logContent, "/tmp");
});

Deno.test("shellModel.methods.execute validates input attributes", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: { notRun: "value" },
  });

  const context = createTestContext();
  let error: Error | null = null;
  try {
    await shellModel.methods.execute.execute(definition, context);
  } catch (e) {
    error = e as Error;
  }

  assertEquals(error !== null, true);
});

Deno.test("shellModel.methods.execute rejects empty run command", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "" },
  });

  const context = createTestContext();
  let error: Error | null = null;
  try {
    await shellModel.methods.execute.execute(definition, context);
  } catch (e) {
    error = e as Error;
  }

  assertEquals(error !== null, true);
});

Deno.test("shellModel.methods.execute handles nonexistent command", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "nonexistent_command_12345" },
  });

  const context = createTestContext();
  const result = await shellModel.methods.execute.execute(definition, context);

  // Should return non-zero exit code and error in output
  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  assertEquals(attrs?.exitCode !== 0, true);

  // Check output contains error about nonexistent command
  const logContent = getOutputLogContent(result.dataOutputs);
  assertStringIncludes(logContent, "nonexistent_command_12345");
});

Deno.test("shellModel.methods.execute records execution duration", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "sleep 0.1" },
  });

  const context = createTestContext();
  const result = await shellModel.methods.execute.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  const durationMs = attrs?.durationMs as number;
  // Should be at least 100ms (sleep 0.1 seconds)
  assertEquals(durationMs >= 100, true);
});

Deno.test("shellModel.methods.execute returns dataOutputs", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "echo hello && echo error >&2" },
  });

  const context = createTestContext();
  const result = await shellModel.methods.execute.execute(definition, context);

  // Should have data outputs (data and output)
  assertEquals(result.dataOutputs !== undefined, true);
  assertEquals(result.dataOutputs!.length >= 1, true);

  // Output should contain both stdout and stderr
  const logContent = getOutputLogContent(result.dataOutputs);
  assertStringIncludes(logContent, "hello");
  assertStringIncludes(logContent, "error");
});

Deno.test("shellModel.methods.execute returns output for no output command", async () => {
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "true" }, // Command with no output
  });

  const context = createTestContext();
  const result = await shellModel.methods.execute.execute(definition, context);

  // Should still have data outputs
  assertEquals(result.dataOutputs !== undefined, true);
});

// Streaming tests
Deno.test("shellModel.methods.execute streams stdout when callback provided", async () => {
  const stdoutLines: string[] = [];
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "echo line1 && echo line2 && echo line3" },
  });

  const context = createTestContext({
    streaming: {
      onStdout: (line) => stdoutLines.push(line),
    },
  });
  const result = await shellModel.methods.execute.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  assertEquals(attrs?.exitCode, 0);
  // Should have captured all three lines
  assertEquals(stdoutLines.length, 3);
  assertEquals(stdoutLines[0], "line1");
  assertEquals(stdoutLines[1], "line2");
  assertEquals(stdoutLines[2], "line3");
});

Deno.test("shellModel.methods.execute streams stderr when callback provided", async () => {
  const stderrLines: string[] = [];
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "echo err1 >&2 && echo err2 >&2" },
  });

  const context = createTestContext({
    streaming: {
      onStderr: (line) => stderrLines.push(line),
    },
  });
  const result = await shellModel.methods.execute.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  assertEquals(attrs?.exitCode, 0);
  // Should have captured both lines
  assertEquals(stderrLines.length, 2);
  assertEquals(stderrLines[0], "err1");
  assertEquals(stderrLines[1], "err2");
});

Deno.test("shellModel.methods.execute streams both stdout and stderr simultaneously", async () => {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "echo stdout && echo stderr >&2" },
  });

  const context = createTestContext({
    streaming: {
      onStdout: (line) => stdoutLines.push(line),
      onStderr: (line) => stderrLines.push(line),
    },
  });
  const result = await shellModel.methods.execute.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs, "result");
  assertEquals(attrs?.exitCode, 0);
  assertEquals(stdoutLines.length, 1);
  assertEquals(stdoutLines[0], "stdout");
  assertEquals(stderrLines.length, 1);
  assertEquals(stderrLines[0], "stderr");
});

Deno.test("shellModel.methods.execute still populates dataOutputs when streaming", async () => {
  const stdoutLines: string[] = [];
  const definition = Definition.create({
    name: "test-shell",
    attributes: { run: "echo hello" },
  });

  const context = createTestContext({
    streaming: {
      onStdout: (line) => stdoutLines.push(line),
    },
  });
  const result = await shellModel.methods.execute.execute(definition, context);

  // Streaming callback should receive the output
  assertEquals(stdoutLines.length, 1);
  assertEquals(stdoutLines[0], "hello");

  // Data outputs should also contain the output
  const logContent = getOutputLogContent(result.dataOutputs);
  assertStringIncludes(logContent, "hello");
});
