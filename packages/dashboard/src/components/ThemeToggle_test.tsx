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
import { assert } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeToggle } from "./ThemeToggle.tsx";

Deno.test("ThemeToggle: the header placement offers the three themes on the page's surface", () => {
  const html = renderToStaticMarkup(<ThemeToggle placement="header" />);
  for (const theme of ["light", "system", "dark"]) {
    assert(html.includes(`aria-label="${theme} theme"`));
  }
  assert(html.includes("var(--border)"));
  assert(!renderToStaticMarkup(<ThemeToggle />).includes("var(--border)"));
});
