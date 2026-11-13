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
import { NAV_ICONS, NavIcon } from "./nav_icons.tsx";

Deno.test("NavIcon: renders the named icon's paths at the given size", () => {
  const html = renderToStaticMarkup(<NavIcon name="swampify" size={16} />);
  assertStringIncludes(html, NAV_ICONS.swampify);
  assertStringIncludes(html, 'width="16"');
  assertStringIncludes(html, 'aria-hidden="true"');
});

Deno.test("NavIcon: an unknown name renders an empty icon", () => {
  const html = renderToStaticMarkup(<NavIcon name="no-such-view" />);
  assertEquals(html.includes("<path"), false);
});
