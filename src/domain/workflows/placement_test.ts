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
import { mergePlacementFields, resolvePlacement } from "./placement.ts";

Deno.test("mergePlacementFields: both undefined returns undefined", () => {
  assertEquals(mergePlacementFields(undefined, undefined), undefined);
});

Deno.test("mergePlacementFields: parent only returns parent", () => {
  const parent = { target: "w1", labels: { env: "prod" } };
  assertEquals(mergePlacementFields(parent, undefined), parent);
});

Deno.test("mergePlacementFields: child only returns child", () => {
  const child = { target: "w2", platform: "linux" };
  assertEquals(mergePlacementFields(undefined, child), child);
});

Deno.test("mergePlacementFields: child overrides parent per-field", () => {
  const parent = {
    target: "w1",
    labels: { env: "prod", region: "us-east" },
    platform: "linux",
    queueTimeout: 60,
  };
  const child = { labels: { env: "staging" } };
  const merged = mergePlacementFields(parent, child);
  assertEquals(merged, {
    target: "w1",
    labels: { env: "staging" },
    platform: "linux",
    queueTimeout: 60,
  });
});

Deno.test("mergePlacementFields: child undefined fields inherit from parent", () => {
  const parent = { target: "w1", labels: { env: "prod" } };
  const child = { platform: "darwin" };
  const merged = mergePlacementFields(parent, child);
  assertEquals(merged, {
    target: "w1",
    labels: { env: "prod" },
    platform: "darwin",
    queueTimeout: undefined,
  });
});

Deno.test("mergePlacementFields: explicit empty labels clears inherited labels", () => {
  const parent = { labels: { env: "prod", region: "us-east" } };
  const child = { labels: {} };
  const merged = mergePlacementFields(parent, child);
  assertEquals(merged?.labels, {});
});

Deno.test("mergePlacementFields: three-level merge (workflow → job → step)", () => {
  const workflow = { labels: { pool: "gke", fleet: "v3" }, platform: "linux" };
  const job = { labels: { pool: "gke", fleet: "v4" } };
  const step = { target: "special-worker" };

  const jobEffective = mergePlacementFields(workflow, job);
  const stepEffective = mergePlacementFields(jobEffective, step);

  assertEquals(stepEffective, {
    target: "special-worker",
    labels: { pool: "gke", fleet: "v4" },
    platform: "linux",
    queueTimeout: undefined,
  });
});

Deno.test("mergePlacementFields: job clears all placement with empty overrides", () => {
  const workflow = {
    target: "w1",
    labels: { pool: "gke" },
    platform: "linux",
    queueTimeout: 30,
  };
  const job = { labels: {} };
  const step = {};

  const jobEffective = mergePlacementFields(workflow, job);
  const stepEffective = mergePlacementFields(jobEffective, step);

  assertEquals(stepEffective?.labels, {});
  assertEquals(stepEffective?.target, "w1");
});

Deno.test("resolvePlacement: undefined fields returns undefined", () => {
  assertEquals(resolvePlacement(undefined), undefined);
});

Deno.test("resolvePlacement: empty labels and no target/platform returns undefined", () => {
  assertEquals(resolvePlacement({ labels: {} }), undefined);
  assertEquals(resolvePlacement({}), undefined);
});

Deno.test("resolvePlacement: converts queueTimeout seconds to milliseconds", () => {
  const result = resolvePlacement({ target: "w1", queueTimeout: 30 });
  assertEquals(result?.queueTimeoutMs, 30_000);
});

Deno.test("resolvePlacement: target alone produces placement", () => {
  const result = resolvePlacement({ target: "w1" });
  assertEquals(result, {
    target: "w1",
    labels: undefined,
    platform: undefined,
    queueTimeoutMs: undefined,
  });
});

Deno.test("resolvePlacement: labels alone produces placement", () => {
  const result = resolvePlacement({ labels: { env: "prod" } });
  assertEquals(result, {
    target: undefined,
    labels: { env: "prod" },
    platform: undefined,
    queueTimeoutMs: undefined,
  });
});
