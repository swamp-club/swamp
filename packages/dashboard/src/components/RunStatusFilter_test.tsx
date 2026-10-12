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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { RunStatusFilter } from "./RunStatusFilter.tsx";

Deno.test("RunStatusFilter: marks the chosen status and shows counts", () => {
  const html = renderToStaticMarkup(
    <RunStatusFilter
      value="failed"
      onChange={() => {}}
      counts={{
        "": 12345,
        succeeded: 12000,
        failed: 300,
        running: 2,
        suspended: 1,
        cancelled: 42,
      }}
    />,
  );
  assertEquals(html.match(/aria-pressed="true"/g)?.length, 1);
  assertStringIncludes(html, 'class="active" aria-pressed="true"');
  assertStringIncludes(html, "12.3K");
  assertStringIncludes(html, 'title="300 failed"');
  assertStringIncludes(html, 'title="12,345 runs"');
});

Deno.test("RunStatusFilter: no counts before the summary arrives", () => {
  const html = renderToStaticMarkup(
    <RunStatusFilter value="" onChange={() => {}} counts={null} />,
  );
  assertEquals(html.includes("status-count"), false);
  assertEquals(html.match(/<button/g)?.length, 6);
});
