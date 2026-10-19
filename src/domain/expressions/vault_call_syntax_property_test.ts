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
import { analyzeVaultCalls, prepareVaultSource } from "./vault_call_syntax.ts";
import { extractVaultReferences } from "./vault_reference_extractor.ts";

const name = fc.stringOf(fc.constantFrom(..."abcXYZ0123_-/@"), {
  minLength: 1,
  maxLength: 40,
});

Deno.test("vault call syntax: legacy bare references agree with analysis and authored ranges", () => {
  fc.assert(
    fc.property(name, name, fc.string(), (vault, key, prose) => {
      const call = `vault.get(${vault}, ${key})`;
      const prefix = `${JSON.stringify(prose)} + `;
      const source = prefix + call;
      const analysis = analyzeVaultCalls(source);
      assertEquals(analysis.calls.length, 1);
      const found = analysis.calls[0];
      assertEquals(found.args.map((arg) => arg.literal), [vault, key]);
      assertEquals([found.start, found.end], [prefix.length, source.length]);
      assertEquals(found.authored, call);
      assertEquals(extractVaultReferences("${{ " + source + " }}"), {
        staticRefs: [{ vaultName: vault, secretKey: key }],
        hasDynamicRefs: false,
      });
    }),
    { numRuns: 300 },
  );
});

Deno.test("vault call syntax: string and comment text is never rewritten or extracted", () => {
  fc.assert(
    fc.property(fc.string(), name, name, (text, vault, key) => {
      const source = JSON.stringify(text + `vault.get(${vault}, ${key})`) +
        " // vault.get(other, token)";
      const normalized = prepareVaultSource(source);
      assertEquals(normalized.text, source);
      assertEquals(analyzeVaultCalls(source).calls, []);
      assertEquals(normalized.originalOffset(source.length), source.length);
    }),
    { numRuns: 300 },
  );
});
