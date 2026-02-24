// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
  containsEnvExpression,
  containsRuntimeExpression,
  containsVaultExpression,
} from "./expression_evaluation_service.ts";

// ============================================================================
// containsVaultExpression
// ============================================================================

Deno.test("containsVaultExpression returns true for vault-only expressions", () => {
  assertEquals(containsVaultExpression("vault.get(aws, myKey)"), true);
  assertEquals(
    containsVaultExpression("vault.get('aws', 'myKey')"),
    true,
  );
  assertEquals(
    containsVaultExpression('vault.get("aws", "myKey")'),
    true,
  );
});

Deno.test("containsVaultExpression returns true for mixed CEL+vault expressions", () => {
  assertEquals(
    containsVaultExpression(
      "model.foo.data.attributes.x + vault.get(aws, key)",
    ),
    true,
  );
});

Deno.test("containsVaultExpression returns false for CEL-only expressions", () => {
  assertEquals(
    containsVaultExpression("model.foo.data.attributes.message"),
    false,
  );
  assertEquals(containsVaultExpression("self.name"), false);
  assertEquals(containsVaultExpression("inputs.param"), false);
  assertEquals(containsVaultExpression("env.HOME"), false);
});

Deno.test("containsVaultExpression returns false for vault-like but not vault.get", () => {
  assertEquals(containsVaultExpression("vault.name"), false);
  assertEquals(containsVaultExpression("vault_get(foo)"), false);
});

// ============================================================================
// containsEnvExpression
// ============================================================================

Deno.test("containsEnvExpression returns true for env references", () => {
  assertEquals(containsEnvExpression("env.FOO"), true);
  assertEquals(containsEnvExpression("env.HOME"), true);
  assertEquals(containsEnvExpression("env.AWS_REGION"), true);
});

Deno.test("containsEnvExpression returns true for mixed expressions with env", () => {
  assertEquals(
    containsEnvExpression("model.foo.input.name + env.SUFFIX"),
    true,
  );
});

Deno.test("containsEnvExpression returns false for non-env expressions", () => {
  assertEquals(containsEnvExpression("vault.get(aws, key)"), false);
  assertEquals(containsEnvExpression("model.x.input.name"), false);
  assertEquals(containsEnvExpression("self.name"), false);
  assertEquals(containsEnvExpression("inputs.param"), false);
});

Deno.test("containsEnvExpression returns false for env-like but not env.*", () => {
  // "environment" should not match because \b word boundary prevents it
  assertEquals(containsEnvExpression("environment.X"), false);
  assertEquals(containsEnvExpression("myenv.FOO"), false);
});

// ============================================================================
// containsRuntimeExpression
// ============================================================================

Deno.test("containsRuntimeExpression returns true for vault expressions", () => {
  assertEquals(
    containsRuntimeExpression("vault.get(aws, myKey)"),
    true,
  );
});

Deno.test("containsRuntimeExpression returns true for env expressions", () => {
  assertEquals(containsRuntimeExpression("env.HOME"), true);
});

Deno.test("containsRuntimeExpression returns true for mixed vault+env", () => {
  assertEquals(
    containsRuntimeExpression(
      'vault.get(main, key) + "-" + env.SUFFIX',
    ),
    true,
  );
});

Deno.test("containsRuntimeExpression returns false for model/self/inputs", () => {
  assertEquals(
    containsRuntimeExpression("model.foo.input.name"),
    false,
  );
  assertEquals(containsRuntimeExpression("self.name"), false);
  assertEquals(containsRuntimeExpression("inputs.param"), false);
});
