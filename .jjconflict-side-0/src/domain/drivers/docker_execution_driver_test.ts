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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  DockerDriverConfigSchema,
  DockerExecutionDriver,
} from "./docker_execution_driver.ts";
import type { ExecutionRequest } from "./execution_driver.ts";

function createTestRequest(
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return {
    protocolVersion: 1,
    modelType: "test/model",
    modelId: "test-id",
    methodName: "create",
    globalArgs: {},
    methodArgs: { run: "echo hello" },
    definitionMeta: {
      id: "def-id",
      name: "test-def",
      version: 1,
      tags: {},
    },
    ...overrides,
  };
}

// --- Config validation ---

Deno.test("DockerDriverConfigSchema - missing image throws", () => {
  const result = DockerDriverConfigSchema.safeParse({});
  assertEquals(result.success, false);
  if (!result.success) {
    const imageIssue = result.error.issues.find((i) =>
      i.path.includes("image")
    );
    assertEquals(imageIssue !== undefined, true);
  }
});

Deno.test("DockerDriverConfigSchema - empty image throws", () => {
  const result = DockerDriverConfigSchema.safeParse({ image: "" });
  assertEquals(result.success, false);
});

Deno.test("DockerDriverConfigSchema - valid minimal config", () => {
  const result = DockerDriverConfigSchema.safeParse({ image: "node:18" });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.image, "node:18");
    assertEquals(result.data.command, "docker");
  }
});

Deno.test("DockerDriverConfigSchema - command defaults to docker", () => {
  const result = DockerDriverConfigSchema.safeParse({ image: "alpine" });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.command, "docker");
  }
});

Deno.test("DockerDriverConfigSchema - all optional fields", () => {
  const result = DockerDriverConfigSchema.safeParse({
    image: "node:18",
    command: "podman",
    timeout: 5000,
    network: "host",
    memory: "512m",
    cpus: "1.5",
    volumes: ["/tmp:/data", "/var:/var:ro"],
    env: { NODE_ENV: "production", DEBUG: "true" },
    extraArgs: ["--privileged", "--cap-add=NET_ADMIN"],
    bundleImage: "denoland/deno:alpine",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.command, "podman");
    assertEquals(result.data.timeout, 5000);
    assertEquals(result.data.network, "host");
    assertEquals(result.data.memory, "512m");
    assertEquals(result.data.cpus, "1.5");
    assertEquals(result.data.volumes, ["/tmp:/data", "/var:/var:ro"]);
    assertEquals(result.data.env, {
      NODE_ENV: "production",
      DEBUG: "true",
    });
    assertEquals(result.data.extraArgs, [
      "--privileged",
      "--cap-add=NET_ADMIN",
    ]);
    assertEquals(result.data.bundleImage, "denoland/deno:alpine");
  }
});

Deno.test("DockerDriverConfigSchema - negative timeout rejected", () => {
  const result = DockerDriverConfigSchema.safeParse({
    image: "node:18",
    timeout: -1,
  });
  assertEquals(result.success, false);
});

Deno.test("DockerDriverConfigSchema - zero timeout rejected", () => {
  const result = DockerDriverConfigSchema.safeParse({
    image: "node:18",
    timeout: 0,
  });
  assertEquals(result.success, false);
});

Deno.test("DockerExecutionDriver constructor - validates config", () => {
  assertThrows(
    () => new DockerExecutionDriver({}),
    Error,
  );
});

Deno.test("DockerExecutionDriver constructor - valid config", () => {
  const driver = new DockerExecutionDriver({ image: "alpine:latest" });
  assertEquals(driver.type, "docker");
});

// --- Command mode arg building ---

Deno.test("DockerExecutionDriver - base args include run --rm --name", () => {
  const driver = new DockerExecutionDriver({ image: "alpine" });
  const args = driver.buildCommandArgs("swamp-test123", "echo hi");

  assertEquals(args[0], "run");
  assertEquals(args[1], "--rm");
  assertEquals(args[2], "--name");
  assertEquals(args[3], "swamp-test123");
});

Deno.test("DockerExecutionDriver - image and command at end", () => {
  const driver = new DockerExecutionDriver({ image: "node:18" });
  const args = driver.buildCommandArgs("swamp-abc", "npm test");

  // Last args should be: image, sh, -c, commandString
  const len = args.length;
  assertEquals(args[len - 4], "node:18");
  assertEquals(args[len - 3], "sh");
  assertEquals(args[len - 2], "-c");
  assertEquals(args[len - 1], "npm test");
});

Deno.test("DockerExecutionDriver - network flag", () => {
  const driver = new DockerExecutionDriver({
    image: "alpine",
    network: "host",
  });
  const args = driver.buildCommandArgs("swamp-abc", "echo");
  const idx = args.indexOf("--network");
  assertEquals(idx !== -1, true);
  assertEquals(args[idx + 1], "host");
});

Deno.test("DockerExecutionDriver - memory flag", () => {
  const driver = new DockerExecutionDriver({
    image: "alpine",
    memory: "256m",
  });
  const args = driver.buildCommandArgs("swamp-abc", "echo");
  const idx = args.indexOf("--memory");
  assertEquals(idx !== -1, true);
  assertEquals(args[idx + 1], "256m");
});

Deno.test("DockerExecutionDriver - cpus flag", () => {
  const driver = new DockerExecutionDriver({
    image: "alpine",
    cpus: "2.0",
  });
  const args = driver.buildCommandArgs("swamp-abc", "echo");
  const idx = args.indexOf("--cpus");
  assertEquals(idx !== -1, true);
  assertEquals(args[idx + 1], "2.0");
});

Deno.test("DockerExecutionDriver - volume mounts", () => {
  const driver = new DockerExecutionDriver({
    image: "alpine",
    volumes: ["/host1:/container1", "/host2:/container2:ro"],
  });
  const args = driver.buildCommandArgs("swamp-abc", "echo");
  const volumeIndices = args.reduce<number[]>((acc, arg, i) => {
    if (arg === "-v") acc.push(i);
    return acc;
  }, []);
  assertEquals(volumeIndices.length, 2);
  assertEquals(args[volumeIndices[0] + 1], "/host1:/container1");
  assertEquals(args[volumeIndices[1] + 1], "/host2:/container2:ro");
});

Deno.test("DockerExecutionDriver - env vars", () => {
  const driver = new DockerExecutionDriver({
    image: "alpine",
    env: { FOO: "bar", BAZ: "qux" },
  });
  const args = driver.buildCommandArgs("swamp-abc", "echo");
  const envIndices = args.reduce<number[]>((acc, arg, i) => {
    if (arg === "-e") acc.push(i);
    return acc;
  }, []);
  assertEquals(envIndices.length, 2);
  const envValues = envIndices.map((i) => args[i + 1]);
  assertEquals(envValues.includes("FOO=bar"), true);
  assertEquals(envValues.includes("BAZ=qux"), true);
});

Deno.test("DockerExecutionDriver - extraArgs before image", () => {
  const driver = new DockerExecutionDriver({
    image: "alpine",
    extraArgs: ["--privileged", "--cap-add=SYS_ADMIN"],
  });
  const args = driver.buildCommandArgs("swamp-abc", "echo");
  const imageIdx = args.indexOf("alpine");
  const privIdx = args.indexOf("--privileged");
  const capIdx = args.indexOf("--cap-add=SYS_ADMIN");
  assertEquals(privIdx < imageIdx, true);
  assertEquals(capIdx < imageIdx, true);
});

Deno.test("DockerExecutionDriver - all flags combined", () => {
  const driver = new DockerExecutionDriver({
    image: "myimage:v1",
    network: "bridge",
    memory: "1g",
    cpus: "4",
    volumes: ["/data:/data"],
    env: { KEY: "val" },
    extraArgs: ["--read-only"],
  });
  const args = driver.buildCommandArgs("swamp-full", "ls -la");

  // Verify order: run --rm --name <name> [flags] <image> sh -c <cmd>
  assertEquals(args[0], "run");
  assertEquals(args[1], "--rm");
  assertEquals(args[args.length - 4], "myimage:v1");
  assertEquals(args[args.length - 3], "sh");
  assertEquals(args[args.length - 2], "-c");
  assertEquals(args[args.length - 1], "ls -la");

  // All flags present
  assertEquals(args.includes("--network"), true);
  assertEquals(args.includes("--memory"), true);
  assertEquals(args.includes("--cpus"), true);
  assertEquals(args.includes("-v"), true);
  assertEquals(args.includes("-e"), true);
  assertEquals(args.includes("--read-only"), true);
});

// --- buildDockerArgs backward compat ---

Deno.test("DockerExecutionDriver - buildDockerArgs delegates to buildCommandArgs", () => {
  const driver = new DockerExecutionDriver({ image: "alpine" });
  const a = driver.buildDockerArgs("name", "echo hi");
  const b = driver.buildCommandArgs("name", "echo hi");
  assertEquals(a, b);
});

// --- Bundle mode arg building ---

Deno.test("DockerExecutionDriver - bundle args include /swamp mount", () => {
  const driver = new DockerExecutionDriver({ image: "denoland/deno:alpine" });
  const args = driver.buildBundleArgs("swamp-bundle", "/tmp/test-dir");

  // Should have -v /tmp/test-dir:/swamp:ro
  const vIdx = args.findIndex((a, i) =>
    a === "-v" && args[i + 1]?.includes("/swamp:ro")
  );
  assertEquals(vIdx !== -1, true);
  assertStringIncludes(args[vIdx + 1], "/tmp/test-dir:/swamp:ro");
});

Deno.test("DockerExecutionDriver - bundle args end with deno run", () => {
  const driver = new DockerExecutionDriver({ image: "denoland/deno:alpine" });
  const args = driver.buildBundleArgs("swamp-bundle", "/tmp/test-dir");

  const len = args.length;
  assertEquals(args[len - 4], "deno");
  assertEquals(args[len - 3], "run");
  assertEquals(args[len - 2], "--allow-all");
  assertEquals(args[len - 1], "/swamp/runner.js");
});

Deno.test("DockerExecutionDriver - bundle args use bundleImage when set", () => {
  const driver = new DockerExecutionDriver({
    image: "alpine:latest",
    bundleImage: "denoland/deno:alpine",
  });
  const args = driver.buildBundleArgs("swamp-bundle", "/tmp/test-dir");

  // The image should be bundleImage, not the command-mode image
  const denoIdx = args.indexOf("deno");
  assertEquals(args[denoIdx - 1], "denoland/deno:alpine");
});

Deno.test("DockerExecutionDriver - bundle args fall back to image when no bundleImage", () => {
  const driver = new DockerExecutionDriver({
    image: "denoland/deno:alpine",
  });
  const args = driver.buildBundleArgs("swamp-bundle", "/tmp/test-dir");

  const denoIdx = args.indexOf("deno");
  assertEquals(args[denoIdx - 1], "denoland/deno:alpine");
});

Deno.test("DockerExecutionDriver - bundle args include user volumes", () => {
  const driver = new DockerExecutionDriver({
    image: "denoland/deno:alpine",
    volumes: ["/data:/data:ro"],
  });
  const args = driver.buildBundleArgs("swamp-bundle", "/tmp/test-dir");

  const volumeIndices = args.reduce<number[]>((acc, arg, i) => {
    if (arg === "-v") acc.push(i);
    return acc;
  }, []);
  // Should have both user volume and /swamp mount
  assertEquals(volumeIndices.length, 2);

  const volumeValues = volumeIndices.map((i) => args[i + 1]);
  assertEquals(volumeValues.some((v) => v === "/data:/data:ro"), true);
  assertEquals(volumeValues.some((v) => v.includes("/swamp:ro")), true);
});

// --- Mode detection ---

Deno.test("DockerExecutionDriver - request with bundle dispatches to bundle mode", async () => {
  const tmpDir = await Deno.makeTempDir();
  const scriptPath = `${tmpDir}/mock-docker`;

  // Mock script that outputs valid bundle JSON
  await Deno.writeTextFile(
    scriptPath,
    '#!/bin/sh\necho \'{"resources":[{"specName":"info","name":"info","data":{"hostname":"container"}}],"files":[]}\'\n',
  );
  await Deno.chmod(scriptPath, 0o755);

  try {
    const driver = new DockerExecutionDriver({
      image: "denoland/deno:alpine",
      command: scriptPath,
    });

    const bundle = new TextEncoder().encode("export const model = {};");
    const result = await driver.execute(
      createTestRequest({ methodArgs: {}, bundle }),
    );

    assertEquals(result.status, "success");
    assertEquals(result.outputs.length, 1);
    if (result.outputs[0].kind === "pending") {
      assertEquals(result.outputs[0].specName, "info");
      assertEquals(result.outputs[0].type, "resource");
      const text = new TextDecoder().decode(result.outputs[0].content);
      assertStringIncludes(text, "container");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("DockerExecutionDriver - request with run dispatches to command mode", async () => {
  const tmpDir = await Deno.makeTempDir();
  const scriptPath = `${tmpDir}/mock-docker`;

  await Deno.writeTextFile(
    scriptPath,
    '#!/bin/sh\necho \'{"id":"abc123"}\'\n',
  );
  await Deno.chmod(scriptPath, 0o755);

  try {
    const driver = new DockerExecutionDriver({
      image: "alpine",
      command: scriptPath,
    });

    const result = await driver.execute(createTestRequest());

    assertEquals(result.status, "success");
    assertEquals(result.outputs.length, 1);
    if (result.outputs[0].kind === "pending") {
      assertEquals(result.outputs[0].type, "resource");
      const text = new TextDecoder().decode(result.outputs[0].content);
      assertStringIncludes(text, "abc123");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("DockerExecutionDriver - request with neither bundle nor run returns error", async () => {
  const driver = new DockerExecutionDriver({
    image: "alpine",
    command: "echo",
  });

  const result = await driver.execute(
    createTestRequest({ methodArgs: {} }),
  );

  assertEquals(result.status, "error");
  assertStringIncludes(result.error!, "bundle");
  assertStringIncludes(result.error!, "run");
});

Deno.test("DockerExecutionDriver - request with both bundle and run prefers bundle", async () => {
  const tmpDir = await Deno.makeTempDir();
  const scriptPath = `${tmpDir}/mock-docker`;

  // Output bundle-style JSON
  await Deno.writeTextFile(
    scriptPath,
    '#!/bin/sh\necho \'{"resources":[{"specName":"test","name":"test","data":{"from":"bundle"}}],"files":[]}\'\n',
  );
  await Deno.chmod(scriptPath, 0o755);

  try {
    const driver = new DockerExecutionDriver({
      image: "denoland/deno:alpine",
      command: scriptPath,
    });

    const bundle = new TextEncoder().encode("export const model = {};");
    const result = await driver.execute(
      createTestRequest({ methodArgs: { run: "echo hello" }, bundle }),
    );

    assertEquals(result.status, "success");
    // Bundle mode produces parsed outputs
    if (result.outputs[0]?.kind === "pending") {
      assertEquals(result.outputs[0].specName, "test");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- Command mode execute with mock scripts ---

Deno.test("DockerExecutionDriver - execute success with mock script", async () => {
  const tmpDir = await Deno.makeTempDir();
  const scriptPath = `${tmpDir}/mock-docker`;

  await Deno.writeTextFile(
    scriptPath,
    '#!/bin/sh\necho "log: starting container" >&2\necho "log: running command" >&2\necho \'{"id":"abc123","status":"created"}\'\n',
  );
  await Deno.chmod(scriptPath, 0o755);

  try {
    const driver = new DockerExecutionDriver({
      image: "alpine",
      command: scriptPath,
    });

    const logLines: string[] = [];
    const result = await driver.execute(createTestRequest(), {
      onLog: (line) => logLines.push(line),
    });

    assertEquals(result.status, "success");
    assertEquals(result.logs.length, 2);
    assertStringIncludes(result.logs[0], "starting container");
    assertStringIncludes(result.logs[1], "running command");

    assertEquals(logLines.length, 2);

    assertEquals(result.outputs.length, 1);
    assertEquals(result.outputs[0].kind, "pending");
    if (result.outputs[0].kind === "pending") {
      assertEquals(result.outputs[0].type, "resource");
      assertEquals(result.outputs[0].specName, "create");
      const text = new TextDecoder().decode(result.outputs[0].content);
      assertStringIncludes(text, "abc123");

      assertEquals(result.outputs[0].metadata?.exitCode, 0);
      assertEquals(result.outputs[0].metadata?.command, "echo hello");
      assertEquals(typeof result.outputs[0].metadata?.durationMs, "number");
      assertEquals(typeof result.outputs[0].metadata?.stderr, "string");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("DockerExecutionDriver - execute failure returns error", async () => {
  const tmpDir = await Deno.makeTempDir();
  const scriptPath = `${tmpDir}/mock-docker`;

  await Deno.writeTextFile(
    scriptPath,
    '#!/bin/sh\necho "Error: container failed to start" >&2\nexit 1\n',
  );
  await Deno.chmod(scriptPath, 0o755);

  try {
    const driver = new DockerExecutionDriver({
      image: "alpine",
      command: scriptPath,
    });

    const result = await driver.execute(createTestRequest());

    assertEquals(result.status, "error");
    assertStringIncludes(result.error!, "container failed to start");
    assertEquals(result.outputs.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("DockerExecutionDriver - empty run arg returns error", async () => {
  const driver = new DockerExecutionDriver({
    image: "alpine",
    command: "echo",
  });

  const result = await driver.execute(
    createTestRequest({ methodArgs: { run: "  " } }),
  );

  assertEquals(result.status, "error");
  assertStringIncludes(result.error!, "run");
});

Deno.test({
  name: "DockerExecutionDriver - timeout produces error result",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    const scriptPath = `${tmpDir}/mock-docker`;

    await Deno.writeTextFile(
      scriptPath,
      "#!/bin/sh\nexec sleep 60\n",
    );
    await Deno.chmod(scriptPath, 0o755);

    try {
      const driver = new DockerExecutionDriver({
        image: "alpine",
        command: scriptPath,
        timeout: 200,
      });

      const result = await driver.execute(createTestRequest());

      assertEquals(result.status, "error");
      assertStringIncludes(result.error!, "timed out");
      assertStringIncludes(result.error!, "200ms");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test("DockerExecutionDriver - non-existent command returns error", async () => {
  const driver = new DockerExecutionDriver({
    image: "alpine",
    command: "/nonexistent/binary/path",
  });

  const result = await driver.execute(createTestRequest());

  assertEquals(result.status, "error");
  assertEquals(result.outputs.length, 0);
});

// --- Bundle mode execute with mock scripts ---

Deno.test("DockerExecutionDriver - bundle mode captures resources", async () => {
  const tmpDir = await Deno.makeTempDir();
  const scriptPath = `${tmpDir}/mock-docker`;

  // Mock outputs JSON with resources and files
  const output = JSON.stringify({
    resources: [
      { specName: "info", name: "system-info", data: { cpu: 4, mem: "8GB" } },
    ],
    files: [
      { specName: "log", name: "exec-log", content: btoa("log line 1\n") },
    ],
  });

  await Deno.writeTextFile(
    scriptPath,
    `#!/bin/sh\necho '${output}'\n`,
  );
  await Deno.chmod(scriptPath, 0o755);

  try {
    const driver = new DockerExecutionDriver({
      image: "denoland/deno:alpine",
      command: scriptPath,
    });

    const bundle = new TextEncoder().encode("export const model = {};");
    const result = await driver.execute(
      createTestRequest({ methodArgs: {}, bundle }),
    );

    assertEquals(result.status, "success");
    assertEquals(result.outputs.length, 2);

    // First output: resource
    const resOutput = result.outputs[0];
    assertEquals(resOutput.kind, "pending");
    if (resOutput.kind === "pending") {
      assertEquals(resOutput.type, "resource");
      assertEquals(resOutput.specName, "info");
      assertEquals(resOutput.name, "system-info");
      const data = JSON.parse(new TextDecoder().decode(resOutput.content));
      assertEquals(data.cpu, 4);
      assertEquals(data.mem, "8GB");
    }

    // Second output: file (base64 decoded)
    const fileOutput = result.outputs[1];
    assertEquals(fileOutput.kind, "pending");
    if (fileOutput.kind === "pending") {
      assertEquals(fileOutput.type, "file");
      assertEquals(fileOutput.specName, "log");
      assertEquals(fileOutput.name, "exec-log");
      const text = new TextDecoder().decode(fileOutput.content);
      assertEquals(text, "log line 1\n");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("DockerExecutionDriver - bundle mode captures stderr as logs", async () => {
  const tmpDir = await Deno.makeTempDir();
  const scriptPath = `${tmpDir}/mock-docker`;

  await Deno.writeTextFile(
    scriptPath,
    '#!/bin/sh\necho "[INFO] loading model" >&2\necho "[INFO] executing method" >&2\necho \'{"resources":[],"files":[]}\'\n',
  );
  await Deno.chmod(scriptPath, 0o755);

  try {
    const driver = new DockerExecutionDriver({
      image: "denoland/deno:alpine",
      command: scriptPath,
    });

    const logLines: string[] = [];
    const bundle = new TextEncoder().encode("export const model = {};");
    const result = await driver.execute(
      createTestRequest({ methodArgs: {}, bundle }),
      { onLog: (line) => logLines.push(line) },
    );

    assertEquals(result.status, "success");
    assertEquals(result.logs.length, 2);
    assertStringIncludes(result.logs[0], "loading model");
    assertStringIncludes(result.logs[1], "executing method");
    assertEquals(logLines.length, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("DockerExecutionDriver - bundle mode failure returns error", async () => {
  const tmpDir = await Deno.makeTempDir();
  const scriptPath = `${tmpDir}/mock-docker`;

  await Deno.writeTextFile(
    scriptPath,
    '#!/bin/sh\necho "Execution error: method not found" >&2\nexit 1\n',
  );
  await Deno.chmod(scriptPath, 0o755);

  try {
    const driver = new DockerExecutionDriver({
      image: "denoland/deno:alpine",
      command: scriptPath,
    });

    const bundle = new TextEncoder().encode("export const model = {};");
    const result = await driver.execute(
      createTestRequest({ methodArgs: {}, bundle }),
    );

    assertEquals(result.status, "error");
    assertStringIncludes(result.error!, "method not found");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("DockerExecutionDriver - bundle mode invalid JSON stdout fallback", async () => {
  const tmpDir = await Deno.makeTempDir();
  const scriptPath = `${tmpDir}/mock-docker`;

  // Output invalid JSON — should be returned as raw resource
  await Deno.writeTextFile(
    scriptPath,
    '#!/bin/sh\necho "not json output"\n',
  );
  await Deno.chmod(scriptPath, 0o755);

  try {
    const driver = new DockerExecutionDriver({
      image: "denoland/deno:alpine",
      command: scriptPath,
    });

    const bundle = new TextEncoder().encode("export const model = {};");
    const result = await driver.execute(
      createTestRequest({ methodArgs: {}, bundle }),
    );

    assertEquals(result.status, "success");
    assertEquals(result.outputs.length, 1);
    if (result.outputs[0].kind === "pending") {
      assertEquals(result.outputs[0].type, "resource");
      assertEquals(result.outputs[0].specName, "output");
      const text = new TextDecoder().decode(result.outputs[0].content);
      assertStringIncludes(text, "not json output");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
