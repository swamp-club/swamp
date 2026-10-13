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
import { assert, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShellSkeleton } from "./AppShellSkeleton.tsx";

Deno.test("AppShellSkeleton: a busy layout with the visible status", () => {
  const html = renderToStaticMarkup(
    <AppShellSkeleton label="Connecting to swamp serve" collapsed={false} />,
  );
  assertStringIncludes(html, 'aria-busy="true"');
  assertStringIncludes(html, 'role="status"');
  assertStringIncludes(html, "Connecting to swamp serve…");
  assertStringIncludes(html, 'class="app"');
  assertStringIncludes(html, 'class="stats-grid"');
  assertStringIncludes(html, 'class="chart-area"');
  assertStringIncludes(html, 'class="panels-grid"');
});

Deno.test("AppShellSkeleton: the sidebar shows its real sections", () => {
  const html = renderToStaticMarkup(<AppShellSkeleton collapsed={false} />);
  for (
    const label of [
      "Automation",
      "Operations",
      "Workflows",
      "Behaviors",
      "Extensions",
    ]
  ) {
    assertStringIncludes(html, label);
  }
  assert(!html.includes("Models"));
  // Chrome only: nothing to click until the dashboard is connected.
  assert(!html.includes("<a "));
  assert(!html.includes("<button"));
});

Deno.test("AppShellSkeleton: keeps the collapsed rail", () => {
  const html = renderToStaticMarkup(<AppShellSkeleton collapsed />);
  assertStringIncludes(html, 'class="app sidebar-collapsed"');
});

Deno.test("AppShellSkeleton: no empty-state copy", () => {
  const html = renderToStaticMarkup(<AppShellSkeleton collapsed={false} />);
  assert(!html.includes("empty-state"));
  assert(!/\bNo \w+/.test(html));
});
