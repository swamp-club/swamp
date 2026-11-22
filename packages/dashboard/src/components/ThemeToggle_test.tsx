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
import { assert, assertEquals } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryStorage } from "../client/memory_storage_test_helpers.ts";
import { ThemeToggle } from "./ThemeToggle.tsx";

function pressed(html: string): string[] {
  return [...html.matchAll(/aria-label="(\w+) theme" aria-pressed="true"/g)]
    .map((m) => m[1]);
}

function storing(value: string | null): () => Storage {
  const storage = new MemoryStorage();
  if (value !== null) storage.setItem("swamp-dashboard-theme", value);
  return () => storage;
}

Deno.test("ThemeToggle: the header placement offers the three themes on the page's surface", () => {
  const storage = storing(null);
  const html = renderToStaticMarkup(
    <ThemeToggle placement="header" storage={storage} />,
  );
  for (const theme of ["light", "system", "dark"]) {
    assert(html.includes(`aria-label="${theme} theme"`));
  }
  assert(html.includes("var(--border)"));
  assert(
    !renderToStaticMarkup(<ThemeToggle storage={storage} />).includes(
      "var(--border)",
    ),
  );
});

Deno.test("ThemeToggle: the stored theme is the one pressed", () => {
  const html = renderToStaticMarkup(<ThemeToggle storage={storing("dark")} />);
  assertEquals(pressed(html), ["dark"]);
});

Deno.test("ThemeToggle: nothing stored, or a value it never writes, presses system", () => {
  for (const value of [null, "sepia"]) {
    const html = renderToStaticMarkup(<ThemeToggle storage={storing(value)} />);
    assertEquals(pressed(html), ["system"]);
  }
});

Deno.test("ThemeToggle: storage that refuses to be read presses system instead of throwing", () => {
  const locked = () => {
    throw new Error("database is locked");
  };
  const unreachable = renderToStaticMarkup(<ThemeToggle storage={locked} />);
  assertEquals(pressed(unreachable), ["system"]);

  const refusing = new MemoryStorage();
  refusing.getItem = locked;
  const html = renderToStaticMarkup(<ThemeToggle storage={() => refusing} />);
  assertEquals(pressed(html), ["system"]);
});
