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
 * reference.
 */

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { SENSITIVE_FIELDS_TAG } from "../../domain/models/data_writer.ts";
import { SecretBagRegistry } from "../../domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import { SecretBoundary } from "./secret_boundary.ts";
import { runInFaultScope } from "./secret_fault_context.ts";
import { isSecret } from "./secret_value.ts";
import { adaptDataRecord } from "./sensitive_record_adapter.ts";

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
        const view = adaptDataRecord(record, "", "data.latest") as {
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

Deno.test("adaptDataRecord: a released view is plain data with a value-less data-origin sentinel for each tagged reference", () => {
  fc.assert(
    fc.property(taggedRecord, ({ record, tagged }) => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const released = runInFaultScope(() => {
        const view = adaptDataRecord(record, "", "data.latest");
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
