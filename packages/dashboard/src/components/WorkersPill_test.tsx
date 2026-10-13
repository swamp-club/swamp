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
import { assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkersPill } from "./WorkersPill.tsx";

Deno.test("WorkersPill: three states with counts, linking to the Workers view", () => {
  const html = renderToStaticMarkup(
    <WorkersPill summary={{ busy: 54, idle: 13, unavailable: 1 }} />,
  );
  assertStringIncludes(html, 'href="/dashboard/workers"');
  assertStringIncludes(html, '<span class="workers-pill-label">Workers</span>');
  assertStringIncludes(html, "<strong>54</strong> busy");
  assertStringIncludes(html, "<strong>13</strong> idle");
  assertStringIncludes(html, "<strong>1</strong> unavailable");
  assertStringIncludes(html, "is-unavailable");
});
