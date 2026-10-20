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
import { Definition } from "../definitions/definition.ts";
import { findVaultReferences } from "./vault_reference_finder.ts";
import { findVaultGetCalls } from "./vault_reference_extractor.ts";

const arbVaultName = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/);
const arbKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,20}$/);
const arbArgName = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,10}$/);

Deno.test("findVaultGetCalls: nested selectors retain every delimiter regardless of fallback text", () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.integer({ min: 0, max: 8 }),
      (fallback, depth) => {
        const argument = "(".repeat(depth) +
          `inputs.?key.orValue(${JSON.stringify(fallback)})` +
          ")".repeat(depth);
        const expression = `vault.get('default', ${argument})`;
        const calls = findVaultGetCalls(expression);
        assertEquals(calls.length, 1);
        assertEquals(calls[0][0], expression);
        assertEquals(calls[0][6], argument);
        assertEquals(findVaultGetCalls(expression.slice(0, -1)), []);
      },
    ),
  );
});

Deno.test("findVaultReferences: a static vault.get anywhere in a definition is found exactly when it names the vault", () => {
  fc.assert(
    fc.property(
      arbVaultName,
      arbVaultName,
      arbKey,
      arbArgName,
      fc.boolean(),
      fc.boolean(),
      (removed, named, key, argName, quoted, inMethod) => {
        const vaultArg = quoted ? `"${named}"` : named;
        const value = `prefix-\${{ vault.get(${vaultArg}, ${key}) }}`;
        const definition = Definition.create({
          name: "app",
          ...(inMethod
            ? { methods: { run: { arguments: { [argName]: value } } } }
            : { globalArguments: { [argName]: [value] } }),
        });
        const { references, possibleReferences } = findVaultReferences(
          removed,
          { definitions: [definition], workflows: [] },
        );
        assertEquals(references.length, named === removed ? 1 : 0);
        assertEquals(possibleReferences, []);
      },
    ),
  );
});
