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

/**
 * Invariants of the accessor adapter (typed-secrets 3.3): over any record the
 * writer could store, the view keeps every non-secret value, turns every
 * tagged reference into a Secret, records every reference, mutates nothing,
 * and releases through the boundary as plain data with a sentinel for each
 * reference. The steps view (typed-secrets 4.2) merges such records as the
 * flat step outputs do.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import fc from "fast-check";
import {
  attachStepOutputSources,
  type StepOutputRecord,
} from "../../domain/expressions/step_output_sources.ts";
import { SENSITIVE_FIELDS_TAG } from "../../domain/models/data_writer.ts";
import { SecretBagRegistry } from "../../domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import { mergeStepOutputs } from "../../domain/workflows/step_output_resolver.ts";
import { SecretBoundary } from "./secret_boundary.ts";
import { runInFaultScope } from "./secret_fault_context.ts";
import { isSecret, secretParts } from "./secret_value.ts";
import { adaptDataRecord, stepsView } from "./sensitive_record_adapter.ts";
import {
  isForeignToReader,
  type NamespaceReader,
} from "../../domain/data/namespace.ts";

/** The solo reader, whose own records are those of the solo namespace. */
const SOLO_READER: NamespaceReader = {
  namespace: "",
  readsSoloNamespace: false,
};

/** A field name the strict reader accepts as one path segment. */
const key = fc.stringMatching(/^[a-z][a-z0-9_-]{0,6}$/);

/** A vault name or key the writer puts inside a reference's quotes. */
const quoted = fc.stringMatching(/^[A-Za-z0-9_./-]{1,12}$/);

/** A plain JSON leaf that is not a stored reference. */
const leaf = fc.oneof(
  fc.string().filter((text) => !text.includes("vault.get")),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

/** A plain JSON tree, as parsed attributes are. */
const tree = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: "small", maxDepth: 3 },
    leaf,
    fc.array(tie("node"), { maxLength: 3 }),
    fc.dictionary(key, tie("node"), { maxKeys: 4 }),
  ),
})).node;

/** Every path to a leaf of `value`, through objects only, as the writer walks. */
function leafPaths(value: unknown, prefix: string[] = []): string[][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return prefix.length === 0 ? [] : [prefix];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return prefix.length === 0 ? [] : [prefix];
  return entries.flatMap(([k, v]) => leafPaths(v, [...prefix, k]));
}

function setAt(root: Record<string, unknown>, path: string[], value: unknown) {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

function getAt(root: unknown, path: string[]): unknown {
  let current = root;
  for (const segment of path) {
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** A writer-shaped record: `tagged` leaf paths hold references. */
const taggedRecord = fc.dictionary(key, tree, { maxKeys: 4 }).chain(
  (attributes) => {
    const paths = leafPaths(attributes).filter((path) =>
      typeof getAt(attributes, path) !== "object" ||
      getAt(attributes, path) === null
    );
    return fc.tuple(
      fc.constant(attributes),
      fc.subarray(paths),
      fc.array(fc.tuple(quoted, quoted), {
        minLength: paths.length,
        maxLength: paths.length,
      }),
    );
  },
).map(([attributes, tagged, references]) => {
  const copy = structuredClone(attributes) as Record<string, unknown>;
  const expected = new Map<string, { vaultName: string; key: string }>();
  tagged.forEach((path, index) => {
    const [vaultName, key] = references[index];
    setAt(copy, path, `\${{ vault.get('${vaultName}', '${key}') }}`);
    expected.set(`${vaultName}\u0000${key}`, { vaultName, key });
  });
  return {
    record: {
      id: "r1",
      name: "n",
      version: 1,
      namespace: "",
      modelName: "m",
      attributes: copy,
      content: copy,
      tags: {
        [SENSITIVE_FIELDS_TAG]: JSON.stringify(
          tagged.map((path) => path.join(".")),
        ),
      },
    },
    tagged,
    expected,
  };
});

Deno.test("adaptDataRecord: the view keeps every untagged value, holds a Secret at every tagged reference, records each reference, and mutates nothing", () => {
  fc.assert(
    fc.property(taggedRecord, ({ record, tagged, expected }) => {
      const snapshot = structuredClone(record);
      runInFaultScope((scope) => {
        const view = adaptDataRecord(record, SOLO_READER, "data.latest") as {
          attributes: Record<string, unknown>;
          content: unknown;
        };
        const taggedKeys = new Set(tagged.map((path) => path.join("\u0000")));
        for (const path of leafPaths(record.attributes)) {
          const value = getAt(view.attributes, path);
          if (taggedKeys.has(path.join("\u0000"))) assert(isSecret(value));
          else assertEquals(value, getAt(record.attributes, path));
        }
        assertEquals(scope.sensitiveReferences, expected);
        if (tagged.length > 0) assert(view.content === view.attributes);
      });
      assertEquals(record, snapshot);
    }),
    { numRuns: 300 },
  );
});

/** A namespace a row or a reader can carry, the solo one among them. */
const namespaceOf = fc.constantFrom("", "eng", "security");

Deno.test("adaptDataRecord: a tagged record is adapted exactly when the data layer reads its namespace as the reader's own (swamp-club#3785)", () => {
  fc.assert(
    fc.property(
      taggedRecord.filter(({ tagged }) => tagged.length > 0),
      namespaceOf,
      namespaceOf,
      fc.boolean(),
      ({ record }, namespace, readerNamespace, readsSoloNamespace) => {
        const stamped = { ...record, namespace };
        const reader = { namespace: readerNamespace, readsSoloNamespace };
        runInFaultScope((scope) => {
          const view = adaptDataRecord(stamped, reader, "data.latest");
          const own = !isForeignToReader(namespace, reader);
          assertEquals(view !== stamped, own);
          assertEquals(scope.sensitiveReferences.size > 0, own);
        });
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("adaptDataRecord: a released view is plain data with a value-less data-origin sentinel for each tagged reference", () => {
  fc.assert(
    fc.property(taggedRecord, ({ record, tagged }) => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const released = runInFaultScope(() => {
        const view = adaptDataRecord(record, SOLO_READER, "data.latest");
        return new SecretBoundary(bag).release(view) as {
          attributes: Record<string, unknown>;
        };
      });
      // Plain: cloneable, no getter anywhere.
      structuredClone(released);
      const taggedKeys = new Set(tagged.map((path) => path.join("\u0000")));
      for (const path of leafPaths(record.attributes)) {
        const value = getAt(released.attributes, path);
        if (!taggedKeys.has(path.join("\u0000"))) {
          assertEquals(value, getAt(record.attributes, path));
          continue;
        }
        assert(typeof value === "string");
        const entry = bag.registry.issuedEntryOf(value);
        assert(entry !== undefined);
        assertEquals(entry.dataOrigin, true);
        assertEquals("value" in entry, false);
      }
      assertEquals(bag.rawValues, []);
    }),
    { numRuns: 200 },
  );
});

const KEYS = ["a", "b", "c", "d", "e"] as const;

interface Field {
  key: string;
  tagged: boolean;
  value: string;
}

const fieldsArb = fc.uniqueArray(
  fc.record({
    key: fc.constantFrom(...KEYS),
    tagged: fc.boolean(),
    value: fc.string(),
  }),
  { selector: (f) => f.key, minLength: 1, maxLength: KEYS.length },
);

const recordsArb = fc.array(fieldsArb, { minLength: 1, maxLength: 4 });

const referenceKey = (index: number, key: string) => `k-${index}-${key}`;

function recordOf(index: number, fields: readonly Field[]): StepOutputRecord {
  const attributes: Record<string, unknown> = {};
  const tagged: string[] = [];
  for (const field of fields) {
    if (field.tagged) {
      tagged.push(field.key);
      attributes[field.key] = `\${{ vault.get('v', '${
        referenceKey(index, field.key)
      }') }}`;
    } else {
      attributes[field.key] = field.value;
    }
  }
  return {
    id: `r${index}`,
    name: `n${index}`,
    version: index + 1,
    namespace: "",
    modelName: "writer",
    tags: tagged.length > 0
      ? { [SENSITIVE_FIELDS_TAG]: JSON.stringify(tagged) }
      : {},
    attributes,
  };
}

Deno.test("stepsView: for any records, the merged view has the keys of mergeStepOutputs, each plain winner's value, each tagged winner as a Secret of its own record, and every reference recorded", () => {
  fc.assert(
    fc.property(recordsArb, (fieldSets) => {
      const records = fieldSets.map((fields, index) => recordOf(index, fields));
      const expected = mergeStepOutputs(records.map((r) => r.attributes))!;
      const step = attachStepOutputSources(
        { status: "succeeded", outputs: expected },
        [{ path: [], records }],
      );
      runInFaultScope((scope) => {
        const view = stepsView({ s: step }, SOLO_READER) as Record<
          string,
          Record<string, Record<string, unknown>>
        >;
        const outputs = view.s.outputs;
        assertEquals(Object.keys(outputs).sort(), Object.keys(expected).sort());
        let references = 0;
        for (const fields of fieldSets) {
          references += fields.filter((f) => f.tagged).length;
        }
        assertEquals(scope.sensitiveReferences.size, references);
        for (const key of Object.keys(expected)) {
          // The winner is the last record holding the key.
          let winner = -1;
          for (let index = 0; index < fieldSets.length; index++) {
            if (fieldSets[index].some((f) => f.key === key)) winner = index;
          }
          const field = fieldSets[winner].find((f) => f.key === key)!;
          const value = outputs[key];
          if (field.tagged) {
            assert(isSecret(value), `${key} should be a Secret`);
            const part = secretParts(value)![0] as {
              reference: { vaultName: string; key: string };
              location: string;
            };
            assertEquals(part.reference.vaultName, "v");
            assertEquals(part.reference.key, referenceKey(winner, key));
            assertStringIncludes(part.location, `record r${winner} `);
          } else {
            assertEquals(value, expected[key]);
            assertEquals(value, field.value);
          }
        }
      });
    }),
  );
});
