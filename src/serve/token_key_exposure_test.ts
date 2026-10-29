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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyTokenKeyRecord,
  TOKEN_SECRETS_KEY_BYTES,
} from "../domain/vaults/token_secrets_key.ts";
import { coLocatedTokenKeyWarning } from "./token_key_exposure.ts";

Deno.test("coLocatedTokenKeyWarning: warns when the key sits beside the secrets (swamp-club#4096)", () => {
  const warning = coLocatedTokenKeyWarning(
    new Uint8Array(TOKEN_SECRETS_KEY_BYTES).fill(7),
  );
  assertStringIncludes(warning!, "can decrypt every token secret");
  assertStringIncludes(warning!, "token-secrets block to serve.yaml");
});

Deno.test("coLocatedTokenKeyWarning: says nothing once the key is held in a vault", () => {
  const marker = new TextEncoder().encode(JSON.stringify({
    format: "swamp-token-key-marker",
    version: 1,
    vault: "prod-secrets",
    key: "swamp-token-secrets-key",
    fingerprint: "a".repeat(64),
    migratedAt: "2026-10-29T00:00:00.000Z",
  }));
  assertEquals(classifyTokenKeyRecord(marker).kind, "marker");
  assertEquals(coLocatedTokenKeyWarning(marker), undefined);
});

Deno.test("coLocatedTokenKeyWarning: says nothing before any key exists", () => {
  assertEquals(coLocatedTokenKeyWarning(null), undefined);
});
