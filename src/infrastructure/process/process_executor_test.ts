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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  executeProcess,
  killLiveProcessGroups,
  streamLines,
} from "./process_executor.ts";
import { setProcessGroupIsolation } from "./process_group_policy.ts";
import { isProcessAlive } from "./process_kill.ts";
import { SecretRedactor } from "../../domain/secrets/mod.ts";

Deno.test("streamLines processes complete lines", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("line1\nline2\nline3"));
      controller.close();
    },
  });

  const lines: string[] = [];
  const result = await streamLines(stream, (line) => lines.push(line));

  assertEquals(lines, ["line1", "line2", "line3"]);
  assertEquals(result, "line1\nline2\nline3");
});

Deno.test("streamLines handles partial chunks", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("hel"));
      controller.enqueue(encoder.encode("lo\nwor"));
      controller.enqueue(encoder.encode("ld\n"));
      controller.close();
    },
  });

  const lines: string[] = [];
  const result = await streamLines(stream, (line) => lines.push(line));

  assertEquals(lines, ["hello", "world"]);
  assertEquals(result, "hello\nworld");
});

Deno.test("streamLines handles trailing content without newline", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("line1\npartial"));
      controller.close();
    },
  });

  const lines: string[] = [];
  await streamLines(stream, (line) => lines.push(line));

  assertEquals(lines, ["line1", "partial"]);
});

Deno.test("streamLines works without callback", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("hello\nworld"));
      controller.close();
    },
  });

  const result = await streamLines(stream);
  assertEquals(result, "hello\nworld");
});

Deno.test("executeProcess runs simple command", async () => {
  const result = await executeProcess({
    command: "echo",
    args: ["hello"],
  });

  assertEquals(result.success, true);
  assertEquals(result.exitCode, 0);
  assertEquals(result.stdout.trim(), "hello");
  assertEquals(result.stderr, "");
  assertEquals(result.durationMs >= 0, true);
});

Deno.test("executeProcess captures exit code", async () => {
  const result = await executeProcess({
    command: "sh",
    args: ["-c", "exit 42"],
  });

  assertEquals(result.success, false);
  assertEquals(result.exitCode, 42);
});

Deno.test("executeProcess captures stderr", async () => {
  const result = await executeProcess({
    command: "sh",
    args: ["-c", "echo error >&2"],
  });

  assertEquals(result.success, true);
  assertStringIncludes(result.stderr, "error");
});

Deno.test("executeProcess supports env", async () => {
  const result = await executeProcess({
    command: "printenv",
    args: ["TEST_EXEC_VAR"],
    env: { TEST_EXEC_VAR: "hello_from_exec" },
  });

  assertEquals(result.success, true);
  assertEquals(result.stdout.trim(), "hello_from_exec");
});

Deno.test("executeProcess supports cwd", async () => {
  const result = await executeProcess({
    command: "pwd",
    cwd: "/tmp",
  });

  assertEquals(result.success, true);
  // On some systems /tmp may resolve to /private/tmp
  assertStringIncludes(result.stdout.trim(), "tmp");
});

Deno.test("executeProcess streams to logger", async () => {
  const infoLines: string[] = [];
  const warnLines: string[] = [];

  // Create a minimal mock logger
  const mockLogger = {
    info: (line: string) => {
      infoLines.push(line);
    },
    warn: (line: string) => {
      warnLines.push(line);
    },
  } as unknown as import("@logtape/logtape").Logger;

  const result = await executeProcess({
    command: "sh",
    args: ["-c", "echo stdout_line && echo stderr_line >&2"],
    logger: mockLogger,
  });

  assertEquals(result.success, true);
  assertEquals(infoLines, ["stdout_line"]);
  assertEquals(warnLines, ["stderr_line"]);
  assertStringIncludes(result.stdout, "stdout_line");
  assertStringIncludes(result.stderr, "stderr_line");
});

Deno.test("executeProcess handles timeout", async () => {
  try {
    await executeProcess({
      command: "sleep",
      args: ["10"],
      timeoutMs: 100,
    });
    throw new Error("Expected timeout error");
  } catch (error) {
    assertStringIncludes((error as Error).message, "timed out");
  }
});

Deno.test("executeProcess handles timeout with logger", async () => {
  const mockLogger = {
    info: () => {},
    warn: () => {},
  } as unknown as import("@logtape/logtape").Logger;

  try {
    await executeProcess({
      command: "sleep",
      args: ["10"],
      timeoutMs: 100,
      logger: mockLogger,
    });
    throw new Error("Expected timeout error");
  } catch (error) {
    assertStringIncludes((error as Error).message, "timed out");
  }
});

// --- Stream-0 regression net: abort signal & SIGTERM-on-timeout ---

Deno.test({
  name:
    "executeProcess: AbortSignal aborted mid-execution surfaces AbortError (streaming mode)",
  // sleep(1) and SIGTERM via process.kill are POSIX-only contracts. The
  // production code only attaches abort handling in streaming mode (when
  // a logger is provided), so we exercise that path here.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const mockLogger = {
      info: () => {},
      warn: () => {},
    } as unknown as import("@logtape/logtape").Logger;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    let caught: unknown;
    try {
      await executeProcess({
        command: "sleep",
        args: ["5"],
        logger: mockLogger,
        signal: controller.signal,
      });
    } catch (err) {
      caught = err;
    }

    assertEquals(
      caught !== undefined,
      true,
      "expected executeProcess to reject when signal aborts",
    );
    // The executor surfaces a DOMException with name "AbortError" when
    // the abort signal was responsible for the kill.
    const err = caught as { name?: string; message?: string };
    assertEquals(
      err.name,
      "AbortError",
      `expected AbortError; got name=${err.name} message=${err.message}`,
    );
  },
});

Deno.test({
  name:
    "executeProcess: timeout sends SIGTERM to child and surfaces timeout error",
  // SIGTERM-on-timeout semantics: the child process is killed via SIGTERM
  // (not SIGKILL) so signal-aware children can clean up. The executor
  // surfaces a generic "timed out" Error after the kill — this pins both
  // halves so a refactor that switches to SIGKILL or drops the kill
  // entirely will fail.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // Use sh with a SIGTERM-trapping handler. If SIGTERM arrives, the
    // trap runs and the child exits cleanly with code 143. If only
    // SIGKILL arrives, the trap never runs.
    let caught: unknown;
    try {
      await executeProcess({
        command: "sh",
        args: ["-c", "trap 'exit 143' TERM; sleep 5"],
        timeoutMs: 200,
      });
    } catch (err) {
      caught = err;
    }

    assertEquals(
      caught !== undefined,
      true,
      "expected executeProcess to throw on timeout",
    );
    const err = caught as Error;
    assertStringIncludes(err.message, "timed out");
    assertStringIncludes(err.message, "200ms");
  },
});

// --- Surviving child process: timeout must not override the real exit code ---

Deno.test({
  name:
    "executeProcess: timeout + surviving child returns actual exit code, not -1 (buffered mode)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // The main shell exits immediately with code 0, but backgrounds a child
    // that holds the pipes open briefly.  With the old code this caused a
    // spurious timeout error; the fix races process.status against the
    // timeout so the real exit code is captured.
    const result = await executeProcess({
      command: "sh",
      args: ["-c", "echo hello; sleep 1 & exit 0"],
      timeoutMs: 10_000,
    });

    assertEquals(result.success, true);
    assertEquals(result.exitCode, 0);
    assertStringIncludes(result.stdout, "hello");
  },
});

Deno.test({
  name:
    "executeProcess: timeout + surviving child returns actual exit code (streaming mode)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const infoLines: string[] = [];
    const mockLogger = {
      info: (line: string) => {
        infoLines.push(line);
      },
      warn: () => {},
      debug: () => {},
    } as unknown as import("@logtape/logtape").Logger;

    const result = await executeProcess({
      command: "sh",
      args: ["-c", "echo streamed; sleep 1 & exit 0"],
      timeoutMs: 10_000,
      logger: mockLogger,
    });

    assertEquals(result.success, true);
    assertEquals(result.exitCode, 0);
    assertEquals(infoLines.includes("streamed"), true);
  },
});

Deno.test({
  name:
    "executeProcess: genuine timeout still throws even with surviving child fix",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    let caught: unknown;
    try {
      await executeProcess({
        command: "sleep",
        args: ["10"],
        timeoutMs: 200,
      });
    } catch (err) {
      caught = err;
    }

    assertEquals(
      caught !== undefined,
      true,
      "expected executeProcess to throw on genuine timeout",
    );
    assertStringIncludes((caught as Error).message, "timed out");
  },
});

Deno.test("executeProcess redacts secrets from streamed stdout lines", async () => {
  const infoLines: string[] = [];
  const warnLines: string[] = [];

  const mockLogger = {
    info: (line: string) => {
      infoLines.push(line);
    },
    warn: (line: string) => {
      warnLines.push(line);
    },
  } as unknown as import("@logtape/logtape").Logger;

  const redactor = new SecretRedactor();
  redactor.addSecret("my-secret-token");

  const result = await executeProcess({
    command: "sh",
    args: ["-c", "echo my-secret-token && echo my-secret-token >&2"],
    logger: mockLogger,
    redactor,
  });

  assertEquals(result.success, true);
  // Streamed lines to logger should be redacted
  assertEquals(infoLines, ["***"]);
  assertEquals(warnLines, ["***"]);
  // Raw captured output is NOT redacted by process executor (shell model handles that)
  assertStringIncludes(result.stdout, "my-secret-token");
  assertStringIncludes(result.stderr, "my-secret-token");
});

// --- Abort signal in buffered mode (no logger, no timeout) ---

Deno.test({
  name:
    "executeProcess: AbortSignal aborted mid-execution surfaces AbortError (buffered mode)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    let caught: unknown;
    try {
      await executeProcess({
        command: "sleep",
        args: ["5"],
        signal: controller.signal,
      });
    } catch (err) {
      caught = err;
    }

    assertEquals(
      caught !== undefined,
      true,
      "expected executeProcess to reject when signal aborts",
    );
    const err = caught as { name?: string; message?: string };
    assertEquals(
      err.name,
      "AbortError",
      `expected AbortError; got name=${err.name} message=${err.message}`,
    );
  },
});

Deno.test({
  name:
    "executeProcess: AbortSignal kills subprocess before it completes (streaming mode)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const infoLines: string[] = [];
    const mockLogger = {
      info: (line: string) => infoLines.push(line),
      warn: () => {},
    } as unknown as import("@logtape/logtape").Logger;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    let caught: unknown;
    try {
      await executeProcess({
        command: "sh",
        args: ["-c", "echo start; sleep 20; echo end"],
        logger: mockLogger,
        signal: controller.signal,
      });
    } catch (err) {
      caught = err;
    }

    assert(caught !== undefined, "expected rejection");
    assert(
      !infoLines.includes("end"),
      "subprocess should have been killed before printing 'end'",
    );
  },
});

Deno.test({
  name:
    "executeProcess: AbortSignal kills subprocess before it completes (buffered mode)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    let caught: unknown;
    try {
      await executeProcess({
        command: "sh",
        args: ["-c", "echo start; sleep 20; echo end"],
        signal: controller.signal,
      });
    } catch (err) {
      caught = err;
    }

    assert(caught !== undefined, "expected rejection");
  },
});

// --- Process tree termination (swamp-club#2634) ---
//
// A step's command used to be killed with a single SIGTERM to the direct
// child: `sh -c "sleep 30; ..."` died and its `sleep` was reparented to init,
// still running after the run was reported cancelled. A child that ignored
// SIGTERM was never killed at all. Each script below backgrounds a
// grandchild and writes its pid to a file, so the test can check what
// survived.

const silentLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
} as unknown as import("@logtape/logtape").Logger;

/** Pins isolation on, so results do not depend on the test's terminal. */
async function withIsolatedGroups(fn: () => Promise<void>): Promise<void> {
  const previous = setProcessGroupIsolation("always");
  try {
    await fn();
  } finally {
    setProcessGroupIsolation(previous);
  }
}

/** Runs `fn` with a pid file, then SIGKILLs any pid it names. */
async function withPidFile(
  fn: (pidFile: string, readPid: () => Promise<number>) => Promise<void>,
): Promise<void> {
  const pidFile = await Deno.makeTempFile({ prefix: "swamp-pid-" });
  const readPid = async () => Number((await Deno.readTextFile(pidFile)).trim());
  try {
    await fn(pidFile, readPid);
  } finally {
    const pid = await readPid().catch(() => 0);
    if (pid > 0) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch { /* already gone */ }
    }
    await Deno.remove(pidFile).catch(() => {});
  }
}

async function pidWritten(readPid: () => Promise<number>): Promise<boolean> {
  return await readPid().then((pid) => pid > 0, () => false);
}

/** `sh -c` script that backgrounds `sleep 30`, records its pid, and waits. */
function grandchildScript(pidFile: string, prefix = ""): string[] {
  return ["-c", `${prefix}sleep 30 & echo $! > '${pidFile}'; wait`];
}

for (
  const [label, withLogger] of [["streaming", true], [
    "buffered",
    false,
  ]] as const
) {
  Deno.test({
    name:
      `executeProcess: abort terminates the whole process tree (${label} mode)`,
    ignore: Deno.build.os === "windows",
    fn: () =>
      withIsolatedGroups(() =>
        withPidFile(async (pidFile, readPid) => {
          const controller = new AbortController();
          const run = executeProcess({
            command: "sh",
            args: grandchildScript(pidFile),
            logger: withLogger ? silentLogger : undefined,
            signal: controller.signal,
            terminateProcessTree: true,
          });
          await waitFor(() => pidWritten(readPid), "grandchild pid file");
          controller.abort();

          const err = await assertRejects(() => run);
          assertEquals((err as DOMException).name, "AbortError");
          const grandchild = await readPid();
          await waitFor(
            () => !isProcessAlive(grandchild),
            "grandchild to be terminated",
          );
        })
      ),
  });
}

Deno.test({
  name: "executeProcess: timeout terminates the whole process tree",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withIsolatedGroups(() =>
      withPidFile(async (pidFile, readPid) => {
        await assertRejects(
          () =>
            executeProcess({
              command: "sh",
              args: grandchildScript(pidFile),
              // Long enough that sh has recorded the pid under load.
              timeoutMs: 2000,
              terminateProcessTree: true,
            }),
          Error,
          "timed out",
        );
        const grandchild = await readPid();
        assert(grandchild > 0, "grandchild should have started");
        await waitFor(
          () => !isProcessAlive(grandchild),
          "grandchild to be terminated",
        );
      })
    ),
});

Deno.test({
  name:
    "executeProcess: a tree that ignores SIGTERM is SIGKILLed after the grace period",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withIsolatedGroups(() =>
      withPidFile(async (pidFile, readPid) => {
        const controller = new AbortController();
        const run = executeProcess({
          command: "sh",
          // Ignored dispositions survive exec, so sleep ignores SIGTERM too.
          args: grandchildScript(pidFile, "trap '' TERM; "),
          timeoutMs: 60_000,
          signal: controller.signal,
          terminateProcessTree: true,
          killGraceMs: 200,
        });
        await waitFor(() => pidWritten(readPid), "grandchild pid file");
        controller.abort();

        await assertRejects(() => run);
        const grandchild = await readPid();
        await waitFor(
          () => !isProcessAlive(grandchild),
          "grandchild to be SIGKILLed",
        );
      })
    ),
});

Deno.test({
  name:
    "executeProcess: a direct child that ignores SIGTERM is SIGKILLed without tree termination",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withPidFile(async (pidFile, readPid) => {
      const controller = new AbortController();
      const run = executeProcess({
        command: "sh",
        args: grandchildScript(pidFile, "trap '' TERM; "),
        signal: controller.signal,
        killGraceMs: 200,
      });
      await waitFor(() => pidWritten(readPid), "grandchild pid file");
      controller.abort();

      await assertRejects(() => run);
      // Only the direct child is signalled here, so the grandchild is
      // still running: the run settled through SIGKILL escalation, not by
      // waiting out the 30 s sleep.
      assert(
        isProcessAlive(await readPid()),
        "grandchild should outlive a direct-child kill",
      );
    }),
});

Deno.test({
  name:
    "executeProcess: a signal aborted before spawn still terminates the tree",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withIsolatedGroups(() =>
      withPidFile(async (pidFile, readPid) => {
        const controller = new AbortController();
        controller.abort();
        const err = await assertRejects(() =>
          executeProcess({
            command: "sh",
            args: grandchildScript(pidFile),
            signal: controller.signal,
            terminateProcessTree: true,
          })
        );
        assertEquals((err as DOMException).name, "AbortError");
        // The group may be killed before sh backgrounds anything.
        const grandchild = await readPid().catch(() => 0);
        if (grandchild > 0) {
          await waitFor(
            () => !isProcessAlive(grandchild),
            "grandchild to be terminated",
          );
        }
      })
    ),
});

Deno.test({
  name:
    "executeProcess: a command that exits on its own leaves what it backgrounded running",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withIsolatedGroups(() =>
      withPidFile(async (pidFile, readPid) => {
        const result = await executeProcess({
          command: "sh",
          args: [
            "-c",
            `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0`,
          ],
          logger: silentLogger,
          terminateProcessTree: true,
        });
        assertEquals(result.exitCode, 0);

        // The group is no longer tracked, so the exit sweep spares it.
        killLiveProcessGroups();
        assert(
          isProcessAlive(await readPid()),
          "an intentionally backgrounded process should keep running",
        );
      })
    ),
});

for (
  const [label, timeoutMs] of [["timeout", 20_000], [
    "streaming",
    undefined,
  ]] as const
) {
  Deno.test({
    name:
      `executeProcess: an abort after the command exited spares what it backgrounded (${label} mode)`,
    ignore: Deno.build.os === "windows",
    fn: () =>
      withIsolatedGroups(() =>
        withPidFile(async (pidFile, readPid) => {
          const shPidFile = `${pidFile}.sh`;
          try {
            const controller = new AbortController();
            // The backgrounded sleep keeps stdout open, so the executor is
            // still draining pipes after sh exits.
            const run = executeProcess({
              command: "sh",
              args: [
                "-c",
                `sleep 30 & echo $! > '${pidFile}'; echo $$ > '${shPidFile}'; exit 0`,
              ],
              logger: silentLogger,
              signal: controller.signal,
              timeoutMs,
              terminateProcessTree: true,
            });
            await waitFor(() => pidWritten(readPid), "grandchild pid file");
            const shPid = Number((await Deno.readTextFile(shPidFile)).trim());
            await waitFor(() => !isProcessAlive(shPid), "sh to exit");
            controller.abort();

            await run.catch(() => {});
            assert(
              isProcessAlive(await readPid()),
              "a command that exited on its own must not have its group signalled",
            );
          } finally {
            await Deno.remove(shPidFile).catch(() => {});
          }
        })
      ),
  });
}

Deno.test({
  name: "killLiveProcessGroups: SIGKILLs the groups of commands still running",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withIsolatedGroups(() =>
      withPidFile(async (pidFile, readPid) => {
        const run = executeProcess({
          command: "sh",
          args: grandchildScript(pidFile),
          terminateProcessTree: true,
        });
        await waitFor(() => pidWritten(readPid), "grandchild pid file");

        killLiveProcessGroups();

        const result = await run;
        assertEquals(result.success, false);
        const grandchild = await readPid();
        await waitFor(
          () => !isProcessAlive(grandchild),
          "grandchild to be SIGKILLed",
        );
      })
    ),
});

Deno.test({
  name:
    "executeProcess: a throwing output callback terminates the still-running tree",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withIsolatedGroups(() =>
      withPidFile(async (pidFile, readPid) => {
        await assertRejects(
          () =>
            executeProcess({
              command: "sh",
              args: [
                "-c",
                `sleep 30 & echo $! > '${pidFile}'; echo ready; wait`,
              ],
              logger: silentLogger,
              onOutput: () => {
                throw new Error("sink failed");
              },
              terminateProcessTree: true,
            }),
          Error,
          "sink failed",
        );
        const grandchild = await readPid();
        await waitFor(
          () => !isProcessAlive(grandchild),
          "grandchild to be terminated",
        );
      })
    ),
});

Deno.test({
  name:
    "executeProcess: abort terminates the whole process tree on Windows (taskkill /T)",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-tree-" });
    const pidFile = `${dir}\\grandchild.pid`;
    const script = `${dir}\\grandchild.ts`;
    await Deno.writeTextFile(
      script,
      "Deno.writeTextFileSync(Deno.args[0], String(Deno.pid));\n" +
        "setTimeout(() => {}, 30_000);\n",
    );
    const readPid = async () =>
      Number((await Deno.readTextFile(pidFile)).trim());
    const isRunning = async (pid: number) => {
      const out = await new Deno.Command("tasklist", {
        args: ["/FI", `PID eq ${pid}`, "/NH"],
        stdout: "piped",
        stderr: "null",
      }).output();
      return new TextDecoder().decode(out.stdout).includes(String(pid));
    };
    try {
      const controller = new AbortController();
      const run = executeProcess({
        command: "cmd",
        args: ["/c", Deno.execPath(), "run", "-A", script, pidFile],
        signal: controller.signal,
        terminateProcessTree: true,
      });
      await waitFor(() => pidWritten(readPid), "grandchild pid file");
      controller.abort();

      await assertRejects(() => run);
      const grandchild = await readPid();
      await waitFor(
        async () => !await isRunning(grandchild),
        "grandchild to be terminated",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
