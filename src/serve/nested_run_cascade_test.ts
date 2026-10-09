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

import { assert, assertEquals } from "@std/assert";
import { cancelAndSettle } from "../domain/workflows/abort_settlement.ts";
import {
  type NestedChain,
  nestedChain,
} from "../domain/workflows/nested_run_test_helpers.ts";
import type { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import { ActiveRunRegistry } from "./active_run_registry.ts";
import type { ConnectionContext } from "./handlers/shared.ts";
import {
  cascadeEndedRunAndPush,
  fetchMissingRunUnderGate,
} from "./nested_run_cascade.ts";

interface Harness {
  ctx: ConnectionContext;
  registry: ActiveRunRegistry;
  pushes: number;
  /** The paths asked of `hydrateFile`. */
  hydrated: string[];
}

/**
 * A serve context over the chain's in-memory repositories, with a real
 * active-run registry and a sync service that counts pushes. `hydrate`
 * stands in for the datastore fetch of one file; without it the context has
 * none, as on a datastore that is not synced.
 */
function harness(
  built: NestedChain,
  options: {
    registry?: boolean;
    failLookup?: boolean;
    hydrate?: (path: string) => Promise<void>;
  } = {},
): Harness {
  const registry = new ActiveRunRegistry();
  const h: Harness = {
    ctx: undefined as unknown as ConnectionContext,
    registry,
    pushes: 0,
    hydrated: [],
  };
  const hydrate = options.hydrate;
  h.ctx = {
    activeRunRegistry: options.registry === false ? undefined : registry,
    datastoreConfig: { type: "filesystem" },
    syncService: {
      pushChanged: () => {
        h.pushes++;
        return Promise.resolve();
      },
    },
    repoContext: {
      workflowRepo: built.workflowRepo,
      hydrateFile: hydrate
        ? (path: string) => {
          h.hydrated.push(path);
          return hydrate(path);
        }
        : undefined,
      workflowRunRepo: {
        findById: built.runs.findById.bind(built.runs),
        save: built.runs.save.bind(built.runs),
        getPath: (workflowId: string, runId: string) =>
          `${workflowId}/${runId}.yaml`,
        findGlobalById: (runId: string) => {
          if (options.failLookup) {
            return Promise.reject(new Error("repository unavailable"));
          }
          const run = built.runs.byId.get(runId.toLowerCase());
          return Promise.resolve(
            run ? { run, workflowId: run.workflowId } : null,
          );
        },
      },
    },
  } as unknown as ConnectionContext;
  return h;
}

/** The chain with its top run cancelled, as a run its abort ended is. */
function abortedChain(levels = 2): NestedChain & { ended: WorkflowRun } {
  const built = nestedChain(levels);
  cancelAndSettle(built.chain[0], undefined, "aborted");
  built.runs.add(built.chain[0]);
  return { ...built, ended: built.chain[0] };
}

Deno.test("cascadeEndedRunAndPush: cancels the suspended nested runs of a run its abort ended, in one push, and releases their ids", async () => {
  const built = abortedChain(3);
  const h = harness(built);

  const result = await cascadeEndedRunAndPush(h.ctx, built.ended.id, "r");

  assertEquals(result.cancelledNestedRuns?.map((r) => r.runId), [
    built.chain[1].id,
    built.chain[2].id,
  ]);
  assertEquals(result.detachedNestedRuns, undefined);
  assertEquals(built.runs.saved, [built.chain[1].id, built.chain[2].id]);
  assertEquals(built.runs.get(built.chain[1]).status, "cancelled");
  assertEquals(built.runs.get(built.chain[2]).status, "cancelled");
  assertEquals(h.pushes, 1);
  for (const run of built.chain) {
    const release = h.registry.reserve(run.id);
    assert(release, "every reservation was released");
    release();
  }
});

Deno.test("cascadeEndedRunAndPush: without a registry does nothing and pushes nothing", async () => {
  const built = abortedChain();
  const h = harness(built, { registry: false });

  assertEquals(await cascadeEndedRunAndPush(h.ctx, built.ended.id, "r"), {});
  assertEquals(built.runs.saved, []);
  assertEquals(h.pushes, 0);
});

Deno.test("cascadeEndedRunAndPush: leaves the nested runs of a run that did not end cancelled, and of a run that is gone", async () => {
  // Still suspended: the abort stopped nothing, so nothing ended.
  const built = nestedChain();
  const h = harness(built);

  assertEquals(
    await cascadeEndedRunAndPush(h.ctx, built.chain[0].id, "r"),
    {},
  );
  assertEquals(
    await cascadeEndedRunAndPush(h.ctx, crypto.randomUUID(), "r"),
    {},
  );
  assertEquals(built.runs.saved, []);
  assertEquals(built.runs.get(built.chain[1]).status, "suspended");
});

Deno.test("cascadeEndedRunAndPush: a cancelled run that waited on no nested run reports nothing", async () => {
  const built = abortedChain();
  const h = harness(built);

  // The innermost run waits at a gate, not on a nested run.
  const inner = built.chain[1];
  cancelAndSettle(inner, undefined, "aborted");
  built.runs.add(inner);

  assertEquals(await cascadeEndedRunAndPush(h.ctx, inner.id, "r"), {});
  assertEquals(built.runs.saved, []);
});

Deno.test("cascadeEndedRunAndPush: a failure is not thrown and leaves the nested runs as they were", async () => {
  const built = abortedChain();
  const h = harness(built, { failLookup: true });

  assertEquals(await cascadeEndedRunAndPush(h.ctx, built.ended.id, "r"), {});
  assertEquals(built.runs.saved, []);
  assertEquals(built.runs.get(built.chain[1]).status, "suspended");
});

Deno.test("fetchMissingRunUnderGate: fetches only a record this instance does not have", async () => {
  const built = nestedChain();
  const h = harness(built, { hydrate: () => Promise.resolve() });
  const present = built.chain[0];

  await fetchMissingRunUnderGate(h.ctx, {
    workflowId: present.workflowId,
    runId: present.id,
  });
  assertEquals(h.hydrated, []);

  const missing = crypto.randomUUID();
  await fetchMissingRunUnderGate(h.ctx, {
    workflowId: present.workflowId,
    runId: missing,
  });
  assertEquals(h.hydrated, [`${present.workflowId}/${missing}.yaml`]);
});

Deno.test("fetchMissingRunUnderGate: a fetch that fails, or a context with no fetch, is not an error", async () => {
  const built = nestedChain();
  const run = {
    workflowId: built.chain[0].workflowId,
    runId: crypto.randomUUID(),
  };

  const failing = harness(built, {
    hydrate: () => Promise.reject(new Error("timed out")),
  });
  await fetchMissingRunUnderGate(failing.ctx, run);
  assertEquals(failing.hydrated.length, 1);

  const none = harness(built);
  await fetchMissingRunUnderGate(none.ctx, run);
  assertEquals(none.hydrated, []);
});
