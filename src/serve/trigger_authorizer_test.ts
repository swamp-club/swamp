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

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Grant } from "../domain/models/access/grant_model.ts";
import {
  GrantBasedAccessDecisionService,
  SERVICE_TRIGGER_DEFAULT_GRANT_ID,
} from "../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../domain/access/policy_snapshot.ts";
import {
  SCHEDULER_PRINCIPAL,
  WEBHOOK_PRINCIPAL,
} from "../domain/access/service_principal.ts";
import type { WorkflowRepository } from "../domain/workflows/repositories.ts";
import { Workflow } from "../domain/workflows/workflow.ts";
import type { WorkflowId } from "../domain/workflows/workflow_id.ts";
import { evaluateGrantCondition } from "../infrastructure/cel/grant_condition_environment.ts";
import { createTriggerAuthorizer } from "./trigger_authorizer.ts";

function repoWith(workflows: Workflow[]): WorkflowRepository {
  return {
    findAll: () => Promise.resolve(workflows),
    findById: (id: WorkflowId) =>
      Promise.resolve(workflows.find((w) => w.id === id) ?? null),
    findByName: (name: string) =>
      Promise.resolve(workflows.find((w) => w.name === name) ?? null),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => crypto.randomUUID() as WorkflowId,
    getPath: () => "",
  };
}

function loaderWith(grants: Grant[]) {
  return {
    decisionService: new GrantBasedAccessDecisionService(
      new PolicySnapshot(grants, [], evaluateGrantCondition),
    ),
  };
}

function denyGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "service", name: "webhook" },
    effect: "deny",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "deploy" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const deploy = Workflow.create({
  name: "deploy",
  tags: { env: "prod" },
  jobs: [],
});

Deno.test("createTriggerAuthorizer: auth mode none allows every run", async () => {
  const authorize = createTriggerAuthorizer({
    authMode: "none",
    workflowRepo: repoWith([deploy]),
  });
  const result = await authorize(SCHEDULER_PRINCIPAL, "deploy");
  assertEquals(result.allowed, true);
  assertEquals(result.workflowIdOrName, "deploy");
});

Deno.test("createTriggerAuthorizer: allows by the service default with no grants", async () => {
  const authorize = createTriggerAuthorizer({
    authMode: "token",
    policySnapshotLoader: loaderWith([]),
    workflowRepo: repoWith([deploy]),
  });
  const result = await authorize(WEBHOOK_PRINCIPAL, "deploy");
  assertEquals(result.allowed, true);
  assertEquals(result.decision?.grantId, SERVICE_TRIGGER_DEFAULT_GRANT_ID);
});

Deno.test("createTriggerAuthorizer: a workflow configured by id is decided on its canonical name", async () => {
  const deny = denyGrant();
  const authorize = createTriggerAuthorizer({
    authMode: "token",
    policySnapshotLoader: loaderWith([deny]),
    workflowRepo: repoWith([deploy]),
  });
  const result = await authorize(WEBHOOK_PRINCIPAL, deploy.id);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, `denied by grant ${deny.id}`);
  assertEquals(result.workflowIdOrName, deploy.id);
  assertEquals(result.resource.name, "deploy");
  assertEquals(result.decision?.grantId, deny.id);
});

Deno.test("createTriggerAuthorizer: a tag-conditioned deny sees the workflow's tags", async () => {
  const authorize = createTriggerAuthorizer({
    authMode: "token",
    policySnapshotLoader: loaderWith([
      denyGrant({
        resource: { kind: "workflow", pattern: "*" },
        condition: 'tags.env == "prod"',
      }),
    ]),
    workflowRepo: repoWith([deploy]),
  });
  assertEquals((await authorize(WEBHOOK_PRINCIPAL, "deploy")).allowed, false);
});

Deno.test("createTriggerAuthorizer: a deny for one service principal leaves the other allowed", async () => {
  const authorize = createTriggerAuthorizer({
    authMode: "token",
    policySnapshotLoader: loaderWith([denyGrant()]),
    workflowRepo: repoWith([deploy]),
  });
  assertEquals((await authorize(SCHEDULER_PRINCIPAL, "deploy")).allowed, true);
});

Deno.test("createTriggerAuthorizer: an unresolved workflow is decided on the configured value", async () => {
  const authorize = createTriggerAuthorizer({
    authMode: "token",
    policySnapshotLoader: loaderWith([]),
    workflowRepo: repoWith([]),
  });
  const result = await authorize(WEBHOOK_PRINCIPAL, "missing");
  assertEquals(result.allowed, true);
  assertEquals(result.workflowIdOrName, "missing");
  assertEquals(result.resource.fields, { name: "missing" });
});

Deno.test("createTriggerAuthorizer: a missing policy snapshot refuses", async () => {
  const authorize = createTriggerAuthorizer({
    authMode: "oauth",
    workflowRepo: repoWith([deploy]),
  });
  const result = await authorize(SCHEDULER_PRINCIPAL, "deploy");
  assertEquals(result.allowed, false);
  assertEquals(
    result.reason,
    "authorization is enabled but no policy snapshot is loaded",
  );
});

Deno.test("createTriggerAuthorizer: a failing decision refuses without throwing", async () => {
  const authorize = createTriggerAuthorizer({
    authMode: "token",
    policySnapshotLoader: {
      get decisionService(): GrantBasedAccessDecisionService {
        throw new Error("snapshot unavailable");
      },
    },
    workflowRepo: repoWith([deploy]),
  });
  const result = await authorize(SCHEDULER_PRINCIPAL, "deploy");
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason ?? "", "snapshot unavailable");
});

Deno.test("createTriggerAuthorizer: a workflow lookup that throws refuses rather than deciding without tags", async () => {
  const failing: WorkflowRepository = {
    ...repoWith([deploy]),
    findByName: () => Promise.reject(new Error("datastore unreachable")),
  };
  const authorize = createTriggerAuthorizer({
    authMode: "token",
    policySnapshotLoader: loaderWith([]),
    workflowRepo: failing,
  });
  const result = await authorize(WEBHOOK_PRINCIPAL, deploy.id);
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason ?? "", "datastore unreachable");
});

Deno.test("createTriggerAuthorizer: auth mode none still allows when the lookup throws", async () => {
  const failing: WorkflowRepository = {
    ...repoWith([deploy]),
    findByName: () => Promise.reject(new Error("datastore unreachable")),
  };
  const authorize = createTriggerAuthorizer({
    authMode: "none",
    workflowRepo: failing,
  });
  assertEquals((await authorize(SCHEDULER_PRINCIPAL, "deploy")).allowed, true);
});

Deno.test("createTriggerAuthorizer: runs the configured id, not a same-named workflow that shadows it", async () => {
  // An extension workflow configured by id, shadowed by a repo workflow of
  // the same name carrying prod tags. Execution resolves the configured id
  // to the extension workflow, so that is what must be decided on and run.
  const extension = Workflow.create({ name: "deploy", jobs: [] });
  const shadow = Workflow.create({
    name: "deploy",
    tags: { env: "prod" },
    jobs: [],
  });
  const composite: WorkflowRepository = {
    ...repoWith([shadow, extension]),
    findByName: (name: string) =>
      Promise.resolve(name === "deploy" ? shadow : null),
    findById: (id: WorkflowId) =>
      Promise.resolve(id === extension.id ? extension : null),
  };
  const authorize = createTriggerAuthorizer({
    authMode: "token",
    policySnapshotLoader: loaderWith([]),
    workflowRepo: composite,
  });
  const result = await authorize(WEBHOOK_PRINCIPAL, extension.id);
  assertEquals(result.allowed, true);
  assertEquals(result.workflowIdOrName, extension.id);
  assertEquals(result.resource.name, "deploy");
  assertEquals(result.resource.fields, { name: "deploy" });
});

Deno.test("createTriggerAuthorizer: reports the id of the workflow it decided on", async () => {
  const authorize = createTriggerAuthorizer({
    authMode: "token",
    policySnapshotLoader: loaderWith([]),
    workflowRepo: repoWith([deploy]),
  });
  assertEquals(
    (await authorize(WEBHOOK_PRINCIPAL, "deploy")).workflowId,
    deploy.id,
  );
  assertEquals(
    (await authorize(WEBHOOK_PRINCIPAL, "missing")).workflowId,
    undefined,
  );
});
