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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import {
  type CommandOutput,
  withMockedCommand,
} from "@swamp-club/swamp-testing";
import {
  getCommandGuardian,
  setCommandGuardian,
} from "./command_guardian_policy.ts";
import { executeProcess, KILL_GRACE_MS } from "./process_executor.ts";

const GUARDIAN = {
  executable: join(Deno.cwd(), "installed", "swampd"),
  fence: join(Deno.cwd(), "private", "commands.sock"),
};
const MODES = [
  { name: "buffered", options: {} },
  { name: "streaming", options: { logger: getLogger(["guardian-test"]) } },
  { name: "timeout", options: { timeoutMs: 60_000 } },
  {
    name: "streaming with timeout",
    options: { timeoutMs: 60_000, logger: getLogger(["guardian-test"]) },
  },
] as const;

async function withGuardian<T>(fn: () => Promise<T>): Promise<T> {
  const previous = setCommandGuardian(GUARDIAN);
  try {
    return await fn();
  } finally {
    setCommandGuardian(previous);
  }
}

/** Controlled streams and status: no process, signal, or elapsed-time dependency. */
class ChildFixture {
  readonly started = Promise.withResolvers<void>();
  readonly written = Promise.withResolvers<void>();
  readonly completion = Promise.withResolvers<CommandOutput>();
  readonly writes: number[][] = [];
  closeAttempts = 0;
  releases = 0;
  kills = 0;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout = this.#output();
  readonly stderr = this.#output();

  constructor(readonly failure?: "write" | "close" | "spawn") {
    this.stdin = new WritableStream<Uint8Array>({
      write: (bytes) => {
        this.writes.push([...bytes]);
        this.written.resolve();
        if (failure === "write") throw new Error("control pipe write failed");
      },
      close: () => {
        if (failure === "close") throw new Error("control pipe close failed");
      },
    });
    const getWriter = this.stdin.getWriter.bind(this.stdin);
    this.stdin.getWriter = () => {
      const writer = getWriter();
      const close = writer.close.bind(writer);
      const release = writer.releaseLock.bind(writer);
      writer.close = () => {
        this.closeAttempts++;
        return close();
      };
      writer.releaseLock = () => {
        this.releases++;
        release();
      };
      return writer;
    };
  }

  #output() {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel() {
        closed = true;
      },
    });
    return {
      stream,
      finish(text: string) {
        if (closed) return;
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
        closed = true;
      },
    };
  }

  spawn(output: Promise<Deno.CommandOutput>): Deno.ChildProcess {
    this.started.resolve();
    return {
      pid: 1 << 30,
      stdin: this.stdin,
      stdout: this.stdout.stream,
      stderr: this.stderr.stream,
      status: output.then(({ code, signal, success }) => ({
        code,
        signal,
        success,
      })),
      output: () => output,
      kill: () => {
        this.kills++;
      },
      ref() {},
      unref() {},
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as Deno.ChildProcess;
  }

  finish(code = 0) {
    this.stdout.finish("target output\n");
    this.stderr.finish("target diagnostic\n");
    this.completion.resolve({ stdout: "", code });
  }
}

/**
 * withMockedCommand owns constructor restoration/capture but only implements
 * output(). Add spawn on its mock subclass so the real executor sees controlled
 * child streams while every launch is still captured by the shared helper.
 */
async function withMockedSpawn<T>(fixture: ChildFixture, fn: () => Promise<T>) {
  const options: Deno.CommandOptions[] = [];
  const result = await withMockedCommand(
    () => fixture.completion.promise,
    async () => {
      const MockCommand = Deno.Command;
      class SpawnCommand extends MockCommand {
        constructor(command: string | URL, value?: Deno.CommandOptions) {
          super(command, value);
          options.push(value ?? {});
        }
        override spawn(): Deno.ChildProcess {
          if (fixture.failure === "spawn") {
            throw new Error("guardian executable unavailable");
          }
          return fixture.spawn(this.output());
        }
      }
      Object.defineProperty(Deno, "Command", { value: SpawnCommand });
      try {
        return await fn();
      } finally {
        Object.defineProperty(Deno, "Command", { value: MockCommand });
      }
    },
  );
  return { ...result, options };
}

for (const mode of MODES) {
  Deno.test({
    name:
      `executeProcess: guardian forwards launch options and preserves target output/status (${mode.name})`,
    ignore: Deno.build.os === "windows",
    async fn() {
      const fixture = new ChildFixture();
      const cwd = join(Deno.cwd(), "working directory");
      const env = { ONLY_THIS: "literal $value", PATH: "/custom/bin" };
      const args = ["argument with spaces", "--flag", "$(literal)"];
      const { calls, options, result } = await withGuardian(() =>
        withMockedSpawn(fixture, async () => {
          const executing = executeProcess({
            ...mode.options,
            command: "target-command",
            args,
            cwd,
            env,
            clearEnv: true,
            killGraceMs: 17,
          });
          await fixture.started.promise;
          fixture.finish(23);
          return await executing;
        })
      );
      assertEquals(calls.length, 1);
      assertEquals(calls[0].command, GUARDIAN.executable);
      assertEquals(calls[0].args, [
        "__command_guardian",
        "--fence",
        GUARDIAN.fence,
        "--grace-ms",
        "17",
        "--",
        "target-command",
        ...args,
      ]);
      assertEquals(calls[0].env, env);
      assertEquals(calls[0].cwd, cwd);
      assertEquals(calls[0].clearEnv, true);
      assertEquals(options[0].stdin, "piped");
      assertEquals(options[0].detached, true);
      assertEquals(options[0].stdout, "piped");
      assertEquals(options[0].stderr, "piped");
      assertEquals(result.exitCode, 23);
      assertEquals(result.success, false);
      assertEquals(result.stdout, "target output");
      assertEquals(result.stderr, "target diagnostic");
      assertEquals(fixture.writes, []);
      assertEquals(fixture.closeAttempts, 1);
      assertEquals(fixture.releases, 1);
      assertEquals(fixture.stdin.locked, false);
      assertEquals(fixture.kills, 0);
    },
  });

  for (const failure of [undefined, "write"] as const) {
    Deno.test({
      name:
        `executeProcess: guardian cancellation waits for status and releases ownership${
          failure ? " after control write failure" : ""
        } (${mode.name})`,
      ignore: Deno.build.os === "windows",
      async fn() {
        const fixture = new ChildFixture(failure);
        const abort = new AbortController();
        await withGuardian(() =>
          withMockedSpawn(fixture, async () => {
            let settled = false;
            const executing = executeProcess({
              ...mode.options,
              command: "target-command",
              signal: abort.signal,
            });
            const rejected = assertRejects(
              () => executing,
              DOMException,
              "The operation was aborted",
            ).then((error) => {
              settled = true;
              return error;
            });
            await fixture.started.promise;
            abort.abort();
            await fixture.written.promise;
            assertEquals(fixture.writes, [[1]]);
            assertEquals(settled, false);
            fixture.finish(143);
            assertEquals((await rejected).name, "AbortError");
          })
        );
        assertEquals(fixture.writes, [[1]]);
        assertEquals(fixture.closeAttempts, failure ? 2 : 1);
        assertEquals(fixture.releases, 1);
        assertEquals(fixture.stdin.locked, false);
        assertEquals(fixture.kills, 0);
      },
    });
  }

  Deno.test({
    name:
      `executeProcess: guardian control close failure preserves successful completion (${mode.name})`,
    ignore: Deno.build.os === "windows",
    async fn() {
      const fixture = new ChildFixture("close");
      const { calls, result } = await withGuardian(() =>
        withMockedSpawn(fixture, async () => {
          const executing = executeProcess({
            ...mode.options,
            command: "target",
          });
          await fixture.started.promise;
          fixture.finish();
          return await executing;
        })
      );
      assertEquals(calls[0].args.slice(3, 5), [
        "--grace-ms",
        String(KILL_GRACE_MS),
      ]);
      assertEquals(result.success, true);
      assertEquals(result.exitCode, 0);
      assertEquals(fixture.closeAttempts, 1);
      assertEquals(fixture.releases, 1);
      assertEquals(fixture.stdin.locked, false);
      assertEquals(fixture.writes, []);
      assertEquals(fixture.kills, 0);
    },
  });
}

Deno.test("executeProcess: failed guardian launch restores policy and ordinary CLI command behavior", async () => {
  const initial = setCommandGuardian(undefined);
  try {
    await assertRejects(
      () =>
        withGuardian(() =>
          withMockedSpawn(
            new ChildFixture("spawn"),
            () => executeProcess({ command: "target" }),
          )
        ),
      Error,
      "guardian executable unavailable",
    );
    assertEquals(getCommandGuardian(), undefined);
    const fixture = new ChildFixture();
    const { calls, options, result } = await withMockedSpawn(
      fixture,
      async () => {
        const executing = executeProcess({
          command: "ordinary",
          args: ["value"],
        });
        await fixture.started.promise;
        fixture.finish();
        return await executing;
      },
    );
    assertEquals(calls[0].command, "ordinary");
    assertEquals(calls[0].args, ["value"]);
    assertEquals(options[0].stdin, undefined);
    assertEquals(options[0].detached, undefined);
    assertEquals(fixture.closeAttempts, 0);
    assertEquals(fixture.releases, 0);
    assertEquals(result.success, true);
  } finally {
    setCommandGuardian(initial);
  }
});

Deno.test({
  name:
    "executeProcess: Windows keeps direct commands and Job ownership with guardian policy installed",
  ignore: Deno.build.os !== "windows",
  async fn() {
    const fixture = new ChildFixture();
    const jobs: string[] = [];
    const { calls, options } = await withGuardian(() =>
      withMockedSpawn(fixture, async () => {
        const executing = executeProcess({
          command: "ordinary.exe",
          terminateProcessTree: true,
          attachJob: () => ({
            terminate: () => jobs.push("terminate"),
            release: () => jobs.push("release"),
          }),
        });
        await fixture.started.promise;
        fixture.finish();
        await executing;
      })
    );
    assertEquals(calls[0].command, "ordinary.exe");
    assertEquals(options[0].stdin, undefined);
    assertEquals(options[0].detached, undefined);
    assertEquals(jobs, ["release"]);
    assertEquals(fixture.closeAttempts, 0);
  },
});
