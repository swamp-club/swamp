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
import type { z } from "zod";
import { Ceiling } from "../src/domain/access/ceiling.ts";
import {
  type GrantBasedAccessDecisionService,
  INTEGRATION_CEILING_GRANT_ID,
} from "../src/domain/access/grant_based_access_decision_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { serverRequestSchemas } from "../src/serve/connection.ts";
import {
  type ActiveRun,
  ActiveRunRegistry,
} from "../src/serve/active_run_registry.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import "../src/domain/models/models.ts";
import {
  createServeCtx,
  grant,
  saveModel,
  saveRun,
  saveWorkflow,
  sendRequest,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const CLIENT = "integration:rule-test";

const ACTIVE_RUN = "11111111-1111-4111-8111-222222222222";

/** answered with no decision at all, and why that can't reach anything */
const NO_CEILING_DECISION: Readonly<Record<string, string>> = {
  "server.version":
    "the version handshake, which a client needs before it can do anything",
  "access.can-i":
    "explains the caller's own rights: both modes go through the ceiling, and it changes nothing",
  "audit.unsubscribe":
    "drops the caller's own subscription, which a ceiling refused opening",
  "cancel":
    "aborts the caller's own request; cancelling a run is covered by the run case below",
};

function minimal(schema: unknown): unknown {
  if (schema === undefined) return undefined;
  const def = (schema as { def?: Record<string, unknown> }).def ??
    (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def ?? {};
  switch (def.type) {
    case "object": {
      const shape = def.shape as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(shape).flatMap(([key, value]) => {
          const type = (value as { def?: { type?: string } }).def?.type;
          return type === "optional" ? [] : [[key, minimal(value)]];
        }),
      );
    }
    case "string":
      return "11111111-1111-4111-8111-111111111111";
    case "number":
    case "int":
      return 1;
    case "boolean":
      return false;
    case "array":
      return [];
    case "record":
      return {};
    case "literal":
      return (def.values as unknown[])[0];
    case "enum":
      return Object.values(def.entries as Record<string, unknown>)[0];
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
      return minimal(def.innerType);
    case "pipe":
      return minimal(def.in);
    case "union":
      return minimal((def.options as unknown[])[0]);
    case "lazy":
      return minimal((def.getter as () => unknown)());
    default:
      return undefined;
  }
}

function withNamedTargets(
  base: unknown,
  named: Record<string, unknown>,
): unknown {
  if (!base || typeof base !== "object") return base;
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(named).filter(([key]) => key in base),
    ),
  };
}

interface Recorded {
  readonly ceilingDenies: number;
  readonly allows: number;
}

function recording(ctx: ConnectionContext): {
  ctx: ConnectionContext;
  take(): Recorded;
} {
  const service = ctx.policySnapshotLoader!.decisionService;
  let ceilingDenies = 0;
  let allows = 0;
  const note = (decision: unknown) => {
    const d = decision as { effect?: string; grantId?: string } | null;
    if (d?.grantId === INTEGRATION_CEILING_GRANT_ID) ceilingDenies++;
    else if (d?.effect === "allow") allows++;
    return decision;
  };
  const wrapped = new Proxy(service, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        if (prop === "decide" || prop === "decideAll") note(result);
        if (prop === "explain") (result as unknown[]).forEach(note);
        return result;
      };
    },
  }) as GrantBasedAccessDecisionService;
  return {
    ctx: {
      ...ctx,
      policySnapshotLoader: {
        ...ctx.policySnapshotLoader,
        decisionService: wrapped,
      },
    } as unknown as ConnectionContext,
    take() {
      const taken = { ceilingDenies, allows };
      ceilingDenies = 0;
      allows = 0;
      return taken;
    },
  };
}

const EVERYTHING = (["workflow", "model", "data", "vault", "access"] as const)
  .map((kind) =>
    grant({
      actions: ["read", "write", "run", "approve", "signal", "tag", "admin"],
      resource: { kind, pattern: "*" },
    })
  );

Deno.test({
  name:
    "ceiling rules: every request type reaches the ceiling with an empty one, on an admin person's token",
  // a refused request starts nothing, so nothing should outlive it
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const model = await saveModel(repo, "rule-model");
      const workflow = await saveWorkflow(repo, "rule-flow", model);
      const run = await saveRun(repo, workflow);
      const named: Record<string, unknown> = {
        workflowIdOrName: workflow.name,
        workflow: workflow.name,
        modelIdOrName: model.name,
        runId: (run as { id?: unknown }).id,
      };
      const registry = new ActiveRunRegistry();
      registry.register({
        runId: ACTIVE_RUN,
        kind: "workflow",
        resourceName: workflow.name,
        resourceId: workflow.id,
        controller: new AbortController(),
        eventLog: [],
        subscribers: new Set(),
      } as unknown as ActiveRun);
      // these only decide once a real target resolves
      const realTargets: Record<string, unknown> = {
        "model.edit": { modelIdOrName: model.name, content: "name: edited" },
        "workflow.edit": {
          workflowIdOrName: workflow.name,
          content: "name: edited",
        },
        "vault.edit": { vaultNameOrId: "any-vault", content: "name: edited" },
        "run.attach": { runId: ACTIVE_RUN },
        "workflow.cancel": {
          runId: ACTIVE_RUN,
          workflowIdOrName: workflow.name,
        },
        "workflow.signal": {
          workflow: workflow.name,
          key: "a-key",
          payload: {},
        },
      };
      const { ctx, take } = recording(
        createServeCtx(repo, EVERYTHING, {
          activeRunRegistry: registry,
          integrations: {
            standingOf: () => ({ kind: "active", ceiling: Ceiling.empty() }),
          },
        }),
      );
      const unchecked: string[] = [];
      const allowed: string[] = [];
      const seen = new Set<string>();
      for (const schema of serverRequestSchemas()) {
        const shape = (schema as z.ZodObject).shape;
        const type = (shape.type as z.ZodLiteral<string>).value;
        seen.add(type);
        const base = minimal(shape.payload);
        const payload = realTargets[type] ?? withNamedTargets(base, named);
        take();
        await sendRequest(
          ctx,
          { type, id: crypto.randomUUID(), payload } as never,
          undefined,
          { client: CLIENT, awaitRuns: false },
        );
        const { ceilingDenies, allows } = take();
        if (allows > 0) allowed.push(type);
        if (ceilingDenies > 0) continue;
        unchecked.push(type);
      }
      assertEquals(allowed, [], "allowed under an empty ceiling");
      assertEquals(
        unchecked.filter((type) => !NO_CEILING_DECISION[type]).sort(),
        [],
        "These request types reached no ceiling decision. Authorize them through the decision service, or list one in NO_CEILING_DECISION with the reason",
      );
      assertEquals(
        Object.keys(NO_CEILING_DECISION).filter((type) => !seen.has(type)),
        [],
        "NO_CEILING_DECISION names a request type that no longer exists",
      );
      assertEquals(
        Object.keys(NO_CEILING_DECISION).filter((type) =>
          !unchecked.includes(type)
        ),
        [],
        "NO_CEILING_DECISION lists a type that does reach the ceiling now",
      );
      assert(seen.size > 100, "the schema walk found too few request types");
    });
  },
});
