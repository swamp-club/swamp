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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SkeletonChart,
  SkeletonKeyValues,
  SkeletonStats,
  SkeletonTable,
} from "./Skeleton.tsx";

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

Deno.test("SkeletonChart: draws one bar and one x label per bar", () => {
  const html = renderToStaticMarkup(<SkeletonChart bars={5} />);
  // Each bar and each x label is a placeholder block; gridLines + 1 more
  // blocks are the y-axis ticks.
  assertEquals(count(html, 'class="skel"'), 5 + 5 + 5);
  assertStringIncludes(html, 'aria-hidden="true"');
});

Deno.test("SkeletonChart: draws gridlines with a stronger baseline", () => {
  const html = renderToStaticMarkup(<SkeletonChart gridLines={3} />);
  assertEquals(count(html, "var(--border-subtle)"), 3);
  assertEquals(count(html, "background:var(--border)"), 1);
});

Deno.test("SkeletonChart: is decorative and never claims to be data", () => {
  const html = renderToStaticMarkup(<SkeletonChart />);
  assert(!html.includes("role="));
});

Deno.test("SkeletonKeyValues: shows the known keys for real", () => {
  const html = renderToStaticMarkup(
    <SkeletonKeyValues
      keys={["Port", "TLS"]}
      rowClassName="detail-row"
      keyClassName="detail-key"
    />,
  );
  assertStringIncludes(html, '<span class="detail-key">Port</span>');
  assertStringIncludes(html, '<span class="detail-key">TLS</span>');
  assertEquals(count(html, 'class="detail-row"'), 2);
});

Deno.test("SkeletonKeyValues: without keys, renders placeholder keys", () => {
  const html = renderToStaticMarkup(<SkeletonKeyValues rows={3} />);
  assertEquals(count(html, 'class="sys-row"'), 3);
  assertEquals(count(html, 'class="skel"'), 6);
});

Deno.test("SkeletonTable: real column headers in a busy region", () => {
  const html = renderToStaticMarkup(
    <SkeletonTable
      columns={[{ header: "Name" }, { header: "Status", cell: "pill" }]}
      rows={2}
      label="Loading things"
    />,
  );
  assertStringIncludes(html, 'aria-busy="true"');
  assertStringIncludes(html, "<th>Name</th><th>Status</th>");
  assertStringIncludes(html, "Loading things");
  assertEquals(count(html, 'class="skel-row"'), 2);
});

Deno.test("SkeletonStats: four cards keep the stylesheet's responsive grid", () => {
  assert(!renderToStaticMarkup(<SkeletonStats />).includes("grid-template"));
  assertStringIncludes(
    renderToStaticMarkup(<SkeletonStats count={3} />),
    "grid-template-columns:repeat(3, 1fr)",
  );
});
