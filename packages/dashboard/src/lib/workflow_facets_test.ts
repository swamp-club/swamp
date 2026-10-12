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
  applyWorkflowFilter,
  EMPTY_FILTER,
  facetIndex,
  groupWorkflows,
  isFilterActive,
  prefixOptions,
  workflowPrefix,
  type WorkflowRef,
} from "./workflow_facets.ts";

Deno.test("workflowPrefix: scope, separators, none", () => {
  assertEquals(workflowPrefix("@acme/rotate-keys"), "@acme");
  assertEquals(workflowPrefix("deploy-api"), "deploy");
  assertEquals(workflowPrefix("etl_orders"), "etl");
  assertEquals(workflowPrefix("infra.k8s"), "infra");
  assertEquals(workflowPrefix("ops/runbook"), "ops");
  assertEquals(workflowPrefix("standalone"), null);
  assertEquals(workflowPrefix("trailing-"), null);
  assertEquals(workflowPrefix("@noscope"), null);
});

const workflows: WorkflowRef[] = [
  { name: "deploy-api", id: "id-api" },
  { name: "deploy-web", trigger: { schedule: "0 * * * *" } },
  { name: "sync-crm", id: "id-crm" },
  { name: "standalone" },
];

const facets = facetIndex({
  scheduled: [{ workflowName: "sync-crm" }],
  webhooks: [
    { route: "/hooks/push", workflow: "deploy-api" },
    { route: "/hooks/mirror", workflow: "id-api" },
    { route: "/hooks/crm", workflow: "sync-crm" },
  ],
});

Deno.test("facetIndex: schedule from file or health, webhooks by name or id", () => {
  assertEquals(facets(workflows[0]), {
    prefix: "deploy",
    scheduled: false,
    webhooks: ["/hooks/mirror", "/hooks/push"],
    kinds: ["webhook"],
  });
  assertEquals(facets(workflows[1]).kinds, ["schedule"]);
  assertEquals(facets(workflows[2]).kinds, ["schedule", "webhook"]);
  assertEquals(facets(workflows[3]).kinds, ["manual"]);
});

const names = (items: WorkflowRef[]) => items.map((w) => w.name);
const id = (w: WorkflowRef) => w;

Deno.test("applyWorkflowFilter: facets combine with AND", () => {
  assertEquals(
    names(
      applyWorkflowFilter(
        workflows,
        { ...EMPTY_FILTER, prefixes: ["deploy"] },
        id,
        facets,
      ),
    ),
    ["deploy-api", "deploy-web"],
  );
  assertEquals(
    names(
      applyWorkflowFilter(
        workflows,
        { ...EMPTY_FILTER, triggers: ["schedule"] },
        id,
        facets,
      ),
    ),
    ["deploy-web", "sync-crm"],
  );
  assertEquals(
    names(
      applyWorkflowFilter(
        workflows,
        { ...EMPTY_FILTER, triggers: ["manual"] },
        id,
        facets,
      ),
    ),
    ["standalone"],
  );
  assertEquals(
    names(
      applyWorkflowFilter(
        workflows,
        { ...EMPTY_FILTER, webhooks: ["/hooks/push"] },
        id,
        facets,
      ),
    ),
    ["deploy-api"],
  );
  assertEquals(
    names(
      applyWorkflowFilter(
        workflows,
        { ...EMPTY_FILTER, prefixes: ["deploy"], triggers: ["schedule"] },
        id,
        facets,
      ),
    ),
    ["deploy-web"],
  );
});

Deno.test("applyWorkflowFilter: fuzzy query matches names and routes", () => {
  assertEquals(
    names(
      applyWorkflowFilter(
        workflows,
        { ...EMPTY_FILTER, query: "dweb" },
        id,
        facets,
      ),
    ),
    ["deploy-web"],
  );
  assertEquals(
    names(
      applyWorkflowFilter(
        workflows,
        { ...EMPTY_FILTER, query: "mirror" },
        id,
        facets,
      ),
    ),
    ["deploy-api"],
  );
});

Deno.test("applyWorkflowFilter: values within a facet combine with OR", () => {
  assertEquals(
    names(
      applyWorkflowFilter(
        workflows,
        { ...EMPTY_FILTER, prefixes: ["deploy", "sync"] },
        id,
        facets,
      ),
    ),
    ["deploy-api", "deploy-web", "sync-crm"],
  );
  assertEquals(
    names(
      applyWorkflowFilter(
        workflows,
        { ...EMPTY_FILTER, triggers: ["webhook", "manual"] },
        id,
        facets,
      ),
    ),
    ["deploy-api", "sync-crm", "standalone"],
  );
  // OR within prefix, AND with trigger.
  assertEquals(
    names(
      applyWorkflowFilter(
        workflows,
        {
          ...EMPTY_FILTER,
          prefixes: ["deploy", "sync"],
          triggers: ["schedule"],
        },
        id,
        facets,
      ),
    ),
    ["deploy-web", "sync-crm"],
  );
});

Deno.test("isFilterActive: only when something narrows", () => {
  assertEquals(isFilterActive(EMPTY_FILTER), false);
  assertEquals(isFilterActive({ ...EMPTY_FILTER, query: "  " }), false);
  assertEquals(
    isFilterActive({ ...EMPTY_FILTER, triggers: ["webhook"] }),
    true,
  );
});

Deno.test("groupWorkflows: by prefix with Other last", () => {
  const groups = groupWorkflows(workflows, "prefix", id, facets);
  assertEquals(
    groups.map((g) => [g.label, names(g.items)]),
    [
      ["deploy", ["deploy-api", "deploy-web"]],
      ["sync", ["sync-crm"]],
      ["Other", ["standalone"]],
    ],
  );
});

Deno.test("groupWorkflows: by trigger in fixed order, multi-membership", () => {
  const groups = groupWorkflows(workflows, "trigger", id, facets);
  assertEquals(
    groups.map((g) => [g.label, names(g.items)]),
    [
      ["Scheduled", ["deploy-web", "sync-crm"]],
      ["Webhook", ["deploy-api", "sync-crm"]],
      ["Manual / API only", ["standalone"]],
    ],
  );
});

Deno.test("groupWorkflows: by webhook route, unhooked last", () => {
  const groups = groupWorkflows(workflows, "webhook", id, facets);
  assertEquals(groups.map((g) => g.label), [
    "/hooks/crm",
    "/hooks/mirror",
    "/hooks/push",
    "No webhook",
  ]);
});

Deno.test("groupWorkflows: none is a single group", () => {
  assertEquals(groupWorkflows(workflows, "none", id, facets).length, 1);
});

Deno.test("prefixOptions: counts, most common first", () => {
  assertEquals(
    prefixOptions(["deploy-a", "deploy-b", "sync-a", "x"]),
    [{ prefix: "deploy", count: 2 }, { prefix: "sync", count: 1 }],
  );
});
