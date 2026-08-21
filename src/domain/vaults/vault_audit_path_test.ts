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
import {
  VAULT_AUDIT_FILENAME_PATTERN,
  VAULT_AUDIT_LEGACY_FILENAME_PATTERN,
  vaultAuditFilename,
  vaultAuditFilenameForTimestamp,
  vaultAuditFilePathForTimestamp,
  vaultAuditLegacyFilename,
  vaultAuditLegacyFilePathForTimestamp,
} from "./vault_audit_path.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";

Deno.test("vaultAuditFilename: formats date as vault audit filename", () => {
  assertEquals(
    vaultAuditFilename("2026-07-10"),
    "vault-audit-2026-07-10.jsonl",
  );
});

Deno.test("vaultAuditFilenameForTimestamp: extracts date from ISO timestamp", () => {
  assertEquals(
    vaultAuditFilenameForTimestamp("2026-07-10T15:30:00.000Z"),
    "vault-audit-2026-07-10.jsonl",
  );
});

Deno.test("vaultAuditFilePathForTimestamp: returns full path", () => {
  const path = vaultAuditFilePathForTimestamp(
    "/repo/.swamp/audit",
    "2026-07-10T15:30:00.000Z",
  );
  assertPathEquals(
    path,
    "/repo/.swamp/audit/vault-audit-2026-07-10.jsonl",
  );
});

Deno.test("VAULT_AUDIT_FILENAME_PATTERN: matches new filenames", () => {
  const match = "vault-audit-2026-07-10.jsonl".match(
    VAULT_AUDIT_FILENAME_PATTERN,
  );
  assertEquals(match !== null, true);
  assertEquals(match![1], "2026-07-10");
});

Deno.test("VAULT_AUDIT_FILENAME_PATTERN: does not match legacy filenames", () => {
  const match = "vault-reads-2026-07-10.jsonl".match(
    VAULT_AUDIT_FILENAME_PATTERN,
  );
  assertEquals(match, null);
});

Deno.test("VAULT_AUDIT_FILENAME_PATTERN: does not match command audit files", () => {
  const match = "commands-2026-07-10.jsonl".match(
    VAULT_AUDIT_FILENAME_PATTERN,
  );
  assertEquals(match, null);
});

Deno.test("vaultAuditLegacyFilename: formats legacy filename", () => {
  assertEquals(
    vaultAuditLegacyFilename("2026-07-10"),
    "vault-reads-2026-07-10.jsonl",
  );
});

Deno.test("VAULT_AUDIT_LEGACY_FILENAME_PATTERN: matches legacy filenames", () => {
  const match = "vault-reads-2026-07-10.jsonl".match(
    VAULT_AUDIT_LEGACY_FILENAME_PATTERN,
  );
  assertEquals(match !== null, true);
  assertEquals(match![1], "2026-07-10");
});

Deno.test("vaultAuditLegacyFilePathForTimestamp: returns full path", () => {
  const path = vaultAuditLegacyFilePathForTimestamp(
    "/repo/.swamp/audit",
    "2026-07-10T15:30:00.000Z",
  );
  assertPathEquals(
    path,
    "/repo/.swamp/audit/vault-reads-2026-07-10.jsonl",
  );
});
