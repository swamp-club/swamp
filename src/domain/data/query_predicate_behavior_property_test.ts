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
import fc from "fast-check";
import { join } from "@std/path";
import {
  type CatalogRow,
  CatalogStore,
} from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import {
  DataQueryService,
  type ModelReferenceResolver,
  type ResolvedModelReference,
} from "./data_query_service.ts";

// behaviorName and behavior("x") are exact synonyms of modelName and
// model("x") (swamp-club#3410): respelling any occurrence of one as the other
// must give the same records and the same SQL pushdown.

const INGEST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const DEFINITIONS: Record<string, ResolvedModelReference> = {
  ingest: { modelType: "test-model", modelId: INGEST_ID },
  other: { modelType: "test-model", modelId: OTHER_ID },
  [OTHER_ID]: { modelType: "test-model", modelId: OTHER_ID },
};

function row(
  i: number,
  overrides: Partial<CatalogRow>,
): CatalogRow {
  return {
    namespace: "",
    type_normalized: "test-model",
    model_id: INGEST_ID,
    data_name: `d${i}`,
    id: `00000000-0000-1000-8000-${String(i).padStart(12, "0")}`,
    version: 1,
    is_latest: 1,
    is_step_latest: 1,
    model_name: "ingest",
    spec_name: "result",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    garbage_collection: "10",
    owner_type: "model-method",
    streaming: 0,
    size: 256,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
    ...overrides,
  };
}

/** A predicate tree whose model-name terms can be spelled either way. */
type Term =
  | { kind: "name"; op: "==" | "!="; value: string }
  | { kind: "prefix"; value: string }
  | { kind: "in"; values: string[] }
  | { kind: "call"; reference: string }
  | { kind: "dataName"; value: string }
  | { kind: "not"; term: Term }
  | { kind: "and" | "or"; left: Term; right: Term };

const arbName = fc.constantFrom("ingest", "other", "renamed", "");
const arbReference = fc.constantFrom("ingest", "other", OTHER_ID);

const { term: arbTerm } = fc.letrec<{ term: Term }>((tie) => ({
  term: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.record({
      kind: fc.constant("name" as const),
      op: fc.constantFrom("==" as const, "!=" as const),
      value: arbName,
    }),
    fc.record({
      kind: fc.constant("prefix" as const),
      value: fc.constantFrom("in", "o", "r"),
    }),
    fc.record({
      kind: fc.constant("in" as const),
      values: fc.array(arbName, { minLength: 1, maxLength: 2 }),
    }),
    fc.record({ kind: fc.constant("call" as const), reference: arbReference }),
    fc.record({
      kind: fc.constant("dataName" as const),
      value: fc.constantFrom("d0", "d1", "d4"),
    }),
    fc.record({ kind: fc.constant("not" as const), term: tie("term") }),
    fc.record({
      kind: fc.constantFrom("and" as const, "or" as const),
      left: tie("term"),
      right: tie("term"),
    }),
  ),
}));

/**
 * Renders `term` as CEL. `respell` picks, per model-name occurrence in
 * render order, whether to write the behavior spelling.
 */
function render(term: Term, respell: () => boolean): string {
  const field = () => respell() ? "behaviorName" : "modelName";
  switch (term.kind) {
    case "name":
      return `${field()} ${term.op} ${JSON.stringify(term.value)}`;
    case "prefix":
      return `${field()}.startsWith(${JSON.stringify(term.value)})`;
    case "in":
      return `${field()} in ${JSON.stringify(term.values)}`;
    case "call":
      return `${respell() ? "behavior" : "model"}(${
        JSON.stringify(term.reference)
      })`;
    case "dataName":
      return `name == ${JSON.stringify(term.value)}`;
    case "not":
      return `!(${render(term.term, respell)})`;
    case "and":
      return `(${render(term.left, respell)}) && (${
        render(term.right, respell)
      })`;
    case "or":
      return `(${render(term.left, respell)}) || (${
        render(term.right, respell)
      })`;
  }
}

function setup() {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-query-behavior-" });
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  catalog.markPopulated();
  catalog.upsert(row(0, {}));
  catalog.upsert(row(1, { model_id: OTHER_ID, model_name: "other" }));
  catalog.upsert(row(2, { model_id: OTHER_ID, model_name: "renamed" }));
  catalog.upsert(row(3, { model_name: "" }));
  catalog.upsert(row(4, { type_normalized: "other-type", model_id: OTHER_ID }));
  const service = new DataQueryService(
    catalog,
    new FileSystemUnifiedDataRepository(dir, undefined, catalog),
  );
  const filters: string[] = [];
  const original = catalog.iterateFiltered.bind(catalog);
  catalog.iterateFiltered = (where, params) => {
    filters.push(`${where} ${JSON.stringify(params)}`);
    return original(where, params);
  };
  const modelResolver: ModelReferenceResolver = (reference) =>
    Promise.resolve(DEFINITIONS[reference]);
  return { dir, catalog, service, filters, modelResolver };
}

Deno.test("data query: respelling modelName and model() as behaviorName and behavior() gives the same records and SQL", async () => {
  const { dir, catalog, service, filters, modelResolver } = setup();
  try {
    await fc.assert(
      fc.asyncProperty(
        arbTerm,
        fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }),
        async (term, choices) => {
          let i = 0;
          const modelForm = render(term, () => false);
          const respelled = render(term, () => choices[i++ % choices.length]);

          filters.length = 0;
          const expected = await service.query(modelForm, { modelResolver });
          const expectedFilters = [...filters];
          filters.length = 0;
          const actual = await service.query(respelled, { modelResolver });

          assertEquals(actual, expected, respelled);
          assertEquals([...filters], expectedFilters, respelled);
        },
      ),
      { numRuns: 200 },
    );
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("data query: a fully respelled predicate names every row the model form names, in the same order", async () => {
  const { dir, catalog, service, modelResolver } = setup();
  try {
    await fc.assert(
      fc.asyncProperty(arbTerm, async (term) => {
        const modelForm = render(term, () => false);
        const behaviorForm = render(term, () => true);
        const ids = async (predicate: string) =>
          ((await service.query(predicate, { modelResolver })) as {
            id: string;
          }[]).map((r) => r.id);
        assertEquals(
          await ids(behaviorForm),
          await ids(modelForm),
          behaviorForm,
        );
      }),
      { numRuns: 100 },
    );
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
