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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import type { FilesystemDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import {
  type MethodContext,
  modelRegistry,
} from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  acquireModelLocks,
  runUnderModelLocks,
} from "../src/cli/repo_context.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import type { NestedRunLock } from "../src/domain/models/model_invocation_service.ts";
import {
  createModelMethodRunDeps,
  createStepLockHook,
} from "../src/serve/deps.ts";

await initializeLogging({});

type Repo = ReturnType<typeof createRepositoryContext>;

interface Fixture {
  dir: string;
  repo: Repo;
  config: FilesystemDatastoreConfig;
  nestedRunLock: NestedRunLock;
  /** names a fresh type for this run, registered until the fixture ends */
  type: (name: string) => ModelType;
  define: (type: ModelType, name: string) => Promise<Definition>;
}

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => open = resolve);
  return { promise, open };
}

async function withFixture(fn: (fx: Fixture) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-4992-" });
  const types: ModelType[] = [];
  try {
    await Deno.mkdir(join(dir, "models"), { recursive: true });
    await new RepoMarkerRepository().write(RepoPath.create(dir), {
      swampVersion: "0.1.0",
      initializedAt: "2026-11-22T00:00:00.000Z",
      repoId: crypto.randomUUID(),
      tools: [],
    });
    const repo = createRepositoryContext({ repoDir: dir });
    const config: FilesystemDatastoreConfig = {
      type: "filesystem",
      path: join(dir, ".swamp"),
    };
    try {
      await fn({
        dir,
        repo,
        config,
        nestedRunLock: createStepLockHook(
          dir,
          repo,
          config,
          undefined,
          undefined,
        ),
        type: (name) => {
          const type = ModelType.create(
            `test/${name}-${crypto.randomUUID()}`,
          );
          types.push(type);
          return type;
        },
        define: async (type, name) => {
          const definition = Definition.create({
            name,
            type: type.normalized,
          });
          await repo.definitionRepo.save(type, definition);
          return definition;
        },
      });
    } finally {
      repo.catalogStore.close();
    }
  } finally {
    for (const type of types) modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else await Deno.remove(dir, { recursive: true });
  }
}

/** a run as `swamp behavior run` makes it: the behavior's lock, then the method */
async function runLocked(
  fx: Fixture,
  type: ModelType,
  definition: Definition,
  methodName: string,
  inputs: Record<string, unknown> = {},
) {
  const locks = await acquireModelLocks(
    fx.config,
    [{ modelType: type.normalized, modelId: definition.id }],
    fx.dir,
    undefined,
    fx.repo.catalogStore,
    undefined,
    { repoContext: fx.repo },
  );
  try {
    const deps = await createModelMethodRunDeps(fx.dir, fx.repo, {});
    return await runUnderModelLocks(locks, () =>
      collect(
        modelMethodRun(
          createLibSwampContext(),
          { ...deps, nestedRunLock: fx.nestedRunLock },
          {
            modelIdOrName: definition.name,
            methodName,
            inputs,
            lastEvaluated: false,
          },
        ),
      ));
  } finally {
    await locks.release();
  }
}

function lastKind(events: ReadonlyArray<{ kind: string }>): string {
  return events.at(-1)?.kind ?? "none";
}

function errorText(events: ReadonlyArray<{ kind: string }>): string {
  return JSON.stringify(events.at(-1));
}

const State = z.object({ count: z.number() });

/**
 * read the count, wait at the gate, write count + 1: the read-then-write a
 * lock exists to protect
 */
function registerCounter(
  type: ModelType,
  hooks: {
    entered: (who: string) => void;
    wait: (who: string) => Promise<void>;
  },
) {
  modelRegistry.register({
    type,
    version: "2026.11.22.1",
    resources: {
      state: {
        description: "counter",
        schema: State,
        lifetime: "infinite",
        garbageCollection: 20,
      },
    },
    methods: {
      bump: {
        description: "read, wait, write count + 1",
        arguments: z.object({ who: z.string().default("hand") }),
        execute: async (args, context) => {
          const { who } = args as { who: string };
          const prev = await context.readResource!("state") as
            | { count: number }
            | null;
          hooks.entered(who);
          await hooks.wait(who);
          const handle = await context.writeResource!("state", "state", {
            count: (prev?.count ?? 0) + 1,
          });
          return { dataHandles: [handle] };
        },
      },
    },
  });
}

/** a method that calls each target in turn through runModel */
function registerCaller(
  type: ModelType,
  methods: Record<
    string,
    (context: MethodContext) => Promise<void>
  >,
) {
  modelRegistry.register({
    type,
    version: "2026.11.22.1",
    methods: Object.fromEntries(
      Object.entries(methods).map(([name, body]) => [name, {
        description: name,
        arguments: z.object({}),
        execute: async (_args: unknown, context: MethodContext) => {
          await body(context);
          return { dataHandles: [] };
        },
      }]),
    ),
  });
}

async function runModelOrThrow(
  context: MethodContext,
  definition: string,
  method: string,
  args?: Record<string, unknown>,
) {
  const result = await context.runModel!({
    definition,
    method,
    ...(args ? { arguments: args } : {}),
  });
  if (!result.ok) throw new Error(result.error.message);
}

async function count(fx: Fixture, type: ModelType, definition: Definition) {
  const bytes = await fx.repo.unifiedDataRepo.getContent(
    type,
    definition.id,
    "state",
  );
  return (JSON.parse(new TextDecoder().decode(bytes!)) as { count: number })
    .count;
}

Deno.test("runModel: a nested run waits for its target's lock, so a hand run's update is not lost", async () => {
  await withFixture(async (fx) => {
    const counterType = fx.type("counter");
    const callerType = fx.type("caller");
    const hand = gate();
    const handEntered = gate();
    const nestedRequested = gate();
    registerCounter(counterType, {
      entered: (who) => {
        if (who === "hand") handEntered.open();
        // without a target lock the nested bump goes straight in
        if (who === "nested") nestedRequested.open();
      },
      wait: (who) => who === "hand" ? hand.promise : Promise.resolve(),
    });
    registerCaller(callerType, {
      go: (context) =>
        runModelOrThrow(context, "ctr", "bump", { who: "nested" }),
    });
    const ctr = await fx.define(counterType, "ctr");
    const clr = await fx.define(callerType, "clr");
    const requestNested = fx.nestedRunLock;
    fx.nestedRunLock = (...args) => {
      nestedRequested.open();
      return requestNested(...args);
    };

    const handRun = runLocked(fx, counterType, ctr, "bump");
    // the hand run holds the lock and has read count 0
    await handEntered.promise;
    const nestedRun = runLocked(fx, callerType, clr, "go");
    await nestedRequested.promise;
    hand.open();

    const [handEvents, nestedEvents] = await Promise.all([handRun, nestedRun]);
    assertEquals(lastKind(handEvents), "completed", errorText(handEvents));
    assertEquals(lastKind(nestedEvents), "completed", errorText(nestedEvents));
    assertEquals(await count(fx, counterType, ctr), 2);
  });
});

Deno.test("runModel: a method calling another method of its own behavior runs under the lock it holds", async () => {
  // a self-call that waited on its own lock would fail at this timeout
  await withMockedEnv(
    { SWAMP_LOCK_TIMEOUT_MS: "1500" },
    () =>
      withFixture(async (fx) => {
        const selfType = fx.type("self");
        registerCounter(selfType, {
          entered: () => {},
          wait: () => Promise.resolve(),
        });
        const ctr = await fx.define(selfType, "self-ctr");
        modelRegistry.get(selfType)!.methods.viaSelf = {
          description: "bump this behavior through runModel",
          arguments: z.object({}),
          execute: async (_args, context) => {
            await runModelOrThrow(context, "self-ctr", "bump", { who: "a" });
            return { dataHandles: [] };
          },
        };

        const events = await runLocked(fx, selfType, ctr, "viaSelf");

        assertEquals(lastKind(events), "completed", errorText(events));
        assertEquals(await count(fx, selfType, ctr), 1);
      }),
  );
});

Deno.test("runModel: two behaviors calling each other fail at the lock timeout instead of hanging", async () => {
  await withMockedEnv(
    { SWAMP_LOCK_TIMEOUT_MS: "1500" },
    () =>
      withFixture(async (fx) => {
        const aType = fx.type("cross-a");
        const bType = fx.type("cross-b");
        const bothIn = { count: 0, gate: gate() };
        const arrive = async () => {
          if (++bothIn.count === 2) bothIn.gate.open();
          await bothIn.gate.promise;
        };
        registerCaller(aType, {
          callB: async (context) => {
            await arrive();
            await runModelOrThrow(context, "cross-b", "ping");
          },
          ping: () => Promise.resolve(),
        });
        registerCaller(bType, {
          callA: async (context) => {
            await arrive();
            await runModelOrThrow(context, "cross-a", "ping");
          },
          ping: () => Promise.resolve(),
        });
        const a = await fx.define(aType, "cross-a");
        const b = await fx.define(bType, "cross-b");

        const [aEvents, bEvents] = await Promise.all([
          runLocked(fx, aType, a, "callB"),
          runLocked(fx, bType, b, "callA"),
        ]);

        // the first to time out releases its own lock, so the other may finish
        const failed = [aEvents, bEvents].filter((e) =>
          lastKind(e) === "error"
        );
        assert(failed.length >= 1, errorText(aEvents) + errorText(bEvents));
        for (const events of failed) {
          assertStringIncludes(errorText(events).toLowerCase(), "lock");
        }
      }),
  );
});

Deno.test("runModel: a run nested two deep locks its innermost target against a hand run", async () => {
  await withFixture(async (fx) => {
    const counterType = fx.type("deep-counter");
    const outerType = fx.type("deep-outer");
    const middleType = fx.type("deep-middle");
    const hand = gate();
    const handEntered = gate();
    const nestedRequested = gate();
    registerCounter(counterType, {
      entered: (who) => {
        if (who === "hand") handEntered.open();
        if (who === "nested") nestedRequested.open();
      },
      wait: (who) => who === "hand" ? hand.promise : Promise.resolve(),
    });
    registerCaller(outerType, {
      go: (context) => runModelOrThrow(context, "deep-mid", "go"),
    });
    registerCaller(middleType, {
      go: (context) =>
        runModelOrThrow(context, "deep-ctr", "bump", { who: "nested" }),
    });
    const ctr = await fx.define(counterType, "deep-ctr");
    const outer = await fx.define(outerType, "deep-out");
    await fx.define(middleType, "deep-mid");
    const requestNested = fx.nestedRunLock;
    fx.nestedRunLock = (modelType, ...rest) => {
      if (modelType === counterType.normalized) nestedRequested.open();
      return requestNested(modelType, ...rest);
    };

    const handRun = runLocked(fx, counterType, ctr, "bump");
    await handEntered.promise;
    const nestedRun = runLocked(fx, outerType, outer, "go");
    await nestedRequested.promise;
    hand.open();

    const [handEvents, nestedEvents] = await Promise.all([handRun, nestedRun]);
    assertEquals(lastKind(handEvents), "completed", errorText(handEvents));
    assertEquals(lastKind(nestedEvents), "completed", errorText(nestedEvents));
    assertEquals(await count(fx, counterType, ctr), 2);
  });
});
