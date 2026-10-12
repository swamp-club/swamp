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

import { assertEquals } from "@std/assert";
import {
  modelAccessResource,
  unresolvedAccessResource,
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
