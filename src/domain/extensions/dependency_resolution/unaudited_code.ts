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

import type { UnauditedDependencyKind } from "@swamp-club/extension-scoring/dependency-audit";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isUrl(specifier: unknown): specifier is string {
  return typeof specifier === "string" &&
    (specifier.startsWith("https:") || specifier.startsWith("http:"));
}

export interface FetchedModule {
  url: string;
  local?: string;
}

export interface UrlImportClosure {
  origin: string;
  modules: FetchedModule[];
}

export function urlImportClosures(
  json: unknown,
  isLocal: (specifier: string) => boolean,
): UrlImportClosure[] {
  const body = record(json);
  const redirects = record(body.redirects);
  const follow = (url: string): string => {
    const seen = new Set<string>();
    let current = url;
    while (typeof redirects[current] === "string" && !seen.has(current)) {
      seen.add(current);
      current = redirects[current] as string;
    }
    return current;
  };
  const modules = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(body.modules) ? body.modules : []) {
    const m = record(raw);
    if (typeof m.specifier === "string") modules.set(m.specifier, m);
  }
  const urlDeps = (m: Record<string, unknown>): string[] => {
    const deps = Array.isArray(m.dependencies) ? m.dependencies : [];
    return deps.flatMap((dep) => {
      const { code, type } = record(dep);
      return [record(code).specifier, record(type).specifier].filter(isUrl);
    });
  };

  const origins = new Set<string>();
  for (const [specifier, m] of modules) {
    if (isLocal(specifier)) { for (const url of urlDeps(m)) origins.add(url); }
  }
  return [...origins].sort().map((origin) => {
    const reached = new Map<string, FetchedModule>();
    const queue = [follow(origin)];
    while (queue.length > 0) {
      const url = queue.shift()!;
      if (reached.has(url)) continue;
      const m = modules.get(url);
      reached.set(url, {
        url,
        ...(typeof m?.local === "string" ? { local: m.local } : {}),
      });
      if (m) { for (const dep of urlDeps(m)) queue.push(follow(dep)); }
    }
    return {
      origin,
      modules: [...reached.values()].sort((a, b) =>
        a.url < b.url ? -1 : a.url > b.url ? 1 : 0
      ),
    };
  });
}

export function packageJsonSpecKind(
  spec: string,
): "registry" | UnauditedDependencyKind {
  const s = spec.trim();
  if (
    s.startsWith("file:") || s.startsWith("link:") ||
    s.startsWith("workspace:") || s.startsWith("portal:") ||
    s.startsWith(".") || s.startsWith("/") || s.startsWith("~")
  ) return "package-json";
  if (
    s.startsWith("git") || s.startsWith("github:") ||
    s.startsWith("gitlab:") || s.startsWith("bitbucket:") ||
    /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(s)
  ) return "git";
  if (s.startsWith("http:") || s.startsWith("https:")) return "url";
  return "registry";
}

export interface NonRegistryDependency {
  name: string;
  spec: string;
  kind: UnauditedDependencyKind;
}

export function nonRegistryDependencies(
  packageJson: unknown,
): NonRegistryDependency[] {
  const pkg = record(packageJson);
  const declared = new Map<string, string>();
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries(record(pkg[field]))) {
      if (typeof spec === "string" && !declared.has(name)) {
        declared.set(name, spec);
      }
    }
  }
  return [...declared].flatMap(([name, spec]) => {
    const kind = packageJsonSpecKind(spec);
    return kind === "registry" ? [] : [{ name, spec, kind }];
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
