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
import { reportKindAdapter } from "./report_kind_adapter.ts";

Deno.test("reportKindAdapter.extractTypeFromSource: reads name from export const report", () => {
  const result = reportKindAdapter.extractTypeFromSource(
    'export const report = {\n  name: "@Test/Report",\n};',
  );
  assertEquals(result?.typeNormalized, "@test/report");
  assertEquals(result?.kind, "report");
});

Deno.test("reportKindAdapter.extractTypeFromSource: ignores a declaration inside a template fixture (swamp-club#2876)", () => {
  assertEquals(
    reportKindAdapter.extractTypeFromSource(
      'const src = `export const report = { name: "@acme/thing" }`;',
    ),
    null,
  );
});
