import { assertEquals, assertStringIncludes } from "@std/assert";
import { ModelInput } from "../../model_input.ts";
import {
  SHELL_MODEL_TYPE,
  ShellInputAttributesSchema,
  shellModel,
  ShellResourceAttributesSchema,
} from "./shell_model.ts";

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

// Resource schema validation tests
Deno.test("ShellResourceAttributesSchema validates correct data", () => {
  const result = ShellResourceAttributesSchema.safeParse({
    stdout: "hello\n",
    stderr: "",
    exitCode: 0,
    executedAt: "2024-01-15T10:30:00.000Z",
    command: "echo hello",
    durationMs: 15,
  });
  assertEquals(result.success, true);
});

Deno.test("ShellResourceAttributesSchema validates without durationMs", () => {
  const result = ShellResourceAttributesSchema.safeParse({
    stdout: "hello\n",
    stderr: "",
    exitCode: 0,
    executedAt: "2024-01-15T10:30:00.000Z",
    command: "echo hello",
  });
  assertEquals(result.success, true);
});

Deno.test("ShellResourceAttributesSchema rejects invalid timestamp", () => {
  const result = ShellResourceAttributesSchema.safeParse({
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
  const input = ModelInput.create({
    name: "test-shell",
    attributes: { run: "echo hello" },
  });

  const result = await shellModel.methods.execute.execute(input, {
    repoDir: "/tmp",
  });

  assertEquals(result.resource.attributes.stdout, "hello\n");
  assertEquals(result.resource.attributes.stderr, "");
  assertEquals(result.resource.attributes.exitCode, 0);
  assertEquals(result.resource.attributes.command, "echo hello");
  assertEquals(typeof result.resource.attributes.executedAt, "string");
  assertEquals(typeof result.resource.attributes.durationMs, "number");
});

Deno.test("shellModel.methods.execute captures stderr", async () => {
  const input = ModelInput.create({
    name: "test-shell",
    attributes: { run: "echo error >&2" },
  });

  const result = await shellModel.methods.execute.execute(input, {
    repoDir: "/tmp",
  });

  assertEquals(result.resource.attributes.stdout, "");
  assertEquals(result.resource.attributes.stderr, "error\n");
  assertEquals(result.resource.attributes.exitCode, 0);
});

Deno.test("shellModel.methods.execute captures exit code", async () => {
  const input = ModelInput.create({
    name: "test-shell",
    attributes: { run: "exit 42" },
  });

  const result = await shellModel.methods.execute.execute(input, {
    repoDir: "/tmp",
  });

  assertEquals(result.resource.attributes.exitCode, 42);
});

Deno.test("shellModel.methods.execute handles command failure gracefully", async () => {
  const input = ModelInput.create({
    name: "test-shell",
    attributes: { run: "false" },
  });

  const result = await shellModel.methods.execute.execute(input, {
    repoDir: "/tmp",
  });

  assertEquals(result.resource.attributes.exitCode, 1);
});

Deno.test("shellModel.methods.execute respects workingDir", async () => {
  const input = ModelInput.create({
    name: "test-shell",
    attributes: {
      run: "pwd",
      workingDir: "/tmp",
    },
  });

  const result = await shellModel.methods.execute.execute(input, {
    repoDir: "/tmp",
  });

  // Use realPathSync to handle symlinks (e.g., /tmp -> /private/tmp on macOS)
  const expectedPath = Deno.realPathSync("/tmp");
  assertEquals(result.resource.attributes.stdout, `${expectedPath}\n`);
  assertEquals(result.resource.attributes.exitCode, 0);
});

Deno.test("shellModel.methods.execute respects env variables", async () => {
  const input = ModelInput.create({
    name: "test-shell",
    attributes: {
      run: "echo $MY_TEST_VAR",
      env: { MY_TEST_VAR: "test_value" },
    },
  });

  const result = await shellModel.methods.execute.execute(input, {
    repoDir: "/tmp",
  });

  assertEquals(result.resource.attributes.stdout, "test_value\n");
  assertEquals(result.resource.attributes.exitCode, 0);
});

Deno.test("shellModel.methods.execute handles pipes", async () => {
  const input = ModelInput.create({
    name: "test-shell",
    attributes: { run: "echo 'hello world' | tr 'h' 'H'" },
  });

  const result = await shellModel.methods.execute.execute(input, {
    repoDir: "/tmp",
  });

  assertEquals(result.resource.attributes.stdout, "Hello world\n");
  assertEquals(result.resource.attributes.exitCode, 0);
});

Deno.test("shellModel.methods.execute handles complex commands", async () => {
  const input = ModelInput.create({
    name: "test-shell",
    attributes: { run: "cd /tmp && pwd" },
  });

  const result = await shellModel.methods.execute.execute(input, {
    repoDir: "/tmp",
  });

  // cd /tmp && pwd outputs the logical path, not the physical path
  assertEquals(result.resource.attributes.stdout, "/tmp\n");
  assertEquals(result.resource.attributes.exitCode, 0);
});

Deno.test("shellModel.methods.execute validates input attributes", async () => {
  const input = ModelInput.create({
    name: "test-shell",
    attributes: { notRun: "value" },
  });

  let error: Error | null = null;
  try {
    await shellModel.methods.execute.execute(input, { repoDir: "/tmp" });
  } catch (e) {
    error = e as Error;
  }

  assertEquals(error !== null, true);
});

Deno.test("shellModel.methods.execute rejects empty run command", async () => {
  const input = ModelInput.create({
    name: "test-shell",
    attributes: { run: "" },
  });

  let error: Error | null = null;
  try {
    await shellModel.methods.execute.execute(input, { repoDir: "/tmp" });
  } catch (e) {
    error = e as Error;
  }

  assertEquals(error !== null, true);
});

Deno.test("shellModel.methods.execute handles nonexistent command", async () => {
  const input = ModelInput.create({
    name: "test-shell",
    attributes: { run: "nonexistent_command_12345" },
  });

  const result = await shellModel.methods.execute.execute(input, {
    repoDir: "/tmp",
  });

  // Should return non-zero exit code and error in stderr
  assertEquals(result.resource.attributes.exitCode !== 0, true);
  assertStringIncludes(
    result.resource.attributes.stderr as string,
    "nonexistent_command_12345",
  );
});

Deno.test("shellModel.methods.execute records execution duration", async () => {
  const input = ModelInput.create({
    name: "test-shell",
    attributes: { run: "sleep 0.1" },
  });

  const result = await shellModel.methods.execute.execute(input, {
    repoDir: "/tmp",
  });

  const durationMs = result.resource.attributes.durationMs as number;
  // Should be at least 100ms (sleep 0.1 seconds)
  assertEquals(durationMs >= 100, true);
});
