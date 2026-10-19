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

import { assertEquals, assertThrows } from "@std/assert";
import {
  analyzeVaultCalls,
  prepareVaultSource,
  rewriteVaultArguments,
} from "./vault_call_syntax.ts";

Deno.test("analyzeVaultCalls: preserves legacy literal names and dynamic members", () => {
  for (
    const [source, expected] of [
      ["vault.get(my-vault, KEY)", ["my-vault", "KEY"]],
      ["vault.get(my/vault, a@b)", ["my/vault", "a@b"]],
      ["vault.get(my//vault, 123)", ["my//vault", "123"]],
      ["vault.get(prod, 'db.password')", ["prod", "db.password"]],
      ["vault.get(`my vault`, `KEY`)", ["my vault", "KEY"]],
      [String.raw`vault.get('v', 'a\nb')`, ["v", String.raw`a\nb`]],
      ["vault.get(inputs.v, self.key)", [undefined, undefined]],
    ] as const
  ) {
    const result = analyzeVaultCalls(source);
    assertEquals(result.calls.length, 1, source);
    assertEquals(
      result.calls[0].args.map((arg) => arg.literal),
      [...expected],
      source,
    );
    assertEquals(result.calls[0].authored, source);
  }
});

Deno.test("analyzeVaultCalls: ignores strings, comments and member-qualified lookalikes", () => {
  const source =
    `['vault.get(v, k)', literal('vault.get(x, y)'), self.vault.get('a', 'b'), vault.get(v, k)] // vault.get(x, y)`;
  assertEquals(analyzeVaultCalls(source).calls.map((call) => call.authored), [
    "vault.get(v, k)",
  ]);
  assertEquals(
    rewriteVaultArguments(`'vault.get(v, k)'`).text,
    `'vault.get(v, k)'`,
  );
  for (
    const source of [
      `r'vault.get(v, k)'`,
      `'''vault.get(v, k)\ntext'''`,
      `self. // member\n vault.get('a', 'b')`,
    ]
  ) {
    assertEquals(analyzeVaultCalls(source).calls, []);
    assertEquals(rewriteVaultArguments(source).text, source);
  }
  assertEquals(
    analyzeVaultCalls("// preceding comment.\nvault.get(prod, KEY)").calls[0]
      .args.map((arg) => arg.literal),
    ["prod", "KEY"],
  );
});

Deno.test("analyzeVaultCalls: nested calls are extracted children first with authored offsets", () => {
  const source = `model.my-app.resource.x + vault.get(v, vault.get(prod, KEY))`;
  const result = analyzeVaultCalls(source);
  assertEquals(result.calls.map((call) => call.authored), [
    "vault.get(prod, KEY)",
    "vault.get(v, vault.get(prod, KEY))",
  ]);
  for (const call of result.calls) {
    assertEquals(source.slice(call.start, call.end), call.authored);
  }
  assertEquals(result.calls[1].args[1].text, 'vault.get("prod", "KEY")');
});

Deno.test("analyzeVaultCalls: aliases are visible and bound names are not root calls", () => {
  for (
    const source of [
      "cel.bind(v, vault, v.get('a','b'))",
      "dyn(vault).get('a','b')",
      "[vault].map(m, m.get('a','b'))",
      "vault.other('a')",
    ]
  ) {
    assertEquals(analyzeVaultCalls(source).invalidUses.length, 1, source);
  }
  assertEquals(
    analyzeVaultCalls("[1].map(vault, vault.get('a','b'))").calls,
    [],
  );
});

Deno.test("prepareVaultSource: offsets survive model and vault rewrites", () => {
  const source = "model.my-app.resource.x + vault.get( v , KEY ) + inputs.x";
  const result = prepareVaultSource(source);
  assertEquals(
    result.text,
    'model["my-app"].resource.x + vault.get( "v" , "KEY" ) + inputs.x',
  );
  assertEquals(
    result.originalOffset(result.text.indexOf("vault")),
    source.indexOf("vault"),
  );
  assertEquals(
    result.originalOffset(result.text.indexOf("inputs")),
    source.indexOf("inputs"),
  );
  assertEquals(result.originalOffset(result.text.length), source.length);
  assertThrows(() => analyzeVaultCalls("vault.get(v, KEY"));
});
