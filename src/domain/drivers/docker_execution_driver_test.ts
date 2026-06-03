// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import { join } from "@std/path";
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

/**
 * Creates a mock "docker" command for tests by writing a TypeScript mock
 * file plus a tiny platform-specific launcher (`.cmd` on Windows, a `chmod
 * +x` shell script on POSIX). Both launchers `deno run` the same TypeScript
 * source, so test logic stays portable across platforms.
 *
 * Returns the absolute launcher path; pass it as the docker driver's
 * `command` field to substitute the mock for the real binary.
 */
async function createMockDriverCommand(
  tmpDir: string,
  mockTsBody: string,
): Promise<string> {
  const mockTsPath = join(tmpDir, "mock.ts");
  await Deno.writeTextFile(mockTsPath, mockTsBody);

  const denoBin = Deno.execPath();

  if (Deno.build.os === "windows") {
    const launcherPath = join(tmpDir, "mock-docker.cmd");
    // %* forwards all docker args; the mock TS itself ignores them.
    const launcherBody =
      `@echo off\r\n"${denoBin}" run --quiet --allow-all "${mockTsPath}" %*\r\n`;
    await Deno.writeTextFile(launcherPath, launcherBody);
    return launcherPath;
  }

  const launcherPath = join(tmpDir, "mock-docker");
  // exec replaces the shell so SIGTERM/SIGKILL from the driver hit the
  // deno child directly rather than the shell wrapper.
  const launcherBody =
    `#!/bin/sh\nexec "${denoBin}" run --quiet --allow-all "${mockTsPath}" "$@"\n`;
  await Deno.writeTextFile(launcherPath, launcherBody);
  await Deno.chmod(launcherPath, 0o755);
  return launcherPath;
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

  try {
    // Mock prints a valid bundle JSON payload to stdout
    const command = await createMockDriverCommand(
      tmpDir,
      `console.log(JSON.stringify({\n  resources: [{ specName: "info", name: "info", data: { hostname: "container" } }],\n  files: [],\n}));\n`,
    );

    const driver = new DockerExecutionDriver({
      image: "denoland/deno:alpine",
      command,
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
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("DockerExecutionDriver - request with run dispatches to command mode", async () => {
  const tmpDir = await Deno.makeTempDir();

  try {
    const command = await createMockDriverCommand(
      tmpDir,
      `console.log(JSON.stringify({ id: "abc123" }));\n`,
    );

    const driver = new DockerExecutionDriver({
      image: "alpine",
      command,
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
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
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

  try {
    const command = await createMockDriverCommand(
      tmpDir,
      `console.log(JSON.stringify({\n  resources: [{ specName: "test", name: "test", data: { from: "bundle" } }],\n  files: [],\n}));\n`,
    );

    const driver = new DockerExecutionDriver({
      image: "denoland/deno:alpine",
      command,
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
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

// --- Command mode execute with mock scripts ---

Deno.test("DockerExecutionDriver - execute success with mock script", async () => {
  const tmpDir = await Deno.makeTempDir();

  try {
    const command = await createMockDriverCommand(
      tmpDir,
      `console.error("log: starting container");\nconsole.error("log: running command");\nconsole.log(JSON.stringify({ id: "abc123", status: "created" }));\n`,
    );

    const driver = new DockerExecutionDriver({
      image: "alpine",
      command,
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
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("DockerExecutionDriver - execute failure returns error", async () => {
  const tmpDir = await Deno.makeTempDir();

  try {
    const command = await createMockDriverCommand(
      tmpDir,
      `console.error("Error: container failed to start");\nDeno.exit(1);\n`,
    );

    const driver = new DockerExecutionDriver({
      image: "alpine",
      command,
    });

    const result = await driver.execute(createTestRequest());

    assertEquals(result.status, "error");
    assertStringIncludes(result.error!, "container failed to start");
    assertEquals(result.outputs.length, 0);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
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
  // Skipped on Windows: this test requires the driver's SIGTERM to reach the
  // mock and terminate it. POSIX delivers SIGTERM through the shell shim to
  // the deno child via the process group; Windows has no equivalent — killing
  // a `.cmd` parent does not propagate to its descendants. Without that
  // propagation the mock outlives the test and hangs CI. Re-enabling on
  // Windows requires either a Job Object–based kill (not exposed by Deno) or
  // a different mock pattern that detects parent death (e.g. polling
  // `process.ppid` or stdin closure). Tracked as a follow-up to Stream A.
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();

    try {
      // Mock blocks forever; the driver's timeout should fire and kill it via
      // SIGTERM. We use `setInterval` rather than `await new Promise(() => {})`
      // so the event loop has scheduled work — deno would otherwise terminate
      // a never-resolved top-level await with a "Top-level await promise never
      // resolved" diagnostic on stderr (which the driver would surface instead
      // of the timeout error). With setInterval, deno sits idle until SIGTERM
      // arrives and exits silently.
      const command = await createMockDriverCommand(
        tmpDir,
        `setInterval(() => {}, 60_000);\n`,
      );

      const driver = new DockerExecutionDriver({
        image: "alpine",
        command,
        timeout: 200,
      });

      const result = await driver.execute(createTestRequest());

      assertEquals(result.status, "error");
      assertStringIncludes(result.error!, "timed out");
      assertStringIncludes(result.error!, "200ms");
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(tmpDir, { recursive: true });
      }
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

  try {
    // Mock outputs JSON with resources and files
    const output = JSON.stringify({
      resources: [
        { specName: "info", name: "system-info", data: { cpu: 4, mem: "8GB" } },
      ],
      files: [
        { specName: "log", name: "exec-log", content: btoa("log line 1\n") },
      ],
    });

    const command = await createMockDriverCommand(
      tmpDir,
      `console.log(${JSON.stringify(output)});\n`,
    );

    const driver = new DockerExecutionDriver({
      image: "denoland/deno:alpine",
      command,
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
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("DockerExecutionDriver - bundle mode captures stderr as logs", async () => {
  const tmpDir = await Deno.makeTempDir();

  try {
    const command = await createMockDriverCommand(
      tmpDir,
      `console.error("[INFO] loading model");\nconsole.error("[INFO] executing method");\nconsole.log(JSON.stringify({ resources: [], files: [] }));\n`,
    );

    const driver = new DockerExecutionDriver({
      image: "denoland/deno:alpine",
      command,
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
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("DockerExecutionDriver - bundle mode failure returns error", async () => {
  const tmpDir = await Deno.makeTempDir();

  try {
    const command = await createMockDriverCommand(
      tmpDir,
      `console.error("Execution error: method not found");\nDeno.exit(1);\n`,
    );

    const driver = new DockerExecutionDriver({
      image: "denoland/deno:alpine",
      command,
    });

    const bundle = new TextEncoder().encode("export const model = {};");
    const result = await driver.execute(
      createTestRequest({ methodArgs: {}, bundle }),
    );

    assertEquals(result.status, "error");
    assertStringIncludes(result.error!, "method not found");
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("DockerExecutionDriver - bundle mode invalid JSON stdout fallback", async () => {
  const tmpDir = await Deno.makeTempDir();

  try {
    // Output invalid JSON — should be returned as raw resource
    const command = await createMockDriverCommand(
      tmpDir,
      `console.log("not json output");\n`,
    );

    const driver = new DockerExecutionDriver({
      image: "denoland/deno:alpine",
      command,
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
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

// --- Stream-0 regression net: signal handling and stream interleaving ---

Deno.test({
  name:
    "DockerExecutionDriver - SIGTERM-trapping child returns error with exit code 143 in stderr",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    const scriptPath = `${tmpDir}/mock-docker`;

    // Mock script that traps SIGTERM, prints to stderr, then exits 143.
    // We don't rely on the timeout path here — the driver simply observes a
    // non-zero exit code (143 = 128 + SIGTERM) and surfaces it. This pins
    // POSIX behavior so a refactor that drops/normalises signal handling on
    // POSIX will fail loudly.
    await Deno.writeTextFile(
      scriptPath,
      "#!/bin/sh\ntrap 'echo \"trapped SIGTERM\" >&2; exit 143' TERM\nkill -TERM $$\n# Give the trap a moment to fire before we fall through\nsleep 1\nexit 0\n",
    );
    await Deno.chmod(scriptPath, 0o755);

    try {
      const driver = new DockerExecutionDriver({
        image: "alpine",
        command: scriptPath,
      });

      const result = await driver.execute(createTestRequest());

      assertEquals(result.status, "error");
      // Either the captured stderr ("trapped SIGTERM") OR the synthesized
      // fallback ("Container exited with code 143") must surface.
      const errorMessage = result.error ?? "";
      const mentionsTrap = errorMessage.includes("trapped SIGTERM");
      const mentionsExit143 = errorMessage.includes("143");
      assertEquals(
        mentionsTrap || mentionsExit143,
        true,
        `expected error to surface SIGTERM trap or exit 143; got: ${errorMessage}`,
      );
      assertEquals(result.outputs.length, 0);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "DockerExecutionDriver - interleaved stdout/stderr captured fully without loss",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    const scriptPath = `${tmpDir}/mock-docker`;

    // Print 10 alternating lines to stdout and stderr. The shell script
    // emits them in a deterministic interleaved order; the driver MUST
    // capture every stdout and stderr line exactly once each, regardless
    // of the order they arrive on the pipes. This guards against a
    // refactor that drops a stream or buffers it incorrectly.
    const scriptLines: string[] = [];
    for (let i = 1; i <= 10; i++) {
      scriptLines.push(`echo "out-${i}"`);
      scriptLines.push(`echo "err-${i}" >&2`);
    }
    await Deno.writeTextFile(
      scriptPath,
      `#!/bin/sh\n${scriptLines.join("\n")}\n`,
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

      // Stderr lines flow into result.logs (and the onLog callback)
      assertEquals(result.logs.length, 10);
      assertEquals(logLines.length, 10);
      for (let i = 1; i <= 10; i++) {
        assertEquals(
          result.logs.includes(`err-${i}`),
          true,
          `missing err-${i} from logs: ${JSON.stringify(result.logs)}`,
        );
      }

      // Stdout lines are encoded into the output content
      assertEquals(result.outputs.length, 1);
      if (result.outputs[0].kind === "pending") {
        const text = new TextDecoder().decode(result.outputs[0].content);
        for (let i = 1; i <= 10; i++) {
          assertStringIncludes(text, `out-${i}`);
        }
        // Sanity: each stdout line appears exactly once. Match the line
        // anchored by a leading boundary and a trailing newline/end so
        // out-1 doesn't get conflated with out-10.
        const stdoutLines = text.split("\n").filter((l) => l.length > 0);
        for (let i = 1; i <= 10; i++) {
          const occurrences = stdoutLines.filter((l) => l === `out-${i}`)
            .length;
          assertEquals(
            occurrences,
            1,
            `stdout line out-${i} appeared ${occurrences} times in: ${
              JSON.stringify(stdoutLines)
            }`,
          );
        }
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
