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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  dataQuery,
  type DataQueryDeps,
  type DataQueryEvent,
  requireSingleResult,
} from "./query.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import type { SpecNameFallback } from "../../domain/data/query_predicate.ts";

function makeRecord(overrides: Partial<DataRecord> = {}): DataRecord {
  return {
    id: crypto.randomUUID(),
    name: "my-data",
    version: 1,
    isLatest: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    namespace: "",
    attributes: {},
    tags: { type: "resource" },
    modelName: "my-model",
    modelId: crypto.randomUUID(),
    modelType: "aws/s3-bucket",
    specName: "bucket",
    dataType: "resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    ownerType: "model-method",
    streaming: false,
    size: 10,
    content: {},
    path: "",
    ownerRef: "",
    workflowRunId: "",
    workflowName: "",
    jobName: "",
    stepName: "",
    source: "",
    ...overrides,
  };
}

function completedOf(events: DataQueryEvent[]) {
  const last = events[events.length - 1];
  assertEquals(last.kind, "completed");
  return (last as Extract<DataQueryEvent, { kind: "completed" }>).data;
}

Deno.test("dataQuery: yields resolving, match per record, and completed for an unprojected query", async () => {
  const records = [makeRecord({ name: "a" }), makeRecord({ name: "b" })];
  const deps: DataQueryDeps = {
    query: () => Promise.resolve(records),
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, { predicate: "data.name != ''" }),
  );

  assertEquals(events.length, 4);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1], { kind: "match", record: records[0] });
  assertEquals(events[2], { kind: "match", record: records[1] });

  const data = completedOf(events);
  assertEquals(data.predicate, "data.name != ''");
  assertEquals(data.select, undefined);
  assertEquals(data.results, records);
  assertEquals(data.projected, undefined);
  assertEquals(data.total, 2);
  assertEquals(data.limited, false);
});

Deno.test("dataQuery: forwards predicate, limit, and select to the repository query", async () => {
  const calls: Array<{
    predicate: string;
    options?: { limit?: number; select?: string };
  }> = [];
  const deps: DataQueryDeps = {
    query: (predicate, options) => {
      calls.push({ predicate, options });
      return Promise.resolve([]);
    },
  };

  await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: "data.version > 1",
      select: "data.name",
      limit: 7,
    }),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].predicate, "data.version > 1");
  assertEquals(calls[0].options?.limit, 7);
  assertEquals(calls[0].options?.select, "data.name");
});

Deno.test("dataQuery: limited is true when result count reaches the limit", async () => {
  const deps: DataQueryDeps = {
    query: () => Promise.resolve([makeRecord(), makeRecord()]),
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: "true",
      limit: 2,
    }),
  );

  const data = completedOf(events);
  assertEquals(data.total, 2);
  assertEquals(data.limited, true);
});

Deno.test("dataQuery: limited is false when results are fewer than the limit", async () => {
  const deps: DataQueryDeps = {
    query: () => Promise.resolve([makeRecord()]),
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: "true",
      limit: 5,
    }),
  );

  const data = completedOf(events);
  assertEquals(data.total, 1);
  assertEquals(data.limited, false);
});

Deno.test("dataQuery: limited is false when no limit is supplied", async () => {
  const deps: DataQueryDeps = {
    query: (_predicate, options) => {
      assertEquals(options?.limit, undefined);
      return Promise.resolve([makeRecord(), makeRecord(), makeRecord()]);
    },
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, { predicate: "true" }),
  );

  const data = completedOf(events);
  assertEquals(data.total, 3);
  assertEquals(data.limited, false);
});

Deno.test("dataQuery: classifies scalar projection and yields projected_match per value", async () => {
  const deps: DataQueryDeps = {
    query: () => Promise.resolve(["a", "b", "c"]),
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: "true",
      select: "data.name",
    }),
  );

  assertEquals(events.length, 5);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1], { kind: "projected_match", value: "a" });
  assertEquals(events[2], { kind: "projected_match", value: "b" });
  assertEquals(events[3], { kind: "projected_match", value: "c" });

  const data = completedOf(events);
  assertEquals(data.select, "data.name");
  assertEquals(data.results, []);
  assertEquals(data.projected, { shape: "scalar", values: ["a", "b", "c"] });
  assertEquals(data.total, 3);
});

Deno.test("dataQuery: classifies map projection with columns from the first non-null value", async () => {
  const deps: DataQueryDeps = {
    query: () =>
      Promise.resolve([
        null,
        { name: "a", version: 1 },
        { name: "b", version: 2 },
      ]),
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: "true",
      select: "{name: data.name, version: data.version}",
    }),
  );

  const data = completedOf(events);
  assertEquals(data.projected, {
    shape: "map",
    columns: ["name", "version"],
    // Null projections (failed on a record) render as empty rows.
    rows: [{}, { name: "a", version: 1 }, { name: "b", version: 2 }],
  });
  assertEquals(data.total, 3);
});

Deno.test("dataQuery: classifies list projection from array values", async () => {
  const deps: DataQueryDeps = {
    query: () => Promise.resolve([["a", 1], ["b", 2]]),
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: "true",
      select: "[data.name, data.version]",
    }),
  );

  const data = completedOf(events);
  assertEquals(data.projected, {
    shape: "list",
    rows: [["a", 1], ["b", 2]],
  });
});

Deno.test("dataQuery: all-null projection falls back to scalar shape", async () => {
  const deps: DataQueryDeps = {
    query: () => Promise.resolve([null, null]),
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: "true",
      select: "data.missing",
    }),
  );

  const data = completedOf(events);
  assertEquals(data.projected, { shape: "scalar", values: [null, null] });
  assertEquals(data.total, 2);
});

Deno.test("dataQuery: empty projected results complete with scalar shape and no matches", async () => {
  const deps: DataQueryDeps = {
    query: () => Promise.resolve([]),
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: "false",
      select: "data.name",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });

  const data = completedOf(events);
  assertEquals(data.projected, { shape: "scalar", values: [] });
  assertEquals(data.total, 0);
  assertEquals(data.limited, false);
});

Deno.test("dataQuery: yields QUERY_FAILED error when the repository query throws", async () => {
  const deps: DataQueryDeps = {
    query: () => Promise.reject(new Error("predicate parse error")),
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, { predicate: "!!!" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1], {
    kind: "error",
    error: { code: "QUERY_FAILED", message: "predicate parse error" },
  });
});

Deno.test("dataQuery: stringifies non-Error throws in the error event", async () => {
  const deps: DataQueryDeps = {
    query: () => Promise.reject("catastrophe"),
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, { predicate: "true" }),
  );

  const last = events[events.length - 1];
  assertEquals(last, {
    kind: "error",
    error: { code: "QUERY_FAILED", message: "catastrophe" },
  });
});

Deno.test("dataQuery: single mode queries without a limit and completes on one match", async () => {
  const record = makeRecord({ name: "only" });
  const limits: Array<number | undefined> = [];
  const deps: DataQueryDeps = {
    query: (_predicate, options) => {
      limits.push(options?.limit);
      return Promise.resolve([record]);
    },
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: 'name == "only"',
      single: true,
    }),
  );

  assertEquals(limits, [undefined]);
  const data = completedOf(events);
  assertEquals(data.results, [record]);
  assertEquals(data.total, 1);
});

Deno.test("dataQuery: single mode yields QUERY_NO_MATCH when nothing matches", async () => {
  const deps: DataQueryDeps = { query: () => Promise.resolve([]) };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: 'name == "missing"',
      single: true,
    }),
  );

  assertEquals(events.length, 2);
  const last = events[1] as Extract<DataQueryEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "QUERY_NO_MATCH");
});

Deno.test("dataQuery: single mode yields QUERY_MULTIPLE_MATCHES without emitting matches", async () => {
  const deps: DataQueryDeps = {
    query: () => Promise.resolve([makeRecord(), makeRecord()]),
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: 'modelName == "my-model"',
      single: true,
    }),
  );

  assertEquals(events.map((e) => e.kind), ["resolving", "error"]);
  const last = events[1] as Extract<DataQueryEvent, { kind: "error" }>;
  assertEquals(last.error.code, "QUERY_MULTIPLE_MATCHES");
});

Deno.test("dataQuery: single mode completes with the one projected value", async () => {
  const deps: DataQueryDeps = {
    query: () => Promise.resolve([{ status: "ok" }]),
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: "true",
      select: "attributes",
      single: true,
    }),
  );

  const data = completedOf(events);
  assertEquals(data.projected, {
    shape: "map",
    columns: ["status"],
    rows: [{ status: "ok" }],
  });
});

Deno.test("dataQuery: single mode with a limit yields validation_failed without querying", async () => {
  let queried = false;
  const deps: DataQueryDeps = {
    query: () => {
      queried = true;
      return Promise.resolve([]);
    },
  };

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: "true",
      single: true,
      limit: 5,
    }),
  );

  assertEquals(queried, false);
  const last = events[events.length - 1] as Extract<
    DataQueryEvent,
    { kind: "error" }
  >;
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("requireSingleResult: accepts exactly one match", () => {
  assertEquals(requireSingleResult({ predicate: "true", total: 1 }), undefined);
});

Deno.test("requireSingleResult: names the predicate when nothing matched", () => {
  const error = requireSingleResult({ predicate: 'name == "x"', total: 0 });
  assertEquals(error?.code, "QUERY_NO_MATCH");
  assertStringIncludes(error?.message ?? "", '\n  name == "x"\n');
  assertStringIncludes(error?.message ?? "", "latest version");
});

Deno.test("requireSingleResult: rejects several matches", () => {
  const error = requireSingleResult({ predicate: 'name == "x"', total: 2 });
  assertEquals(error?.code, "QUERY_MULTIPLE_MATCHES");
  assertStringIncludes(error?.message ?? "", "More than one");
  assertStringIncludes(error?.message ?? "", '\n  name == "x"\n');
  assertStringIncludes(error?.message ?? "", "without --single");
});

Deno.test("requireSingleResult: treats a missing count as no match", () => {
  const error = requireSingleResult(
    { predicate: "true" } as unknown as { predicate: string; total: number },
  );
  assertEquals(error?.code, "QUERY_NO_MATCH");
});

/** Deps whose fallback is fixed and whose query answers per predicate. */
function fallbackDeps(
  answers: Record<string, unknown[] | Error>,
  calls: Array<{ predicate: string; options?: unknown }> = [],
): DataQueryDeps {
  return {
    query: (predicate, options) => {
      calls.push({ predicate, options });
      const answer = answers[predicate] ?? [];
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
    specNameFallback: (predicate) => FALLBACKS[predicate] ?? null,
  };
}

/** The domain fallback for each predicate these tests run. */
const FALLBACKS: Record<string, SpecNameFallback> = {
  'name == "classification"': {
    specNamePredicate: 'specName == "classification"',
    namePredicate: 'name == "classification"',
    droppedConjuncts: false,
  },
  'name == "result" && tags.env == "prod"': {
    specNamePredicate: 'specName == "result"',
    namePredicate: 'name == "result"',
    droppedConjuncts: true,
  },
};

Deno.test("dataQuery: empty result whose spec-name fallback matches carries a hint", async () => {
  const calls: Array<{ predicate: string; options?: unknown }> = [];
  const include = (_record: DataRecord) => Promise.resolve(true);
  const deps = fallbackDeps(
    { 'specName == "classification"': [makeRecord()] },
    calls,
  );

  const data = completedOf(
    await collect<DataQueryEvent>(
      dataQuery(createLibSwampContext(), deps, {
        predicate: 'name == "classification"',
        include,
      }),
    ),
  );

  assertEquals(data.total, 0);
  assertEquals(data.specNameHint, {
    suggestedPredicate: 'specName == "classification"',
    otherFiltersDropped: false,
  });
  // The probe reads at most one record, through the caller's include filter.
  assertEquals(calls[1], {
    predicate: 'specName == "classification"',
    options: { limit: 1, include },
  });
});

Deno.test("dataQuery: projected empty result also carries the hint", async () => {
  const deps = fallbackDeps({ 'specName == "classification"': ["x"] });

  const data = completedOf(
    await collect<DataQueryEvent>(
      dataQuery(createLibSwampContext(), deps, {
        predicate: 'name == "classification"',
        select: "name",
      }),
    ),
  );

  assertEquals(
    data.specNameHint?.suggestedPredicate,
    'specName == "classification"',
  );
});

Deno.test("dataQuery: no hint when the fallback matches nothing", async () => {
  const data = completedOf(
    await collect<DataQueryEvent>(
      dataQuery(createLibSwampContext(), fallbackDeps({}), {
        predicate: 'name == "classification"',
      }),
    ),
  );

  assertEquals("specNameHint" in data, false);
});

Deno.test("dataQuery: no probe when the query matched", async () => {
  const calls: Array<{ predicate: string; options?: unknown }> = [];
  const deps = fallbackDeps(
    { 'name == "classification"': [makeRecord()] },
    calls,
  );

  const data = completedOf(
    await collect<DataQueryEvent>(
      dataQuery(createLibSwampContext(), deps, {
        predicate: 'name == "classification"',
      }),
    ),
  );

  assertEquals(calls.length, 1);
  assertEquals(data.specNameHint, undefined);
});

Deno.test("dataQuery: a failed probe omits the hint without failing the query", async () => {
  const deps = fallbackDeps({
    'specName == "classification"': new Error("catalog unavailable"),
  });

  const events = await collect<DataQueryEvent>(
    dataQuery(createLibSwampContext(), deps, {
      predicate: 'name == "classification"',
    }),
  );

  const data = completedOf(events);
  assertEquals(data.total, 0);
  assertEquals(data.specNameHint, undefined);
});

Deno.test("dataQuery: no hint when a dropped condition, not the name, excluded the data", async () => {
  // Data named "result" (spec "result") exists, but not with tags.env prod.
  const deps = fallbackDeps({
    'name == "result"': [makeRecord({ name: "result" })],
    'specName == "result"': [makeRecord({ name: "result" })],
  });

  const data = completedOf(
    await collect<DataQueryEvent>(
      dataQuery(createLibSwampContext(), deps, {
        predicate: 'name == "result" && tags.env == "prod"',
      }),
    ),
  );

  assertEquals(data.specNameHint, undefined);
});

Deno.test("dataQuery: a hint after dropped conditions says they were not carried over", async () => {
  const calls: Array<{ predicate: string; options?: unknown }> = [];
  const deps = fallbackDeps(
    { 'specName == "result"': [makeRecord({ name: "result-main" })] },
    calls,
  );

  const data = completedOf(
    await collect<DataQueryEvent>(
      dataQuery(createLibSwampContext(), deps, {
        predicate: 'name == "result" && tags.env == "prod"',
      }),
    ),
  );

  assertEquals(data.specNameHint, {
    suggestedPredicate: 'specName == "result"',
    otherFiltersDropped: true,
  });
  assertEquals(calls.map((c) => c.predicate), [
    'name == "result" && tags.env == "prod"',
    'name == "result"',
    'specName == "result"',
  ]);
});

Deno.test("dataQuery: no probe with a zero limit", async () => {
  const calls: Array<{ predicate: string; options?: unknown }> = [];
  const deps = fallbackDeps(
    { 'specName == "classification"': [makeRecord()] },
    calls,
  );

  const data = completedOf(
    await collect<DataQueryEvent>(
      dataQuery(createLibSwampContext(), deps, {
        predicate: 'name == "classification"',
        limit: 0,
      }),
    ),
  );

  assertEquals(calls.length, 1);
  assertEquals(data.specNameHint, undefined);
});
