// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

export interface DependencySpecifier {
  name: string;
  version: string | null;
  registry: "npm" | "jsr";
  sourceFile: string;
}

function stripComments(source: string): string {
  let result = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (source[i] === "/" && source[i + 1] === "*") {
      i += 2;
      while (
        i < source.length - 1 && !(source[i] === "*" && source[i + 1] === "/")
      ) i++;
      i += 2;
    } else {
      result += source[i];
      i++;
    }
  }
  return result;
}

// Matches static imports: `from "npm:..."` and side-effect `import "npm:..."`
const STATIC_IMPORT_RE =
  /(?:from|import)\s+["'](?<specifier>(?:npm|jsr):[^"']+)["']/g;

// Matches dynamic imports: `import("npm:...")`
const DYNAMIC_IMPORT_RE =
  /import\s*\(\s*["'](?<specifier>(?:npm|jsr):[^"']+)["']\s*\)/g;

// Parses `npm:@scope/name@version`, `npm:name@version`, `npm:name`
const NPM_SPECIFIER_RE =
  /^npm:(?<name>(?:@[^/@]+\/)?[^/@]+)(?:@(?<version>[^/]+))?/;

// Parses `jsr:@scope/name@version`, `jsr:@scope/name`
const JSR_SPECIFIER_RE = /^jsr:(?<name>@[^/@]+\/[^/@]+)(?:@(?<version>[^/]+))?/;

// zod is externalized by the bundler — not a real extension dependency
const EXCLUDED_PACKAGES = new Set(["zod"]);

function parseSpecifier(
  raw: string,
): { name: string; version: string | null; registry: "npm" | "jsr" } | null {
  if (raw.startsWith("npm:")) {
    const match = NPM_SPECIFIER_RE.exec(raw);
    if (!match?.groups) return null;
    const name = match.groups.name;
    if (EXCLUDED_PACKAGES.has(name)) return null;
    return { name, version: match.groups.version ?? null, registry: "npm" };
  }
  if (raw.startsWith("jsr:")) {
    const match = JSR_SPECIFIER_RE.exec(raw);
    if (!match?.groups) return null;
    return {
      name: match.groups.name,
      version: match.groups.version ?? null,
      registry: "jsr",
    };
  }
  return null;
}

export function extractSpecifiersFromSource(
  source: string,
  sourceFile: string,
): DependencySpecifier[] {
  const seen = new Set<string>();
  const results: DependencySpecifier[] = [];
  const stripped = stripComments(source);

  for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    for (const match of stripped.matchAll(re)) {
      const raw = match.groups?.specifier;
      if (!raw) continue;
      const parsed = parseSpecifier(raw);
      if (!parsed) continue;

      const key = `${parsed.registry}:${parsed.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({ ...parsed, sourceFile });
    }
  }

  return results;
}

export async function extractDependencySpecifiers(
  sourceFiles: string[],
): Promise<DependencySpecifier[]> {
  const seen = new Map<string, DependencySpecifier>();

  for (const file of sourceFiles) {
    if (!file.endsWith(".ts")) continue;
    let source: string;
    try {
      source = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    for (const spec of extractSpecifiersFromSource(source, file)) {
      const key = `${spec.registry}:${spec.name}`;
      if (!seen.has(key)) {
        seen.set(key, spec);
      }
    }
  }

  return Array.from(seen.values());
}
