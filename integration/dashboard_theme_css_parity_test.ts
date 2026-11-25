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
import { themeCssProblem } from "../src/serve/dashboard_theme.ts";
import { safeThemeCss } from "../packages/dashboard/src/theme/theme_css.ts";

// each can make the page fetch from another origin, however it is spelled
const REFUSED = [
  '@import "https://evil.example/x.css";',
  "@IMPORT url(https://evil.example/x.css);",
  "@namespace svg url(https://evil.example/ns);",
  ".a { background: url(https://evil.example/p.png); }",
  ".a { background: URL( '//evil.example/p.png' ); }",
  '.a { background: url("http://evil.example/p.png"); }',
  ".a { background: u\\72l(https://evil.example/x); }",
  ".a { background: \\75 rl(https://evil.example/x); }",
  '@\\69mport "https://evil.example/x.css";',
  '.a { background-image: image-set("https://evil.example/a.png" 1x); }',
  '.a { background-image: -webkit-image-set("https://evil.example/a.png" 1x); }',
  '.a { background-image: image("https://evil.example/a.png"); }',
  ".a { background-image: cross-fade(url(data:,) 50%, url(data:,)); }",
  '.a { background-image: src("https://evil.example/a.png"); }',
  ".a { background: element(#x); }",
  ".a { width: expression(alert(1)); }",
  ".a { background: url(javascript:alert(1)); }",
  ".a { -moz-binding: url(data:,x); }",
];

const ALLOWED = [
  ".panel { border-width: 2px; box-shadow: 0 0 12px var(--accent); }",
  ".app { background: url(data:image/png;base64,AAAA); }",
  ".a { background-image: linear-gradient(90deg, #000, rgb(0 0 0 / 50%)); }",
  '.stat-label::before { content: "image"; text-transform: uppercase; }',
  ":root { --chart-bar-glow: 8; }",
];

Deno.test("theme.css checks: serve and the page refuse every spelling that fetches", () => {
  for (const css of REFUSED) {
    assertEquals([css, themeCssProblem(css) !== null], [css, true]);
    assertEquals([css, safeThemeCss(css)], [css, false]);
  }
});

Deno.test("theme.css checks: serve and the page allow ordinary restyling", () => {
  for (const css of ALLOWED) {
    assertEquals([css, themeCssProblem(css)], [css, null]);
    assertEquals([css, safeThemeCss(css)], [css, true]);
  }
});
