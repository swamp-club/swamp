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

import { assert } from "@std/assert";
import fc from "fast-check";
import {
  isForeignExpression,
  isSwampExpression,
  KNOWN_FOREIGN_ROOTS,
  misspeltSwampNamespace,
  type SwampScope,
  unlistedForeignRoots,
  WIDEST_SWAMP_SCOPE,
} from "./swamp_namespaces.ts";

const SWAMP_ROOTS = [
  "model",
  "self",
  "inputs",
  "workflow",
  "vault",
  "env",
  "data",
  "workers",
  "file",
  "run",
  "steps",
  "webhook",
];
const FOREIGN_ROOTS = ["github", "secrets", "matrix", "host", "value"];
const KNOWN_ROOTS = [...KNOWN_FOREIGN_ROOTS];
const MEMBERS = ["sha", "version", "region", "name", "outputs"];

/** A member-access chain rooted at a swamp or foreign identifier. */
const arbReference = fc
  .tuple(
    fc.constantFrom(...SWAMP_ROOTS, ...FOREIGN_ROOTS),
    fc.array(fc.constantFrom(...MEMBERS), { minLength: 1, maxLength: 3 }),
  )
  .map(([root, members]) => [root, ...members].join("."));

/** `inputs` read whole or with a computed key, which names no single input. */
const arbOpaqueInputs = fc.constantFrom(
  "inputs",
  "size(inputs)",
  "inputs[env.STAGE]",
  "inputs['a' + self.name]",
);

/** One to three references joined with operators, plus literals. */
const arbExpression = fc
  .array(
    fc.oneof(
      arbReference,
      arbOpaqueInputs,
      fc.constantFrom("'x'", "1", "true"),
    ),
    {
      minLength: 1,
      maxLength: 3,
    },
  )
  .chain((terms) =>
    fc.constantFrom(" + ", " == ", " && ").map((op) => terms.join(op))
  );

/** Any scope an evaluation could present. */
const arbScope: fc.Arbitrary<SwampScope> = fc
  .tuple(
    fc.subarray(SWAMP_ROOTS),
    fc.subarray(MEMBERS),
  )
  .map(([bound, inputs]) => ({
    isBound: (root: string) => bound.includes(root),
    declaredInputs: new Set(inputs),
  }));

Deno.test("isSwampExpression: whatever a scope claims, the widest scope claims", () => {
  fc.assert(
    fc.property(arbExpression, arbScope, (cel, scope) => {
      if (isSwampExpression(cel, scope)) {
        assert(isSwampExpression(cel, WIDEST_SWAMP_SCOPE), cel);
      }
    }),
  );
});

Deno.test("isForeignExpression: never true for what an evaluation claims", () => {
  fc.assert(
    fc.property(arbExpression, arbScope, (cel, scope) => {
      if (isSwampExpression(cel, scope)) assert(!isForeignExpression(cel), cel);
    }),
  );
});

Deno.test("isForeignExpression: never true for inputs read whole or with a computed key", () => {
  fc.assert(
    fc.property(arbOpaqueInputs, (cel) => {
      assert(!isForeignExpression(cel), cel);
    }),
  );
});

Deno.test("isForeignExpression: never true for text cut short inside a string", () => {
  fc.assert(
    fc.property(
      arbExpression,
      fc.string({ maxLength: 8 }).filter((h) => !/["\\]/.test(h)),
      (cel, head) => {
        // An expression whose string literal never closes keeps its first-}}
        // boundary, so it arrives as an unterminated string.
        assert(!isForeignExpression(`${cel} + "${head}`));
      },
    ),
  );
});

/** A dot-less bare token: a literal vault or secret name. */
const arbBareName = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_-]{0,11}$/);

Deno.test("isSwampExpression: a bare-token vault.get classifies as its quoted form does", () => {
  fc.assert(
    fc.property(
      arbBareName,
      arbBareName,
      fc.option(arbExpression, { nil: undefined }),
      arbScope,
      (vaultName, secretKey, rest, scope) => {
        const suffix = rest === undefined ? "" : ` + ${rest}`;
        const bare = `vault.get(${vaultName}, ${secretKey})${suffix}`;
        const quoted = `vault.get('${vaultName}', '${secretKey}')${suffix}`;
        assert(
          isSwampExpression(bare, scope) === isSwampExpression(quoted, scope),
          bare,
        );
        assert(
          isForeignExpression(bare) === isForeignExpression(quoted),
          bare,
        );
      },
    ),
  );
});

Deno.test("misspeltSwampNamespace: only ever names a root isForeignExpression calls foreign", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...SWAMP_ROOTS),
      fc.nat(),
      fc.constantFrom("drop", "double", "swap"),
      (root, at, edit) => {
        const i = at % root.length;
        const typo = edit === "drop"
          ? root.slice(0, i) + root.slice(i + 1)
          : edit === "double"
          ? root.slice(0, i) + root[i] + root.slice(i)
          : root.slice(0, i) + (root[i + 1] ?? "") + root[i] +
            root.slice(i + 2);
        const found = misspeltSwampNamespace(`${typo}.x`);
        if (found === undefined) return;
        assert(found.root === typo);
        assert(SWAMP_ROOTS.includes(found.namespace));
        assert(!SWAMP_ROOTS.includes(typo));
        assert(isForeignExpression(`${typo}.x`));
      },
    ),
  );
});

Deno.test("misspeltSwampNamespace: catches a dropped or doubled letter in every namespace", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...SWAMP_ROOTS),
      fc.nat(),
      fc.boolean(),
      (root, at, drop) => {
        const i = at % root.length;
        const typo = drop
          ? root.slice(0, i) + root.slice(i + 1)
          : root.slice(0, i) + root[i] + root.slice(i);
        // A typo that spells another namespace (none today) is swamp's own.
        fc.pre(!SWAMP_ROOTS.includes(typo) && typo.length > 0);
        assert(misspeltSwampNamespace(`${typo}.x`) !== undefined, typo);
      },
    ),
  );
});

Deno.test("unlistedForeignRoots: empty exactly when every root is swamp's or a known foreign one", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(
        fc.constantFrom(
          ...SWAMP_ROOTS.filter((root) => root !== "vault"),
          ...KNOWN_ROOTS,
          "host",
          "value",
          "nonexistent",
        ),
        { minLength: 1, maxLength: 4 },
      ),
      (roots) => {
        const cel = roots.map((root) => `${root}.x`).join(" + ");
        const expected = roots.filter((root) =>
          !SWAMP_ROOTS.includes(root) && !KNOWN_FOREIGN_ROOTS.has(root)
        );
        assert(
          unlistedForeignRoots(cel).join() === expected.join(),
          cel,
        );
      },
    ),
  );
});

Deno.test("known foreign roots: none is a swamp namespace or nearly spells one", () => {
  for (const root of KNOWN_ROOTS) {
    assert(!SWAMP_ROOTS.includes(root), root);
    assert(isForeignExpression(`${root}.x`), root);
    assert(misspeltSwampNamespace(`${root}.x + input.y`)?.root === "input");
    assert(misspeltSwampNamespace(`${root}.x`) === undefined, root);
  }
});
