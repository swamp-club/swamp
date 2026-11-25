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
  clearEmptyPlacement,
  declaresPlacement,
  inheritedAffinityKey,
  type InheritedPlacement,
  inheritPlacement,
  mergePlacementFields,
  NestedPlacementModeSchema,
  resolveAffinityKey,
  resolvePlacement,
} from "./placement.ts";

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

Deno.test("resolvePlacement: an empty target, platform or label clears that field, as labels {} does", () => {
  assertEquals(resolvePlacement({ target: "" }), undefined);
  assertEquals(resolvePlacement({ platform: "" }), undefined);
  assertEquals(resolvePlacement({ labels: { host: "" } }), undefined);
  assertEquals(resolvePlacement({ target: "", queueTimeout: 30 }), undefined);
  assertEquals(resolvePlacement({ target: "", labels: { pool: "gpu" } }), {
    target: undefined,
    labels: { pool: "gpu" },
    platform: undefined,
    queueTimeoutMs: undefined,
  });
});

Deno.test("mergePlacementFields: an empty target at a lower level clears the inherited one", () => {
  const merged = mergePlacementFields({ target: "w1" }, { target: "" });
  assertEquals(resolvePlacement(merged), undefined);
});

Deno.test("clearEmptyPlacement: an empty label drops only its own key and names it", () => {
  assertEquals(
    clearEmptyPlacement({ labels: { pool: "gpu", host: "" } }),
    {
      placement: {
        target: undefined,
        labels: { pool: "gpu" },
        platform: undefined,
      },
      cleared: ["labels.host"],
    },
  );
});

Deno.test("clearEmptyPlacement: a placement left with nothing is unplaced, whatever else it carried", () => {
  assertEquals(
    clearEmptyPlacement({
      target: "",
      platform: "",
      queueTimeoutMs: 1000,
      affinityKey: "run-1",
    }),
    { placement: undefined, cleared: ["target", "platform"] },
  );
});

Deno.test("clearEmptyPlacement: a whitespace value is still a selector, so a typo never runs locally", () => {
  assertEquals(clearEmptyPlacement({ target: " " }), {
    placement: {
      target: " ",
      labels: undefined,
      platform: undefined,
    },
    cleared: [],
  });
});

Deno.test("clearEmptyPlacement: a placement with no empty value is returned as it was", () => {
  const placement = {
    target: "w1",
    labels: { env: "prod" },
    platform: "linux/amd64",
    queueTimeoutMs: 5000,
    affinityKey: "run-1",
  };
  assertEquals(clearEmptyPlacement(placement), { placement, cleared: [] });
});

Deno.test("resolveAffinityKey: resolves every workflow and job combination", () => {
  const cases: Array<
    [boolean | undefined, boolean | undefined, string | undefined]
  > = [
    [true, undefined, "run-1"],
    [true, true, "run-1"],
    [true, false, undefined],
    [false, undefined, undefined],
    [false, true, "run-1:build"],
    [false, false, undefined],
    [undefined, undefined, undefined],
    [undefined, true, "run-1:build"],
    [undefined, false, undefined],
  ];
  for (const [workflowAffinity, jobAffinity, expected] of cases) {
    assertEquals(
      resolveAffinityKey(workflowAffinity, jobAffinity, "run-1", "build"),
      expected,
      `workflow ${workflowAffinity}, job ${jobAffinity}`,
    );
  }
});

const SOURCE = { workflowName: "caddy", jobName: "install", stepName: "sudo" };

function inherited(
  fields: InheritedPlacement["fields"],
  affinityKey?: string,
): InheritedPlacement {
  return { fields, affinityKey, source: SOURCE };
}

Deno.test("inheritPlacement: a child with no placement takes the caller's", () => {
  assertEquals(
    inheritPlacement(inherited({ target: "w-a" }), [undefined, {}, {}]),
    { target: "w-a" },
  );
});

Deno.test("inheritPlacement: a child that places itself at any level drops everything inherited", () => {
  const from = inherited({ target: "w-a", queueTimeout: 5 });
  assertEquals(
    inheritPlacement(from, [{ labels: { fleet: "db" } }]),
    undefined,
  );
  assertEquals(
    inheritPlacement(from, [undefined, { platform: "linux" }]),
    undefined,
  );
  assertEquals(
    inheritPlacement(from, [undefined, undefined, { target: "w-b" }]),
    undefined,
  );
});

Deno.test("inheritPlacement: an explicit labels {} in the child keeps it local", () => {
  const from = inherited({ target: "w-a" });
  const base = inheritPlacement(from, [{ labels: {} }]);
  assertEquals(base, undefined);
  assertEquals(
    resolvePlacement(mergePlacementFields(base, { labels: {} })),
    undefined,
  );
});

Deno.test("inheritPlacement: a child's queueTimeout alone keeps the inherited placement", () => {
  const from = inherited({ target: "w-a", queueTimeout: 5 });
  assertEquals(
    mergePlacementFields(inheritPlacement(from, [{ queueTimeout: 9 }]), {
      queueTimeout: 9,
    }),
    { target: "w-a", labels: undefined, platform: undefined, queueTimeout: 9 },
  );
});

Deno.test("inheritPlacement: with nothing inherited there is no base", () => {
  assertEquals(inheritPlacement(undefined, []), undefined);
});

Deno.test("inheritedAffinityKey: the caller's pin holds for a child that places nothing", () => {
  assertEquals(
    inheritedAffinityKey(
      inherited({ labels: { fleet: "web" } }, "run-1"),
      [undefined, {}, { queueTimeout: 3 }],
      undefined,
    ),
    "run-1",
  );
});

Deno.test("inheritedAffinityKey: a child declaring placement at any level drops the pin", () => {
  const from = inherited({ labels: { fleet: "web" } }, "run-1");
  assertEquals(
    inheritedAffinityKey(from, [{ target: "w-b" }], undefined),
    undefined,
  );
  assertEquals(
    inheritedAffinityKey(
      from,
      [undefined, { labels: { fleet: "db" } }],
      undefined,
    ),
    undefined,
  );
  assertEquals(
    inheritedAffinityKey(
      from,
      [undefined, undefined, { platform: "linux" }],
      undefined,
    ),
    undefined,
  );
});

Deno.test("inheritedAffinityKey: a child job with affinity false drops the pin", () => {
  assertEquals(
    inheritedAffinityKey(inherited({ target: "w-a" }, "run-1"), [], false),
    undefined,
  );
});

Deno.test("inheritedAffinityKey: no inherited pin yields none", () => {
  assertEquals(inheritedAffinityKey(undefined, [], undefined), undefined);
  assertEquals(
    inheritedAffinityKey(inherited({ target: "w-a" }), [], true),
    undefined,
  );
});

Deno.test("declaresPlacement: queueTimeout alone is not a placement", () => {
  assertEquals(declaresPlacement(undefined), false);
  assertEquals(declaresPlacement({ queueTimeout: 10 }), false);
  assertEquals(declaresPlacement({ labels: {} }), true);
});

Deno.test("NestedPlacementModeSchema: accepts inherit and own only", () => {
  assertEquals(NestedPlacementModeSchema.safeParse("inherit").success, true);
  assertEquals(NestedPlacementModeSchema.safeParse("own").success, true);
  assertEquals(NestedPlacementModeSchema.safeParse("local").success, false);
});
