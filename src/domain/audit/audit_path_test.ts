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
  assertPathEquals,
  assertPathMatches,
} from "../../infrastructure/persistence/path_test_helpers.ts";
import {
  AUDIT_FILENAME_PATTERN,
  auditFilename,
  auditFilenameForTimestamp,
  auditFilePathForTimestamp,
  datePartOfIsoTimestamp,
  todaysAuditFilePath,
} from "./audit_path.ts";

Deno.test("auditFilename: formats a YYYY-MM-DD date into the JSONL filename", () => {
  assertEquals(auditFilename("2026-04-24"), "commands-2026-04-24.jsonl");
});

Deno.test("datePartOfIsoTimestamp: extracts the date portion of an ISO timestamp", () => {
  assertEquals(
    datePartOfIsoTimestamp("2026-04-24T18:23:11.042Z"),
    "2026-04-24",
  );
});

Deno.test("datePartOfIsoTimestamp: handles a timestamp with no fractional seconds", () => {
  assertEquals(datePartOfIsoTimestamp("2026-04-24T18:23:11Z"), "2026-04-24");
});

Deno.test("auditFilenameForTimestamp: composes filename from ISO timestamp", () => {
  assertEquals(
    auditFilenameForTimestamp("2026-02-29T00:00:00Z"),
    "commands-2026-02-29.jsonl",
  );
});

Deno.test("auditFilePathForTimestamp: joins audit directory with the filename", () => {
  assertPathEquals(
    auditFilePathForTimestamp("/repo/.swamp/audit", "2026-04-24T10:00:00Z"),
    "/repo/.swamp/audit/commands-2026-04-24.jsonl",
  );
});

Deno.test("todaysAuditFilePath: returns a path matching today's audit filename pattern", () => {
  assertPathMatches(
    todaysAuditFilePath("/repo/.swamp/audit"),
    /\/repo\/\.swamp\/audit\/commands-\d{4}-\d{2}-\d{2}\.jsonl$/,
  );
});

Deno.test("AUDIT_FILENAME_PATTERN: captures the date from a matching filename", () => {
  const match = "commands-2026-04-24.jsonl".match(AUDIT_FILENAME_PATTERN);
  assertEquals(match?.[1], "2026-04-24");
});

Deno.test("AUDIT_FILENAME_PATTERN: rejects non-matching names", () => {
  assertEquals("commands-2026-4-24.jsonl".match(AUDIT_FILENAME_PATTERN), null);
  assertEquals("not-an-audit-file.jsonl".match(AUDIT_FILENAME_PATTERN), null);
  assertEquals(
    "commands-2026-04-24.jsonl.bak".match(AUDIT_FILENAME_PATTERN),
    null,
  );
});
