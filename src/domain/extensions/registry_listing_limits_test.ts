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
import type {
  ExtensionContentMetadata,
  ExtractedArgument,
  ExtractedMethod,
  ExtractedModel,
} from "./extension_content.ts";
import {
  REGISTRY_LISTING_LIMITS,
  registryListingLimitBreaches,
} from "./registry_listing_limits.ts";

function emptyMetadata(): ExtensionContentMetadata {
  return {
    models: [],
    extensions: [],
    workflows: [],
    vaults: [],
    datastores: [],
    reports: [],
    webhooks: [],
    skills: [],
  };
}

function args(n: number): ExtractedArgument[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `a${i}`,
    type: "string",
    description: "",
    required: false,
  }));
}

function methods(n: number, argCount = 0): ExtractedMethod[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `m${i}`,
    description: "",
    arguments: args(argCount),
  }));
}

function model(i: number, overrides: Partial<ExtractedModel> = {}) {
  return {
    fileName: `m${i}.ts`,
    type: `@acme/thing/m${i}`,
    version: "2026.11.06.1",
    globalArguments: [],
    methods: methods(1),
    resources: [],
    files: [],
    ...overrides,
  };
}

Deno.test("registryListingLimitBreaches: a listing at every top-level limit has no breach", () => {
  const metadata = emptyMetadata();
  metadata.models = Array.from(
    { length: REGISTRY_LISTING_LIMITS.models },
    (_, i) => model(i),
  );
  assertEquals(registryListingLimitBreaches(metadata), []);
});

Deno.test("registryListingLimitBreaches: one model over the limit is a top-level breach with no owner", () => {
  const metadata = emptyMetadata();
  metadata.models = Array.from({ length: 51 }, (_, i) => model(i));
  assertEquals(registryListingLimitBreaches(metadata), [
    { list: "models", limit: 50, count: 51 },
  ]);
});

Deno.test("registryListingLimitBreaches: each top-level kind breaches one over its limit", () => {
  const n = (limit: number) => Array.from({ length: limit + 1 }, (_, i) => i);
  const L = REGISTRY_LISTING_LIMITS;
  const cases: Array<[string, number, Partial<ExtensionContentMetadata>]> = [
    ["workflows", L.workflows, {
      workflows: n(L.workflows).map((i) => ({
        fileName: `w${i}.yaml`,
        id: `w${i}`,
        name: `w${i}`,
        description: "",
        jobs: [],
      })),
    }],
    ["vaults", L.vaults, {
      vaults: n(L.vaults).map((i) => ({
        fileName: `v${i}.ts`,
        type: `@acme/v${i}`,
        name: `v${i}`,
        description: "",
        hasConfigSchema: false,
        configFields: [],
      })),
    }],
    ["datastores", L.datastores, {
      datastores: n(L.datastores).map((i) => ({
        fileName: `d${i}.ts`,
        type: `@acme/d${i}`,
        name: `d${i}`,
        description: "",
        hasConfigSchema: false,
        configFields: [],
      })),
    }],
    ["reports", L.reports, {
      reports: n(L.reports).map((i) => ({
        fileName: `r${i}.ts`,
        name: `r${i}`,
        description: "",
        scope: "method",
        labels: [],
      })),
    }],
    ["skills", L.skills, {
      skills: n(L.skills).map((i) => ({
        dirName: `s${i}`,
        name: `s${i}`,
        description: "",
        hasScripts: false,
        fileCount: 1,
      })),
    }],
    ["webhooks", L.webhooks, {
      webhooks: n(L.webhooks).map((i) => ({
        fileName: `h${i}.ts`,
        type: `@acme/h${i}`,
        name: `h${i}`,
        description: "",
      })),
    }],
    ["extensions", L.extensions, {
      extensions: n(L.extensions).map((i) => ({
        fileName: `e${i}.ts`,
        extendsType: "@acme/thing",
        methods: [],
        resources: [],
      })),
    }],
  ];
  for (const [list, limit, lists] of cases) {
    assertEquals(
      registryListingLimitBreaches({ ...emptyMetadata(), ...lists }),
      [{ list, limit, count: limit + 1 }],
      list,
    );
  }
});

Deno.test("registryListingLimitBreaches: per-model and per-method breaches name the behavior type and fileName", () => {
  const metadata = emptyMetadata();
  metadata.models = [
    model(1, {
      methods: methods(51),
      globalArguments: args(31),
    }),
    model(2, {
      methods: [{ name: "run", description: "", arguments: args(31) }],
    }),
    model(3, { methods: methods(50, 30), globalArguments: args(30) }),
  ];
  assertEquals(registryListingLimitBreaches(metadata), [
    {
      list: "globalArguments",
      limit: 30,
      count: 31,
      owner: "behavior @acme/thing/m1 (m1.ts)",
    },
    {
      list: "methods",
      limit: 50,
      count: 51,
      owner: "behavior @acme/thing/m1 (m1.ts)",
    },
    {
      list: "arguments",
      limit: 30,
      count: 31,
      owner: "method run of behavior @acme/thing/m2 (m2.ts)",
    },
  ]);
});

Deno.test("registryListingLimitBreaches: reports every breach, not only the first", () => {
  const metadata = emptyMetadata();
  metadata.models = Array.from(
    { length: 51 },
    (_, i) => model(i, { methods: methods(i === 0 ? 51 : 1) }),
  );
  metadata.workflows = [{
    fileName: "deploy.yaml",
    id: "w1",
    name: "deploy",
    description: "",
    jobs: Array.from({ length: 21 }, (_, i) => ({
      name: `j${i}`,
      description: "",
      steps: [],
    })),
  }];
  assertEquals(
    registryListingLimitBreaches(metadata).map((b) => b.list),
    ["models", "methods", "jobs"],
  );
});

Deno.test("registryListingLimitBreaches: nested workflow, vault, datastore, report and extension lists are checked", () => {
  const metadata = emptyMetadata();
  metadata.workflows = [{
    fileName: "deploy.yaml",
    id: "w1",
    name: "deploy",
    description: "",
    jobs: [{
      name: "build",
      description: "",
      steps: Array.from({ length: 51 }, (_, i) => ({
        name: `s${i}`,
        description: "",
        taskType: "model_method",
        modelIdOrName: "x",
        methodName: "run",
      })),
    }],
  }];
  metadata.vaults = [{
    fileName: "v.ts",
    type: "@acme/vault",
    name: "v",
    description: "",
    hasConfigSchema: true,
    configFields: args(31),
  }];
  metadata.datastores = [{
    fileName: "d.ts",
    type: "@acme/store",
    name: "d",
    description: "",
    hasConfigSchema: true,
    configFields: args(31),
  }];
  metadata.reports = [{
    fileName: "r.ts",
    name: "r",
    description: "",
    scope: "method",
    labels: Array.from({ length: 21 }, (_, i) => `l${i}`),
  }];
  metadata.extensions = [{
    fileName: "ext.ts",
    extendsType: "@acme/thing",
    methods: methods(51),
    resources: Array.from(
      { length: REGISTRY_LISTING_LIMITS.resourcesPerModel + 1 },
      (_, i) => ({ key: `r${i}`, description: "", lifetime: "" }),
    ),
  }];
  assertEquals(registryListingLimitBreaches(metadata), [
    {
      list: "methods",
      limit: 50,
      count: 51,
      owner: "extension of @acme/thing (ext.ts)",
    },
    {
      list: "resources",
      limit: 100,
      count: 101,
      owner: "extension of @acme/thing (ext.ts)",
    },
    {
      list: "steps",
      limit: 50,
      count: 51,
      owner: "job build of workflow deploy (deploy.yaml)",
    },
    {
      list: "configFields",
      limit: 30,
      count: 31,
      owner: "vault @acme/vault (v.ts)",
    },
    {
      list: "configFields",
      limit: 30,
      count: 31,
      owner: "datastore @acme/store (d.ts)",
    },
    { list: "labels", limit: 20, count: 21, owner: "report r (r.ts)" },
  ]);
});
