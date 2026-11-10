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

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";
import { waitFor } from "@swamp-club/swamp-testing";
import { z } from "zod";
import {
  createModelMethodRunCommand,
  MODEL_METHOD_RUN_SYNTAX,
} from "../src/cli/commands/model_method_run.ts";
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import {
  resetImplicitServeRouting,
  setImplicitServeRouting,
} from "../src/cli/remote_run.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  type Client,
  endCommand,
  type Scratch,
  type Serve,
  serveEnv,
  withClientEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";
import type {
  MethodRunWorkerMessage,
  MethodRunWorkerRequest,
} from "./serve_upstream_method_run_worker.ts";

await initializeLogging({});

// alice-token authenticates as user:caller
const ALICE_ALL: readonly GrantSpec[] = [
  {
    user: "caller",
    actions: ["read", "write", "run"],
    kind: "model",
    pattern: "*",
  },
  { user: "caller", actions: ["read", "write"], kind: "data", pattern: "*" },
];

const TARGET = "read-target";

/** this thread's members write; serve's thread knows only its read method */
function registerMethods(type: ModelType): void {
  modelRegistry.invalidateType(type);
  modelRegistry.register({
    type,
    version: "2026.01.01.1",
    globalArguments: z.object({}),
    resources: {
      out: {
        description: "One data version per run",
        schema: z.object({ body: z.string() }),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      write: {
        description: "Writes one data version",
        kind: "update",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const handle = await context.writeResource!("out", "out", {
            body: "x",
          });
          await holdWrite?.();
          return { dataHandles: [handle] };
        },
      },
    },
  });
}

/** what a member's write waits on once its version is allocated */
let holdWrite: (() => Promise<void>) | undefined;

/** a command in this thread; one at a time, as each ends the process's stores */
async function command(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  path: readonly string[],
  attach: (root: Command) => void,
  args: readonly string[],
): Promise<void> {
  await withClientEnv(scratch, env, path, async () => {
    const root = registerCompletionTypes(new Command())
      .globalOption("--json", "JSON output") as unknown as Command;
    attach(root);
    setImplicitServeRouting(false);
    try {
      await root.parse([
        "cmd",
        ...args,
        "--json",
        "--repo-dir",
        client.repoDir,
      ]);
    } finally {
      resetImplicitServeRouting();
      await endCommand();
    }
  });
}

/** the method run of a member on another checkout, in its own thread */
function memberRun(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  method: string,
): {
  done: () => boolean;
  result: Promise<{ error?: string; exitCode: number }>;
} {
  const worker = new Worker(
    new URL("./serve_upstream_method_run_worker.ts", import.meta.url).href,
    { type: "module" },
  );
  let loaded = false;
  let done: Extract<MethodRunWorkerMessage, { kind: "done" }> | undefined;
  let failed: string | undefined;
  worker.onmessage = (event: MessageEvent<MethodRunWorkerMessage>) => {
    const message = event.data;
    if (message.kind === "loaded") loaded = true;
    else if (message.kind === "done") done = message;
    else failed = message.error;
  };
  worker.onerror = (event) => {
    event.preventDefault();
    failed = event.message;
  };
  const result = (async () => {
    try {
      await waitFor(
        () => loaded || failed !== undefined,
        "the member's worker to load",
        { timeoutMs: 120_000 },
      );
      worker.postMessage(
        {
          kind: "run",
          configDir: scratch.configDir,
          repoDir: client.repoDir,
          env: serveEnv(serve, "alice-token"),
          modelType: serve.modelType.normalized,
          model: TARGET,
          method,
        } satisfies MethodRunWorkerRequest,
      );
      await waitFor(
        () => done !== undefined || failed !== undefined,
        "the member's method run",
        { timeoutMs: 240_000, intervalMs: 50 },
      );
    } finally {
      worker.terminate();
    }
    if (done === undefined) throw new Error(`member failed: ${failed}`);
    return {
      ...(done.error === undefined ? {} : { error: done.error }),
      exitCode: done.exitCode,
    };
  })();
  return { done: () => done !== undefined || failed !== undefined, result };
}

async function versionsOf(serve: Serve, dataName: string): Promise<number[]> {
  const versions = new Set<number>();
  const suffix = new RegExp(`/${dataName}/(\\d+)/raw$`);
  for (const entry of await serve.log()) {
    for (const key of entry.keys) {
      const match = key.match(suffix);
      if (match !== null) versions.add(Number(match[1]));
    }
  }
  return [...versions].sort((a, b) => a - b);
}

Deno.test({
  name:
    "team-mode read run: a member's read method run during another member's leased write waits for it, then succeeds (swamp-club#4578)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: ALICE_ALL,
        managedConfig: true,
      });
      registerMethods(serve.modelType);
      const writer = await scratch.client("writer", { managedConfig: true });
      const reader = await scratch.client("reader", { managedConfig: true });
      const env = serveEnv(serve, "alice-token");
      await writeCommand(
        scratch,
        writer,
        env,
        (repos) =>
          repos.definitionRepo.save(
            serve.modelType,
            Definition.create({ name: TARGET, globalArguments: {} }),
          ),
      );
      let release = () => {};
      const released = new Promise<void>((resolve) => release = resolve);
      let wrote = false;
      holdWrite = () => {
        wrote = true;
        return released;
      };
      let writerError: unknown;
      let read: ReturnType<typeof memberRun> | undefined;
      const exitCode = Deno.exitCode;
      try {
        const write = command(
          scratch,
          writer,
          env,
          ["model", "method", "run"],
          (root) => {
            root.command(
              "cmd",
              createModelMethodRunCommand(MODEL_METHOD_RUN_SYNTAX),
            );
          },
          [TARGET, "write"],
        ).catch((error) => {
          writerError = error;
        });
        try {
          // the writer holds the behavior's lease, its versions not committed
          await waitFor(() => wrote, "the member's write to allocate");
          const { busy } = await serve.lockStats();
          read = memberRun(scratch, serve, reader, "peek");
          // lockless, it ends at once; locking, serve answers its lock held
          await waitFor(
            async () => read!.done() || (await serve.lockStats()).busy > busy,
            "the read run to end or wait for the lease",
            { timeoutMs: 120_000, intervalMs: 50 },
          );
        } finally {
          release();
          await write;
        }
      } finally {
        holdWrite = undefined;
        Deno.exitCode = exitCode;
      }
      assertEquals(writerError, undefined);
      assertEquals(await read?.result, { exitCode: 0 });
      assertEquals(await versionsOf(serve, "report-swamp-method-summary"), [
        1,
        2,
      ]);
    });
  },
});

Deno.test({
  name:
    "team-mode read run: serve's own read method run during a member's leased write waits for it, and both runs' versions are consecutive (swamp-club#4578)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: ALICE_ALL,
        managedConfig: true,
        refreshMethod: true,
        claimedAs: "https://serve.team.test",
      });
      registerMethods(serve.modelType);
      const member = await scratch.client("member", { managedConfig: true });
      const env = serveEnv(serve, "alice-token");
      const target = Definition.create({ name: TARGET, globalArguments: {} });
      await writeCommand(
        scratch,
        member,
        env,
        (repos) => repos.definitionRepo.save(serve.modelType, target),
      );
      let release = () => {};
      const released = new Promise<void>((resolve) => release = resolve);
      let wrote = false;
      holdWrite = () => {
        wrote = true;
        return released;
      };
      let memberError: unknown;
      let served: Promise<{ errors: readonly string[] }> | undefined;
      const exitCode = Deno.exitCode;
      try {
        const write = command(
          scratch,
          member,
          env,
          ["model", "method", "run"],
          (root) => {
            root.command(
              "cmd",
              createModelMethodRunCommand(MODEL_METHOD_RUN_SYNTAX),
            );
          },
          [TARGET, "write"],
        ).catch((error) => {
          memberError = error;
        });
        try {
          // the member's version of `out` is allocated, not yet committed
          await waitFor(() => wrote, "the member's write to allocate");
          let settled = false;
          served = serve.runMethod(TARGET, "refresh");
          served.then(() => settled = true, () => settled = true);
          // lockless, it ends at once; locking, it waits at serve's own lock
          await waitFor(
            async () =>
              settled ||
              (await serve.lockStats()).ownLockKeys.some((key) =>
                key.includes(target.id)
              ),
            "serve's read run to end or wait for the lease",
            { timeoutMs: 120_000, intervalMs: 50 },
          );
        } finally {
          release();
          await write;
        }
      } finally {
        holdWrite = undefined;
        Deno.exitCode = exitCode;
      }
      assertEquals(memberError, undefined);
      assertEquals((await served)?.errors, []);
      assertEquals(await versionsOf(serve, "out"), [1, 2]);
      assertEquals(await versionsOf(serve, "report-swamp-method-summary"), [
        1,
        2,
      ]);
    });
  },
});
