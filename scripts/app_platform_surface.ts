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

import { dirname, fromFileUrl, join, resolve } from "@std/path";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

/** Each served module of swamp's own code, by its entry source. */
export function surfaceEntries(major: number): Record<string, string> {
  return {
    "sdk": join(ROOT, "packages", "app-sdk", "mod.ts"),
    "sdk-react": join(ROOT, "packages", "app-sdk", "react.tsx"),
    "ui": join(ROOT, "packages", "app-platform", String(major), "ui", "index.ts"),
  };
}

const DECLARATION =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const NAMED = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;
const STAR = /^export\s+(?:type\s+)?\*\s+from\s+"([^"]+)"/gm;

function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = join(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch {
      // try the next spelling
    }
  }
  return null;
}

function exportsOf(file: string, seen: Set<string>): Set<string> {
  const names = new Set<string>();
  if (seen.has(file)) return names;
  seen.add(file);
  const source = Deno.readTextFileSync(file);
  for (const match of source.matchAll(DECLARATION)) names.add(match[1]);
  for (const match of source.matchAll(NAMED)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  for (const match of source.matchAll(STAR)) {
    const target = resolveRelative(file, match[1]);
    if (target === null) continue;
    for (const name of exportsOf(target, seen)) names.add(name);
  }
  return names;
}

export function platformSurface(major: number): Record<string, string[]> {
  const surface: Record<string, string[]> = {};
  for (const [module, entry] of Object.entries(surfaceEntries(major))) {
    surface[module] = [...exportsOf(entry, new Set())].sort();
  }
  return surface;
}

export function surfacePath(major: number): string {
  return join(ROOT, "packages", "app-platform", String(major), "surface.json");
}

if (import.meta.main) {
  const major = Number(Deno.args[0] ?? "1");
  const platform = JSON.parse(
    Deno.readTextFileSync(
      join(ROOT, "packages", "app-platform", String(major), "platform.json"),
    ),
  ) as { minor: number };
  Deno.writeTextFileSync(
    surfacePath(major),
    `${
      JSON.stringify(
        { minor: platform.minor, exports: platformSurface(major) },
        null,
        2,
      )
    }\n`,
  );
  console.log(`Wrote ${surfacePath(major)}`);
}
