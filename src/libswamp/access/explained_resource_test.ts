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
  explainedAccessResource,
  type ExplainedResourceDeps,
} from "./explained_resource.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";

const SHELL = ModelType.create("command/shell");

function depsWith(options: {
  definitions?: Definition[];
  workflows?: Workflow[];
  vaults?: { id: string; name: string }[];
  failLookups?: boolean;
}): ExplainedResourceDeps {
  const definitions = options.definitions ?? [];
  const workflows = options.workflows ?? [];
  const vaults = options.vaults ?? [];
  const fail = () => Promise.reject(new Error("lookup broke"));
  const entry = (d: Definition | undefined) =>
    d ? { definition: d, type: SHELL } : null;
  return {
    definitionRepo: {
      findByNameGlobal: (name: string) =>
        options.failLookups
          ? fail()
          : Promise.resolve(entry(definitions.find((d) => d.name === name))),
      findByIdCached: (id: string) =>
        Promise.resolve(entry(definitions.find((d) => d.id === id))),
    } as unknown as DefinitionRepository,
    workflowRepo: {
      findByName: (name) =>
        options.failLookups
          ? fail()
          : Promise.resolve(workflows.find((w) => w.name === name) ?? null),
      findById: (id) =>
        Promise.resolve(workflows.find((w) => w.id === id) ?? null),
    },
    vaultConfigRepo: {
      findByName: (name: string) => {
        if (options.failLookups) return fail();
        const vault = vaults.find((v) => v.name === name);
        return Promise.resolve(vault ? { ...vault, type: "local" } : null);
      },
      findById: (id: string) => {
        const vault = vaults.find((v) => v.id === id);
        return Promise.resolve(vault ? { ...vault, type: "local" } : null);
      },
      findAll: () =>
        Promise.resolve(vaults.map((v) => ({ ...v, type: "local" }))),
    } as unknown as ExplainedResourceDeps["vaultConfigRepo"],
  };
}

Deno.test("explainedAccessResource: a model by name carries its stored type and tags", async () => {
  const probe = Definition.create({
    name: "team-x-probe",
    tags: { team: "team-x" },
  });
  const resource = await explainedAccessResource(
    depsWith({ definitions: [probe] }),
    "model",
    "team-x-probe",
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

Deno.test("explainedAccessResource: a model by id is explained by its name", async () => {
  const probe = Definition.create({ name: "team-x-probe" });
  const resource = await explainedAccessResource(
    depsWith({ definitions: [probe] }),
    "model",
    probe.id,
  );
  assertEquals(resource.name, "team-x-probe");
  assertEquals(resource.fields.modelType, "command/shell");
});

Deno.test("explainedAccessResource: data names carry ns, not modelType", async () => {
  const probe = Definition.create({ name: "team-x-probe" });
  const resource = await explainedAccessResource(
    depsWith({ definitions: [probe] }),
    "data",
    "team-x-probe",
  );
  assertEquals(resource.kind, "data");
  assertEquals(resource.fields.modelType, undefined);
  assertEquals(resource.fields.tags, {});
});

Deno.test("explainedAccessResource: a workflow carries its tags", async () => {
  const deploy = Workflow.create({ name: "deploy", tags: { env: "prod" } });
  const resource = await explainedAccessResource(
    depsWith({ workflows: [deploy] }),
    "workflow",
    "deploy",
  );
  assertEquals(resource.fields, { name: "deploy", tags: { env: "prod" } });
});

Deno.test("explainedAccessResource: a name that matches nothing has no tags", async () => {
  const resource = await explainedAccessResource(
    depsWith({}),
    "model",
    "team-x-new",
  );
  assertEquals(resource.fields, { name: "team-x-new", tags: {} });
});

Deno.test("explainedAccessResource: a wildcard or access resource is a kind check", async () => {
  const wildcard = await explainedAccessResource(depsWith({}), "model", "x-*");
  assertEquals(wildcard.name, "x-*");
  assertEquals(wildcard.scope, "kind");
  const access = await explainedAccessResource(depsWith({}), "access", "g1");
  assertEquals(access.name, "g1");
  assertEquals(access.scope, "kind");
});

Deno.test("explainedAccessResource: a vault is explained by the name it resolves to", async () => {
  const id = crypto.randomUUID();
  const resource = await explainedAccessResource(
    depsWith({ vaults: [{ id, name: "prod" }] }),
    "vault",
    "prod",
  );
  assertEquals(resource, {
    kind: "vault",
    name: "prod",
    fields: { name: "prod" },
  });
});

Deno.test("explainedAccessResource: a failed lookup is explained by name alone and reported", async () => {
  const errors: unknown[] = [];
  const resource = await explainedAccessResource(
    depsWith({ failLookups: true }),
    "model",
    "team-x-probe",
    {},
    (error) => errors.push(error),
  );
  assertEquals(resource.fields, { name: "team-x-probe" });
  assertEquals(errors.length, 1);
});

Deno.test("explainedAccessResource: extra fields override, merging maps one level", async () => {
  const probe = Definition.create({
    name: "team-x-probe",
    tags: { team: "team-x", env: "dev" },
  });
  const resource = await explainedAccessResource(
    depsWith({ definitions: [probe] }),
    "model",
    "team-x-probe",
    { modelType: "@scope/tracker", tags: { env: "prod" }, methodName: "run" },
  );
  assertEquals(resource.fields, {
    name: "team-x-probe",
    modelType: "@scope/tracker",
    tags: { team: "team-x", env: "prod" },
    methodName: "run",
  });
});
