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
import { HostMap } from "./HostMap.tsx";

Deno.test("HostMap: renders a focusable, labelled map frame for D3 to fill", () => {
  const html = renderToStaticMarkup(
    <HostMap
      workers={[]}
      slots={new Map()}
      groupBy="fleet"
      ttlMs={7_200_000}
      selectedName={null}
      onSelect={() => {}}
      label="Workers grouped by Fleet"
    />,
  );
  assertStringIncludes(html, 'aria-label="Workers grouped by Fleet"');
  assertStringIncludes(html, 'tabindex="0"');
  assertStringIncludes(html, 'aria-roledescription="worker map"');
  assertStringIncludes(html, 'class="hm-cells"');
  assertStringIncludes(html, 'class="hm-nodes"');
});
