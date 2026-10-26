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
  extractSeverity,
  MalformedOsvResponseError,
  parseCvssV3BaseScore,
  parseOsvResponse,
} from "./osv.ts";

Deno.test("parseCvssV3BaseScore: scores CVSS v3 vectors", () => {
  assertEquals(
    parseCvssV3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"),
    9.8,
  );
  assertEquals(
    parseCvssV3BaseScore("CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N"),
    1.8,
  );
  assertEquals(parseCvssV3BaseScore("not-a-vector"), null);
});

Deno.test("extractSeverity: the database's own grade when OSV defines it", () => {
  assertEquals(
    extractSeverity({ database_specific: { severity: "MODERATE" } }),
    "MEDIUM",
  );
  assertEquals(
    extractSeverity({ database_specific: { severity: "high" } }),
    "HIGH",
  );
});

Deno.test("extractSeverity: an unknown database grade falls through to CVSS, then UNKNOWN", () => {
  assertEquals(
    extractSeverity({ database_specific: { severity: "important" } }),
    "UNKNOWN",
  );
  assertEquals(
    extractSeverity({
      database_specific: { severity: "important" },
      severity: [{
        type: "CVSS_V3",
        score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      }],
    }),
    "CRITICAL",
  );
});

Deno.test("extractSeverity: a null severity entry is skipped", () => {
  assertEquals(extractSeverity({ severity: [null] }), "UNKNOWN");
  assertEquals(extractSeverity({ severity: [null, { score: 7.5 }] }), "HIGH");
});

Deno.test("parseOsvResponse: no vulns key is none; a vulns that is not a list is malformed", () => {
  assertEquals(parseOsvResponse({}), []);
  assertEquals(
    parseOsvResponse({ vulns: [{ id: "GHSA-1" }] }),
    [{ id: "GHSA-1", severity: "UNKNOWN" }],
  );
  assertThrows(
    () => parseOsvResponse({ vulns: {} }),
    MalformedOsvResponseError,
  );
  assertThrows(() => parseOsvResponse(null), MalformedOsvResponseError);
});
