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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { customThemeCss } from "./custom_theme.ts";

Deno.test("customThemeCss: lays light tokens on :root and dark on both dark selectors", () => {
  const css = customThemeCss({
    colors: { light: { accent: "#4f46e5" }, dark: { accent: "#818cf8" } },
  });
  assertStringIncludes(css, ":root { --accent: #4f46e5; }");
  assertStringIncludes(
    css,
    '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --accent: #818cf8; } }',
  );
  assertStringIncludes(css, '[data-theme="dark"] { --accent: #818cf8; }');
});

Deno.test("customThemeCss: drops values that could leave their declaration", () => {
  assertEquals(
    customThemeCss({
      colors: { light: { accent: "red; } body { color: red" } },
      fonts: {
        body: "x; } *{",
        faces: [{ family: "A", src: "https://x/f.woff2" }],
      },
    }),
    "",
  );
});

Deno.test("styles: text on an accent fill is coloured by --on-accent, so a theme can keep it readable", async () => {
  const dir = new URL("../", import.meta.url);
  const files = [new URL("styles.css", dir)];
  for await (const entry of Deno.readDir(new URL("styles/", dir))) {
    if (entry.name.endsWith(".css")) {
      files.push(new URL(`styles/${entry.name}`, dir));
    }
  }
  const fixed: string[] = [];
  for (const file of files) {
    const css = await Deno.readTextFile(file);
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = rule[2];
      if (!/background(?:-color)?:\s*var\(--accent\)/.test(body)) continue;
      const color = /(?<![-\w])color:\s*([^;]+);/.exec(body)?.[1].trim();
      if (
        color !== undefined && color !== "var(--on-accent)" &&
        color !== "var(--sw-on-accent)"
      ) {
        fixed.push(`${rule[1].trim()} → ${color}`);
      }
    }
  }
  assertEquals(fixed, []);
});
