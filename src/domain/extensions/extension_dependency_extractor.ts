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

export interface DependencySpecifier {
  name: string;
  version: string | null;
  registry: "npm" | "jsr";
  sourceFile: string;
}

function stripComments(source: string): string {
  const lines = source.split("\n");
  const result: string[] = [];
  let inBlockComment = false;

  for (const line of lines) {
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end !== -1) {
        inBlockComment = false;
        result.push(line.slice(end + 2));
      }
      continue;
    }

    const blockStart = line.indexOf("/*");
    if (blockStart !== -1) {
      const blockEnd = line.indexOf("*/", blockStart + 2);
      if (blockEnd !== -1) {
        result.push(line.slice(0, blockStart) + line.slice(blockEnd + 2));
      } else {
        inBlockComment = true;
        result.push(line.slice(0, blockStart));
      }
      continue;
    }

    // Only strip // comments on lines containing import/export keywords
    // to avoid false-stripping URLs in string literals
    if (/\b(?:import|export)\b/.test(line)) {
      const lineComment = line.indexOf("//");
      if (lineComment !== -1) {
        result.push(line.slice(0, lineComment));
        continue;
      }
    }

    result.push(line);
  }

  return result.join("\n");
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
