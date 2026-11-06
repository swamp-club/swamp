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
  explainedForAction,
  runConditionValue,
  withRunCondition,
  withRunPending,
} from "./access_resources.ts";
import { assertEquals } from "@std/assert";
import {
  isVaultMethod,
  modelAccessResource,
  tagsChanged,
  unresolvedAccessResource,
  VAULT_METHODS,
  vaultKindResource,
  workflowAccessResource,
} from "./access_resources.ts";
import { Definition } from "../definitions/definition.ts";
import { ModelType } from "../models/model_type.ts";
import { Workflow } from "../workflows/workflow.ts";

function lookup(name: string, type: string, tags?: Record<string, string>) {
  return {
    definition: Definition.create({ name, tags }),
    type: ModelType.create(type),
  };
}

Deno.test("modelAccessResource: carries the normalized type and tags", () => {
  const resource = modelAccessResource(
    lookup("team-x-probe", "command/shell", { team: "team-x" }),
  );
  assertEquals(resource, {
    kind: "model",
    name: "team-x-probe",
    fields: {
      name: "team-x-probe",
      modelType: "command/shell",
      tags: { team: "team-x" },
    },
  });
});

Deno.test("modelAccessResource: an untagged model has tags {}", () => {
  const resource = modelAccessResource(lookup("probe", "command/shell"));
  assertEquals(resource.fields.tags, {});
});

Deno.test("modelAccessResource: as data, carries ns instead of modelType", () => {
  const resource = modelAccessResource(
    lookup("tracker", "@acme/tracker"),
    "data",
  );
  assertEquals(resource.kind, "data");
  assertEquals(resource.fields.modelType, undefined);
  assertEquals(resource.fields.ns, "acme");
});

Deno.test("modelAccessResource: a control-plane model is an access record", () => {
  const resource = modelAccessResource(lookup("g1", "swamp/grant"));
  assertEquals(resource.kind, "access");
});

Deno.test("workflowAccessResource: carries the workflow's tags", () => {
  const workflow = Workflow.create({ name: "deploy", tags: { env: "prod" } });
  assertEquals(workflowAccessResource(workflow), {
    kind: "workflow",
    name: "deploy",
    fields: { name: "deploy", tags: { env: "prod" } },
  });
});

Deno.test("unresolvedAccessResource: says a missing resource has no tags", () => {
  assertEquals(unresolvedAccessResource("model", "nope").fields, {
    name: "nope",
    tags: {},
  });
  assertEquals(unresolvedAccessResource("data", "nope").fields, {
    name: "nope",
    tags: {},
    ns: "",
  });
  assertEquals(unresolvedAccessResource("access", "nope").fields, {
    name: "nope",
  });
});

Deno.test("vaultKindResource: names the key only when a request names one", () => {
  assertEquals(vaultKindResource("prod").fields, { name: "prod" });
  assertEquals(vaultKindResource("prod", "db").fields, {
    name: "prod",
    key: "db",
  });
});

Deno.test("vaultKindResource: names the method only when a request names one", () => {
  assertEquals(vaultKindResource("prod", undefined, "get").fields, {
    name: "prod",
    methodName: "get",
  });
  assertEquals(vaultKindResource("prod", "db", "put").fields, {
    name: "prod",
    key: "db",
    methodName: "put",
  });
});

Deno.test("isVaultMethod: accepts each vault verb and nothing else", () => {
  for (const method of VAULT_METHODS) assertEquals(isVaultMethod(method), true);
  for (const other of ["read", "write", "Get", "list", "", "vault.get"]) {
    assertEquals(isVaultMethod(other), false, other);
  }
});

Deno.test("tagsChanged: equal tag sets in any key order are unchanged", () => {
  assertEquals(
    tagsChanged({ team: "a", env: "prod" }, { env: "prod", team: "a" }),
    false,
  );
});

Deno.test("tagsChanged: no tags reads as an empty tag set", () => {
  assertEquals(tagsChanged(undefined, {}), false);
  assertEquals(tagsChanged({}, undefined), false);
  assertEquals(tagsChanged(undefined, { team: "a" }), true);
});

Deno.test("tagsChanged: a value, an added key or a removed key is a change", () => {
  assertEquals(tagsChanged({ team: "a" }, { team: "b" }), true);
  assertEquals(tagsChanged({ team: "a" }, { team: "a", env: "x" }), true);
  assertEquals(tagsChanged({ team: "a", env: "x" }, { team: "a" }), true);
  assertEquals(tagsChanged({ team: "a" }, { owner: "a" }), true);
});

Deno.test("runConditionValue: a user's sub is their id, so it compares with principal.sub", () => {
  assertEquals(
    runConditionValue({ initiatedBy: "user:alice", serveDriven: true }),
    {
      initiator: { kind: "user", id: "alice", sub: "alice" },
      serveDriven: true,
    },
  );
});

Deno.test("runConditionValue: a service run has an empty sub, so no person matches it", () => {
  assertEquals(
    runConditionValue({ initiatedBy: "service:scheduler", serveDriven: true })
      ?.initiator,
    { kind: "service", id: "scheduler", sub: "" },
  );
});

Deno.test("runConditionValue: no usable initiator gives nothing", () => {
  for (const initiatedBy of [undefined, "ghost", "alice", "user:", "bot:x"]) {
    assertEquals(
      runConditionValue({ initiatedBy, serveDriven: false }),
      undefined,
    );
  }
});

Deno.test("withRunCondition: omits the field with no usable initiator and clears pending", () => {
  const pending = withRunPending({
    kind: "workflow",
    name: "w",
    fields: { name: "w" },
  });
  assertEquals(pending.pending, ["run"]);
  const none = withRunCondition(pending, { serveDriven: true });
  assertEquals(none, { kind: "workflow", name: "w", fields: { name: "w" } });
  const some = withRunCondition(pending, {
    initiatedBy: "user:a",
    serveDriven: false,
  });
  assertEquals(some.pending, undefined);
  assertEquals("run" in some.fields, true);
});

Deno.test("explainedForAction: only approve on a workflow with no run named depends on one", () => {
  const workflow = { kind: "workflow" as const, name: "w", fields: {} };
  assertEquals(explainedForAction(workflow, "approve").pending, ["run"]);
  assertEquals(explainedForAction(workflow, "run").pending, undefined);
  assertEquals(
    explainedForAction({ ...workflow, fields: { run: {} } }, "approve").pending,
    undefined,
  );
});
