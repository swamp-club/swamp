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
/**
 * Conditional grants decide on complete resources (swamp-club#2675). A grant
 * condition reads a resource's fields; a deny that needs a field the
 * resource does not carry fails closed, so every request must authorize
 * resources with all of their fields — and requests over many resources
 * must check each one, never a `*` that no name-scoped deny can match.
 *
 * Every protocol request type is classified below, and the classification is
 * enforced: a new request type fails this test until it is placed. Request
 * types that name one resource are exercised by serve_id_deny_conformance,
 * which runs each of them under a tags deny as well as a name deny.
 */

import { assert, assertEquals } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { serverRequestPayloadFields } from "../src/serve/connection.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import type { Workflow } from "../src/domain/workflows/workflow.ts";
import { Data } from "../src/domain/data/data.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { CONDITION_FIELDS } from "../src/domain/access/condition_fields.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveData,
  saveModel,
  saveOutput,
  saveRun,
  saveRunStepData,
  saveWorkflow,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

type Category =
  /** Names one resource; covered by serve_id_deny_conformance. */
  | "resource"
  /** Returns many resources, each filtered on its complete owners. */
  | "collection"
  /** Runs over every readable resource, narrowed before it acts. */
  | "narrowed"
  /** Reaches every resource of a kind; any applicable deny refuses it. */
  | "every"
  /** A check on a kind as a whole — types, extensions, datastores. */
  | "kind"
  /** Access-kind administration, whose only condition field is the name. */
  | "access"
  /** Explains a decision for a named resource, judged as a request would be. */
  | "explain"
  /**
   * A vault, authorized as `vault:<name>` under the vault kind's fields —
   * its name, and the key the request names (swamp-club#2676) — beside its
   * data names, which carry complete fields.
   */
  | "vault"
  /** Creates a resource, authorized on its name and type with no tags. */
  | "create";

const CATEGORIES: Record<string, Category> = {
  "model.method.run": "resource",
  "model.method.describe": "resource",
  "model.get": "resource",
  "model.delete": "resource",
  "model.edit": "resource",
  "data.get": "resource",
  "data.versions": "resource",
  "data.delete": "resource",
  "data.rename": "resource",
  "workflow.run": "resource",
  "model.output.get": "resource",
  "model.output.data": "resource",
  "model.output.logs": "resource",
  "model.method.history.get": "resource",
  "model.method.history.logs": "resource",
  "workflow.history.get": "resource",
  "workflow.history.logs": "resource",
  "workflow.get": "resource",
  "workflow.delete": "resource",
  "workflow.edit": "resource",
  "workflow.trigger.set": "resource",
  "workflow.trigger.get": "resource",
  "workflow.trigger.remove": "resource",
  "workflow.approve": "resource",
  "workflow.reject": "resource",
  "workflow.resume": "resource",
  "workflow.cancel": "resource",
  // Names a wait, not a workflow, so serve_id_deny_conformance has no field
  // to drive; its tags deny is exercised in serve_signal_test.
  "workflow.signal": "resource",
  "run.attach": "resource",
  "cancel": "resource",

  "model.search": "collection",
  "model.output.search": "collection",
  "model.method.history.search": "collection",
  "data.list": "collection",
  "data.search": "collection",
  "data.query": "collection",
  "workflow.search": "collection",
  "workflow.approvals": "collection",
  // Exercised under a tags deny in serve_signal_test.
  "workflow.waits": "collection",
  "workflow.history.search": "collection",
  "workflow.run.search": "collection",
  "report.search": "collection",
  "report.get": "collection",
  "vault.audit-trail": "collection",

  "model.validate": "narrowed",
  "model.evaluate": "narrowed",
  "workflow.validate": "narrowed",
  "workflow.evaluate": "narrowed",

  "data.gc": "every",
  "data.prune": "every",
  "run.gc": "every",
  "summarise": "every",

  "model.type.describe": "kind",
  "model.type.search": "kind",
  "workflow.schema": "kind",
  "report.describe": "kind",
  "report.type.search": "kind",
  "vault.type.search": "kind",
  "extension.info": "kind",
  "extension.install": "kind",
  "extension.list": "kind",
  "extension.outdated": "kind",
  "extension.pull": "kind",
  "extension.rm": "kind",
  "extension.search": "kind",
  "extension.update": "kind",
  "datastore.namespace.list": "kind",
  "datastore.setup.extension": "kind",
  "run.history": "kind",
  "run.doctor": "kind",
  "audit.timeline": "kind",

  "access.can-i": "explain",
  "access.check": "explain",
  "access.grant.list": "access",
  "access.group.list": "access",
  "access.group.list-idp": "access",
  "access.reload": "access",
  "access.token.list": "access",
  "access.token.mint": "access",
  "access.token.revoke": "access",
  "access.token.rotate": "access",
  "audit.alerts": "access",
  "audit.export": "access",
  "audit.query": "access",
  "audit.report": "access",
  "audit.rotate-key": "access",
  "audit.subscribe": "access",
  "audit.unsubscribe": "access",
  "audit.verify": "access",
  "cluster.instances": "access",
  "datastore.status": "access",
  "doctor.datastores": "access",
  "doctor.extensions": "access",
  "doctor.secrets": "access",
  "doctor.vaults": "access",
  "doctor.workflows": "access",
  "serve.config": "access",
  "serve.reload": "access",
  "server.version": "access",
  "worker.list": "access",
  "worker.prune": "access",
  "worker.queue.list": "access",
  "worker.token.create": "access",
  "worker.token.list": "access",
  "worker.token.revoke": "access",
  "worker.verify": "access",

  "vault.annotate": "vault",
  "vault.create": "vault",
  "vault.delete": "vault",
  "vault.describe": "vault",
  "vault.edit": "vault",
  "vault.get": "vault",
  "vault.inspect": "vault",
  "vault.list-keys": "vault",
  "vault.migrate": "vault",
  "vault.put": "vault",
  "vault.read-secret": "vault",
  "vault.search": "vault",

  "model.create": "create",
  "workflow.create": "create",
};

Deno.test("serve condition-fields conformance: every request type is classified", () => {
  const types = [...serverRequestPayloadFields()].map(([type]) => type).sort();
  assertEquals(
    types.filter((type) => !CATEGORIES[type]),
    [],
    "Classify each new request type in CATEGORIES",
  );
  assertEquals(
    Object.keys(CATEGORIES).filter((type) => !types.includes(type)),
    [],
    "CATEGORIES must name real request types",
  );
});

const ACTIONS: Grant["actions"] = ["read", "write", "run", "approve"];

/** Allow everything on models, data and workflows; deny what is env: prod. */
const TAG_GRANTS: Grant[] = (["model", "data", "workflow"] as const).flatMap((
  kind,
) => [
  grant({ actions: ACTIONS, resource: { kind, pattern: "*" } }),
  grant({
    effect: "deny",
    actions: ACTIONS,
    resource: { kind, pattern: "*" },
    condition: 'tags.env == "prod"',
  }),
]);

/** Allow everything on models, data and workflows, with no deny. */
const ALLOW_GRANTS: Grant[] = (["model", "data", "workflow"] as const).map((
  kind,
) => grant({ actions: ACTIONS, resource: { kind, pattern: "*" } }));

interface Fixtures {
  repo: ServeRepo;
  ctx: ConnectionContext;
  prodModel: Definition;
  devModel: Definition;
  prodWorkflow: Workflow;
  devWorkflow: Workflow;
}

async function withFixtures(fn: (f: Fixtures) => Promise<void>) {
  await withServeRepo(async (repo) => {
    const prodModel = await saveModel(repo, "prod-db", { env: "prod" });
    const devModel = await saveModel(repo, "dev-db");
    await saveData(repo, prodModel, "state");
    await saveData(repo, devModel, "state");
    await saveOutput(repo, prodModel);
    await saveOutput(repo, devModel);
    const prodWorkflow = await saveWorkflow(repo, "prod-flow", prodModel, {
      env: "prod",
    });
    const devWorkflow = await saveWorkflow(repo, "dev-flow", devModel);
    await saveRun(repo, prodWorkflow);
    await saveRun(repo, devWorkflow);
    await fn({
      repo,
      ctx: createServeCtx(repo, TAG_GRANTS),
      prodModel,
      devModel,
      prodWorkflow,
      devWorkflow,
    });
  });
}

function request(type: string, payload: Record<string, unknown>) {
  return { type, id: crypto.randomUUID(), payload };
}

function openCtx(f: Fixtures): ConnectionContext {
  return createServeCtx(f.repo, ALLOW_GRANTS);
}

function reply(frames: Frame[], type: string): string {
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const found = frames.find((frame) => frame.type === type);
  assert(found, `${type} replied: ${JSON.stringify(frames)}`);
  return JSON.stringify(found);
}

Deno.test("serve condition-fields conformance: collections leave out tag-denied items and keep untagged ones", async () => {
  await withFixtures(async (f) => {
    for (
      const [type, payload, visible] of [
        ["model.search", {}, "dev-db"],
        ["model.output.search", {}, "dev-db"],
        ["model.method.history.search", {}, "dev-db"],
        ["data.search", {}, "dev-db"],
        ["data.query", { predicate: "true" }, "dev-db"],
        ["data.query", { predicate: "true", select: "modelName" }, "dev-db"],
        ["workflow.search", {}, "dev-flow"],
        ["workflow.history.search", {}, "dev-flow"],
        ["workflow.run.search", {}, "dev-flow"],
      ] as const
    ) {
      const label = `${type} ${JSON.stringify(payload)}`;
      const body = reply(
        await sendRequest(f.ctx, request(type, payload)),
        type,
      );
      assert(body.includes(visible), `${label}: ${body}`);
      assert(!body.includes("prod-"), `${label}: ${body}`);
      // Without the deny the prod items are there, so the filter did it.
      const open = reply(
        await sendRequest(openCtx(f), request(type, payload)),
        type,
      );
      assert(open.includes("prod-"), `${label} unfiltered: ${open}`);
    }
  });
});

Deno.test("serve condition-fields conformance: validate and evaluate everything leave out tag-denied resources", async () => {
  await withFixtures(async (f) => {
    for (
      const [type, visible] of [
        ["model.validate", "dev-db"],
        ["model.evaluate", "dev-db"],
        ["workflow.validate", "dev-flow"],
        ["workflow.evaluate", "dev-flow"],
      ] as const
    ) {
      const body = reply(await sendRequest(f.ctx, request(type, {})), type);
      assert(body.includes(visible), `${type}: ${body}`);
      assert(!body.includes("prod-"), `${type}: ${body}`);
      const open = reply(
        await sendRequest(openCtx(f), request(type, {})),
        type,
      );
      assert(open.includes("prod-"), `${type} unfiltered: ${open}`);
    }
  });
});

Deno.test("serve condition-fields conformance: operations over every resource are refused by any applicable deny", async () => {
  await withFixtures(async (f) => {
    const open = createServeCtx(f.repo, ALLOW_GRANTS);
    for (
      const [type, payload] of [
        ["data.gc", { dryRun: true }],
        ["data.prune", { dryRun: true }],
        ["run.gc", { dryRun: true }],
        ["summarise", {}],
      ] as const
    ) {
      const refused = errorFrame(
        await sendRequest(f.ctx, request(type, payload)),
      );
      assertEquals(refused?.error?.code, "unauthorized", type);
      assert(
        refused!.error!.message.includes("needs"),
        `${type}: ${refused!.error!.message}`,
      );
      const allowed = errorFrame(
        await sendRequest(open, request(type, payload)),
      );
      assert(
        allowed?.error?.code !== "unauthorized",
        `${type}: ${allowed?.error?.message}`,
      );
    }
  });
});

Deno.test("serve condition-fields conformance: kind-level checks and creates are not refused by a deny on resource tags", async () => {
  await withFixtures(async (f) => {
    for (
      const [type, payload] of [
        ["model.type.search", {}],
        ["workflow.schema", {}],
        ["report.type.search", {}],
        ["vault.type.search", {}],
        ["vault.search", {}],
        ["workflow.create", { name: "new-flow" }],
        ["model.create", {
          typeArg: f.repo.modelType.normalized,
          name: "new-model",
        }],
      ] as const
    ) {
      const error = errorFrame(
        await sendRequest(f.ctx, request(type, payload)),
      );
      assert(
        error?.error?.code !== "unauthorized",
        `${type}: ${error?.error?.message}`,
      );
    }
  });
});

Deno.test("serve condition-fields conformance: a deny on a field no handler supplies refuses rather than allows", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, [
      ...ALLOW_GRANTS,
      grant({
        effect: "deny",
        actions: ACTIONS,
        resource: { kind: "model", pattern: "*" },
        condition: 'collective == "acme"',
      }),
    ]);
    const refused = errorFrame(
      await sendRequest(
        ctx,
        request("model.get", { modelIdOrName: f.devModel.name }),
      ),
    );
    assertEquals(refused?.error?.code, "unauthorized");
  });
});

Deno.test("serve condition-fields conformance: a methods-scoped deny applies to the method, not to other model reads", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, [
      ...ALLOW_GRANTS,
      grant({
        effect: "deny",
        actions: ["run", "read"],
        resource: { kind: "model", pattern: "*" },
        condition: 'methodName == "noop"',
      }),
    ]);
    const run = errorFrame(
      await sendRequest(
        ctx,
        request("model.method.run", {
          modelIdOrName: f.devModel.name,
          methodName: "noop",
        }),
      ),
    );
    assertEquals(run?.error?.code, "unauthorized");
    reply(
      await sendRequest(
        ctx,
        request("model.get", { modelIdOrName: f.devModel.name }),
      ),
      "model.get",
    );
  });
});

/** Saves a markdown report named `reportName` owned by `model`. */
async function saveReport(
  repo: ServeRepo,
  model: Definition,
  reportName: string,
): Promise<void> {
  const data = Data.create({
    name: `report-${reportName}`,
    contentType: "text/markdown",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "report", reportName, modelName: model.name },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${repo.modelType.normalized}:${model.id}`,
    },
  });
  await repo.repoContext.unifiedDataRepo.save(
    repo.modelType,
    model.id,
    data,
    new TextEncoder().encode(`# ${model.name}`),
  );
}

Deno.test("serve condition-fields conformance: reports are read as their owner's data", async () => {
  await withFixtures(async (f) => {
    await saveReport(f.repo, f.prodModel, "health");
    await saveReport(f.repo, f.devModel, "health");

    // Unfiltered, the report exists on both models and is ambiguous.
    const open = errorFrame(
      await sendRequest(
        openCtx(f),
        request("report.get", {
          reportName: "health",
        }),
      ),
    );
    assert(open?.error?.message?.includes("prod-db"), JSON.stringify(open));

    // Under the tags deny only dev-db's is readable: no ambiguity, and the
    // prod owner is never named.
    const got = reply(
      await sendRequest(f.ctx, request("report.get", { reportName: "health" })),
      "report.get",
    );
    assert(got.includes("dev-db") && !got.includes("prod-"), got);

    const searched = reply(
      await sendRequest(f.ctx, request("report.search", {})),
      "report.search",
    );
    assert(
      searched.includes("dev-db") && !searched.includes("prod-"),
      searched,
    );

    const named = errorFrame(
      await sendRequest(
        f.ctx,
        request("report.get", { reportName: "health", model: "prod-db" }),
      ),
    );
    assertEquals(named?.error?.code, "unauthorized");
  });
});

Deno.test("serve condition-fields conformance: a failing evaluate-everything names nothing the caller may not read", async () => {
  await withServeRepo(async (repo) => {
    await saveModel(repo, "dev-db");
    // Two prod models that reference each other: evaluation fails on the
    // cycle, and the cycle error names them.
    for (
      const [name, other] of [["prod-secret-a", "prod-secret-b"], [
        "prod-secret-b",
        "prod-secret-a",
      ]]
    ) {
      await repo.repoContext.definitionRepo.save(
        repo.modelType,
        Definition.create({
          name,
          globalArguments: { peer: `\${{ model.${other}.definition.name }}` },
          tags: { env: "prod" },
        }),
      );
    }

    const open = errorFrame(
      await sendRequest(
        createServeCtx(repo, ALLOW_GRANTS),
        request("model.evaluate", {}),
      ),
    );
    assert(
      open?.error?.message?.includes("prod-secret"),
      `evaluating a cycle fails and names it: ${JSON.stringify(open)}`,
    );

    const hidden = errorFrame(
      await sendRequest(
        createServeCtx(repo, TAG_GRANTS),
        request("model.evaluate", {}),
      ),
    );
    assertEquals(hidden?.error?.code, "model_evaluate_failed");
    assert(
      !JSON.stringify(hidden).includes("prod-secret"),
      JSON.stringify(hidden),
    );
  });
});

Deno.test("serve condition-fields conformance: access checks explain a tags deny as requests enforce it", async () => {
  await withFixtures(async (f) => {
    // access.check reads another subject's policy, which needs admin.
    const admin = createServeCtx(f.repo, [
      ...TAG_GRANTS,
      grant({ actions: ["admin"], resource: { kind: "access", pattern: "*" } }),
    ]);
    const decisionFor = async (type: string, resource: string) => {
      const payload = type === "access.check"
        ? { subject: "user:caller", action: "read", resource }
        : { action: "read", resource };
      const ctx = type === "access.check" ? admin : f.ctx;
      const body = JSON.parse(
        reply(await sendRequest(ctx, request(type, payload)), type),
      ) as {
        payload?: { decisions?: Array<{ effect: string }> };
      };
      return body.payload?.decisions?.[0]?.effect;
    };
    for (const type of ["access.can-i", "access.check"]) {
      assertEquals(await decisionFor(type, "model:prod-db"), "deny", type);
      assertEquals(await decisionFor(type, "model:dev-db"), "allow", type);
      assertEquals(await decisionFor(type, "data:dev-db"), "allow", type);
      assertEquals(await decisionFor(type, "workflow:prod-flow"), "deny", type);
    }
  });
});

Deno.test("serve condition-fields conformance: data.query's page size says nothing about unreadable data", async () => {
  await withFixtures(async (f) => {
    for (const select of [undefined, "name"]) {
      const body = JSON.parse(reply(
        await sendRequest(
          f.ctx,
          request("data.query", {
            predicate: 'modelName == "prod-db"',
            limit: 1,
            ...(select ? { select } : {}),
          }),
        ),
        "data.query",
      )) as { payload?: { data?: { total?: number; limited?: boolean } } };
      assertEquals(body.payload?.data?.total, 0, `select=${select}`);
      assertEquals(body.payload?.data?.limited, false, `select=${select}`);
    }
  });
});

/** Saves a run of `workflow` started after every fixture run. */
async function saveLatestRun(
  f: Fixtures,
  workflow: Workflow,
): Promise<WorkflowRun> {
  const run = WorkflowRun.fromData({
    ...WorkflowRun.create(workflow).toData(),
    startedAt: new Date().toISOString(),
  });
  await f.repo.repoContext.workflowRunRepo.save(workflow.id, run);
  return run;
}

function queryError(frames: Frame[]): string {
  const error = errorFrame(frames);
  assertEquals(error?.error?.code, "data_query_failed", JSON.stringify(frames));
  return error!.error!.message;
}

Deno.test("serve condition-fields conformance: data.query's latestRun needs read on the workflow, and a refusal reads as not found", async () => {
  await withFixtures(async (f) => {
    // Step output readable as dev-db's data, from each workflow's latest
    // run. Distinct names, so neither write demotes the other's latest.
    const prodRun = await saveLatestRun(f, f.prodWorkflow);
    await saveRunStepData(f.repo, f.devModel, prodRun, "prod-out");
    const devRun = await saveLatestRun(f, f.devWorkflow);
    await saveRunStepData(f.repo, f.devModel, devRun, "dev-out");

    const ctx = createServeCtx(f.repo, TAG_GRANTS);
    const audit: AuditEvent[] = [];
    (ctx as { auditEmitter?: unknown }).auditEmitter = {
      emit: (event: AuditEvent) => audit.push(event),
    };
    const query = (payload: Record<string, unknown>, on = ctx) =>
      sendRequest(on, request("data.query", payload));

    // A denied workflow fails exactly as one that does not exist.
    const denied = queryError(
      await query({ predicate: 'workflowRunId == latestRun("prod-flow")' }),
    );
    const missing = queryError(
      await query({ predicate: 'workflowRunId == latestRun("no-flow")' }),
    );
    assertEquals(denied, "Workflow not found: prod-flow");
    assertEquals(missing, "Workflow not found: no-flow");
    assert(
      audit.some((event) =>
        event.outcome === "denied" && event.resourceKind === "workflow" &&
        event.resourceName === "prod-flow"
      ),
      JSON.stringify(audit),
    );

    // Selecting latestRun over readable data does not reveal the run id.
    const selected = await query({
      predicate: 'modelName == "dev-db"',
      select: 'latestRun("prod-flow")',
    });
    queryError(selected);
    assert(!JSON.stringify(selected).includes(prodRun.id));

    // A readable workflow's latest run is selected.
    const dev = reply(
      await query({
        predicate: 'workflowRunId == latestRun("dev-flow")',
      }),
      "data.query",
    );
    assert(dev.includes(devRun.id), dev);
    assert(!dev.includes(prodRun.id), dev);

    // Without the deny the prod run is selected, so the gate refused it.
    const open = reply(
      await query(
        { predicate: 'workflowRunId == latestRun("prod-flow")' },
        openCtx(f),
      ),
      "data.query",
    );
    assert(open.includes(prodRun.id), open);
  });
});

/** Saves the prod and dev vaults into `repo`. */
async function saveVaults(repo: ServeRepo): Promise<void> {
  for (const name of ["prod-vault", "dev-vault"]) {
    await repo.repoContext.vaultConfigRepo.save(
      VaultConfig.create(crypto.randomUUID(), name, "local_encryption", {}),
    );
  }
}

Deno.test("serve condition-fields conformance: vault requests are classified under the vault kind's fields, a name and the request's key", () => {
  assertEquals(
    CONDITION_FIELDS.vault.map((f) => `${f.name}:${f.role}`),
    ["name:resource", "key:request"],
  );
  const vaultTypes = [...serverRequestPayloadFields()]
    .map(([type]) => type)
    .filter((type) => type.startsWith("vault.") && type !== "vault.type.search")
    .filter((type) => type !== "vault.audit-trail")
    .sort();
  assertEquals(
    vaultTypes.filter((type) => CATEGORIES[type] !== "vault"),
    [],
    "Every vault request is decided under the vault kind",
  );
});

Deno.test("serve condition-fields conformance: vault.search keeps the vaults a vault grant's name condition admits", async () => {
  await withServeRepo(async (repo) => {
    await saveVaults(repo);
    const ctx = createServeCtx(repo, [
      grant({
        actions: ["read"],
        resource: { kind: "vault", pattern: "*" },
        condition: 'name == "dev-vault"',
      }),
    ]);
    const body = reply(
      await sendRequest(ctx, request("vault.search", {})),
      "vault.search",
    );
    assert(body.includes("dev-vault"), body);
    assert(!body.includes("prod-vault"), body);
  });
});

Deno.test("serve condition-fields conformance: vault.migrate is refused by a vault deny on the vault's name only", async () => {
  await withServeRepo(async (repo) => {
    await saveVaults(repo);
    const ctx = createServeCtx(repo, [
      grant({ actions: ["admin"], resource: { kind: "model", pattern: "*" } }),
      grant({
        effect: "deny",
        actions: ["admin"],
        resource: { kind: "vault", pattern: "*" },
        condition: 'name.startsWith("prod-")',
      }),
    ]);
    const refused = errorFrame(
      await sendRequest(
        ctx,
        request("vault.migrate", {
          vaultName: "prod-vault",
          targetType: "local_encryption",
        }),
      ),
    );
    assertEquals(refused?.error?.code, "unauthorized");
    assert(
      refused!.error!.message.includes("vault:prod-vault"),
      refused!.error!.message,
    );
    const other = errorFrame(
      await sendRequest(
        ctx,
        request("vault.migrate", {
          vaultName: "dev-vault",
          targetType: "local_encryption",
        }),
      ),
    );
    assert(other?.error?.code !== "unauthorized", other?.error?.message);
  });
});

Deno.test("serve condition-fields conformance: a vault key condition never fails closed on a request without a key", async () => {
  await withServeRepo(async (repo) => {
    await saveVaults(repo);
    const ctx = createServeCtx(repo, [
      grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
      grant({
        effect: "deny",
        actions: ["read"],
        resource: { kind: "vault", pattern: "*" },
        condition: 'key == "root"',
      }),
    ]);
    for (
      const [type, payload] of [
        ["vault.get", { vaultNameOrId: "dev-vault" }],
        ["vault.describe", { vaultNameOrId: "dev-vault" }],
        ["vault.list-keys", { vaultName: "dev-vault" }],
        ["vault.search", {}],
      ] as const
    ) {
      const error = errorFrame(await sendRequest(ctx, request(type, payload)));
      assert(
        error?.error?.code !== "unauthorized",
        `${type}: ${error?.error?.message}`,
      );
    }
    const keyed = errorFrame(
      await sendRequest(
        ctx,
        request("vault.inspect", { vaultName: "dev-vault", key: "root" }),
      ),
    );
    assertEquals(keyed?.error?.code, "unauthorized");
  });
});
