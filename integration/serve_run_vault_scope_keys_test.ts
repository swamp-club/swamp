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
 * Key-conditioned vault grants on a serve run's sensitive outputs
 * (swamp-club#2676): the pre-run check decides with a field's own
 * `vaultKey`, leaves a key it cannot know yet to the put, and the put decides
 * every field with its key before storing any of them.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import "../src/domain/models/models.ts";
import {
  BOT,
  grant,
  methodError,
  runMethodAs,
  runnerGrants,
  vaultDenials,
  withVaultScopeFixture,
} from "./serve_run_vault_scope_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };

function withCondition(g: Grant, condition: string): Grant {
  return { ...g, condition };
}

/** A key generated for the fixture's minter starts with its type. */
const GENERATED_KEY_PREFIX = "test-vault-scope-";

Deno.test({
  name:
    "serve run vault scope keys: an outputs allow conditioned on the generated key lets the method run and store",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const frames = await runMethodAs(f, "minter", "mint", BOT);
      assertEquals(methodError(frames), undefined);
      assertEquals(f.sideEffects.count, 1);
      const stored = await (await f.vaults()).list("outputs");
      assertEquals(stored.length, 2);
      assertEquals(
        stored.every((key) => key.startsWith(GENERATED_KEY_PREFIX)),
        true,
        stored.join(", "),
      );
      assertEquals(vaultDenials(f.audits), []);
    }, {
      grants: [
        ...runnerGrants("user:bot"),
        withCondition(
          grant("user:bot", "vault", "outputs", ["write", "read"]),
          `key.startsWith("${GENERATED_KEY_PREFIX}")`,
        ),
      ],
    }),
});

Deno.test({
  name:
    "serve run vault scope keys: a deny on a field's fixed vaultKey refuses before the method runs",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const frames = await runMethodAs(f, "minter", "mint", BOT);
      const message = methodError(frames) ?? "";
      assertStringIncludes(
        message,
        "stores sensitive output in vault 'outputs'",
      );
      assertStringIncludes(message, "Writing vault 'outputs' is refused");
      assertEquals(f.sideEffects.count, 0);
      assertEquals(await (await f.vaults()).list("outputs"), []);
      assertEquals(
        vaultDenials(f.audits).map((d) => [d.resourceName, d.action]),
        [["outputs", "vault.write"]],
      );
    }, {
      mintTokenKey: "pinned-token",
      grants: [
        ...runnerGrants("user:bot"),
        grant("user:bot", "vault", "outputs", ["read", "write"]),
        withCondition(
          grant("user:bot", "vault", "outputs", ["write"], "deny"),
          'key == "pinned-token"',
        ),
      ],
    }),
});

Deno.test({
  name:
    "serve run vault scope keys: a deny on a generated key refuses at the put before any field is stored",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const frames = await runMethodAs(f, "minter", "mint", BOT);
      const message = methodError(frames) ?? "";
      assertStringIncludes(message, "Writing vault 'outputs' is refused");
      // The key was unknown before the run, so the method ran ...
      assertEquals(f.sideEffects.count, 1);
      // ... and neither field was stored: the token's key is allowed, but it
      // was not written ahead of the backup's refusal.
      assertEquals(await (await f.vaults()).list("outputs"), []);
      assertEquals(
        vaultDenials(f.audits).map((d) => [d.resourceName, d.action]),
        [["outputs", "vault.write"]],
      );
    }, {
      grants: [
        ...runnerGrants("user:bot"),
        grant("user:bot", "vault", "outputs", ["read", "write"]),
        withCondition(
          grant("user:bot", "vault", "outputs", ["write"], "deny"),
          'key.endsWith("-backup")',
        ),
      ],
    }),
});
