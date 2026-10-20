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
import {
  extractVaultReferences,
  type VaultReference,
  withVaultReferences,
} from "./vault_reference_extractor.ts";

const name = fc.stringOf(fc.constantFrom(..."abcXYZ0123_-/@"), {
  minLength: 1,
  maxLength: 12,
});
const reference = fc.record({ vaultName: name, key: name });
const references = fc.array(reference, { maxLength: 8 });

const id = (ref: VaultReference) => `${ref.vaultName}\u0000${ref.secretKey}`;

Deno.test("withVaultReferences: lists the extracted references first, then each new reference once in first-seen order, keeps the dynamic flag, and is idempotent (swamp-club#3529)", () => {
  fc.assert(
    fc.property(references, references, fc.boolean(), (shown, bag, dynamic) => {
      const args = shown.map(({ vaultName, key }) =>
        `\${{ vault.get('${vaultName}', '${key}') }}`
      );
      if (dynamic) args.push("${{ vault.get(inputs.v, inputs.k) }}");
      const extracted = extractVaultReferences(args);
      const result = withVaultReferences(extracted, bag);

      const expected: VaultReference[] = [];
      const seen = new Set<string>();
      for (
        const ref of [
          ...extracted.staticRefs,
          ...bag.map(({ vaultName, key }) => ({ vaultName, secretKey: key })),
        ]
      ) {
        if (seen.has(id(ref))) continue;
        seen.add(id(ref));
        expected.push(ref);
      }
      assertEquals(result, {
        staticRefs: expected,
        hasDynamicRefs: dynamic,
      });
      assertEquals(
        new Set(result.staticRefs.map(id)).size,
        result.staticRefs.length,
      );
      assertEquals(withVaultReferences(result, bag), result);
    }),
    { numRuns: 300 },
  );
});
