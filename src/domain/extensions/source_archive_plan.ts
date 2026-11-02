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

import { isAbsolute, relative, SEPARATOR } from "@std/path";
import {
  dirname as posixDirname,
  join as posixJoin,
  normalize as posixNormalize,
  relative as posixRelative,
} from "@std/path/posix";
import { markErrorPaths, UserError } from "../errors.ts";
import { isZod4Specifier } from "../models/bundle.ts";
import { scanImportSites } from "./dependency_resolution/import_sites.ts";
import { isBareSpecifier } from "./dependency_resolution/specifier.ts";
import type { BareImportResolver } from "./bare_import_resolution.ts";
import { QUALITY_SIDECAR_FILENAME } from "./extension_quality_sidecar.ts";
import {
  DEPENDENCY_AUDIT_RECORD_FILENAME,
} from "@swamp-club/extension-scoring/dependency-audit";
import type {
  LocalEdge,
  SourceModuleGraph,
  SpecifierSpan,
} from "./extension_source_graph.ts";

export type SourceArchiveKind =
  | "models"
  | "vaults"
  | "datastores"
  | "reports"
  | "webhooks";

export interface SourceArchiveKindInput {
  kind: SourceArchiveKind;
  dir: string;
  /**
   * further directories whose files the kind also packs at <kind>/<path
   * relative to it>, such as the models directory of a behaviors: manifest;
   * mirroring and _shared/ stay relative to dir
   */
  extraDirs?: readonly string[];
  modules: readonly string[];
}

export interface PlanSourceArchiveInput {
  /** Kinds in a fixed order; the first kind to place a shared module decides its path. */
  kinds: readonly SourceArchiveKindInput[];
  graph: SourceModuleGraph;
  extensionsRoot: string;
  allowedRoots: readonly string[];
}

export interface SpecifierRewrite {
  span: SpecifierSpan;
  from: string;
  to: string;
}

export interface SourceArchiveEntry {
  sourcePath: string;
  archivePath: string;
  rewrites: SpecifierRewrite[];
}

export interface SourceArchivePlan {
  entries: SourceArchiveEntry[];
}

export const SHARED_ARCHIVE_DIR = "_shared";

/** Stands in for a `..` segment under {@link SHARED_ARCHIVE_DIR}; the registry rejects `..` in archive paths. */
const UP_SEGMENT = "_up";

/**
 * names a mirrored shared module may not take: push writes them, pull installs
 * them as a kind's sources or bundles, they are reserved for shared modules, or
 * (drivers, driver-bundles) pull ignores them
 */
const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set([
  "manifest.yaml",
  QUALITY_SIDECAR_FILENAME,
  DEPENDENCY_AUDIT_RECORD_FILENAME,
  "models",
  "bundles",
  "workflows",
  "vaults",
  "vault-bundles",
  "datastores",
  "datastore-bundles",
  "reports",
  "report-bundles",
  "webhooks",
  "webhook-bundles",
  "skills",
  "files",
  "drivers",
  "driver-bundles",
  SHARED_ARCHIVE_DIR,
]);

/**
 * pull installs every other top-level entry, and _shared/, as shared source, so
 * push and pull read the same names
 */
export function isReservedArchiveRootName(name: string): boolean {
  return RESERVED_ROOT_NAMES.has(name);
}

function toForwardSlashes(p: string): string {
  return SEPARATOR === "\\" ? p.replaceAll("\\", "/") : p;
}

function relativeForward(dir: string, path: string): string | undefined {
  const rel = relative(dir, path);
  if (isAbsolute(rel)) return undefined;
  return toForwardSlashes(rel);
}

function isInside(rel: string): boolean {
  return rel !== "" && rel !== ".." && !rel.startsWith("../");
}

/**
 * The archive path a module one level above the kind's directory would have
 * if the archive root stood in for that parent directory, so the kind's
 * relative imports reach it unchanged; undefined for any other module.
 */
function mirroredRootPath(kindDir: string, path: string): string | undefined {
  const rel = relativeForward(kindDir, path);
  if (rel === undefined || !rel.startsWith("../")) return undefined;
  const rest = rel.slice(3);
  return isInside(rest) && !rest.split("/").includes("..") ? rest : undefined;
}

/**
 * Where a module outside its kind's directory goes: mirrored at the archive
 * root when it sits one level above the kind's directory under a name the
 * archive does not reserve, else under `_shared/`.
 */
function sharedPlacement(
  kindDir: string,
  extensionsRoot: string,
  path: string,
): string {
  const mirrored = mirroredRootPath(kindDir, path);
  if (
    mirrored !== undefined &&
    !isReservedArchiveRootName(mirrored.split("/")[0])
  ) {
    return mirrored;
  }
  const fromRoot = relativeForward(extensionsRoot, path);
  if (fromRoot === undefined) {
    throw markErrorPaths(
      new Error(`Cannot place ${path} relative to ${extensionsRoot}`),
      [path, extensionsRoot],
    );
  }
  const segments = fromRoot.split("/").map((s) => s === ".." ? UP_SEGMENT : s);
  return `${SHARED_ARCHIVE_DIR}/${segments.join("/")}`;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function relativeSpecifier(fromArchivePath: string, to: string): string {
  const rel = posixRelative(posixDirname(fromArchivePath), to);
  return rel.startsWith("../") ? rel : `./${rel}`;
}

function assertContained(
  path: string,
  allowedRoots: readonly string[],
  importer: string | undefined,
): void {
  for (const root of allowedRoots) {
    const rel = relativeForward(root, path);
    if (rel !== undefined && isInside(rel)) return;
  }
  const by = importer ? ` (imported from ${importer})` : "";
  throw markErrorPaths(
    new UserError(
      `Local module ${path}${by} is outside the repository and the ` +
        `extensions root, so push cannot include it in the archive. Move it ` +
        `inside the repository.`,
    ),
    importer ? [path, importer] : [path],
  );
}

/**
 * in-kind modules keep <kind>/<relative path>; others reuse another kind's
 * copy, else are placed once at a mirrored root path or under _shared/; imports
 * are rewritten to resolve inside the archive
 */
export function planSourceArchive(
  input: PlanSourceArchiveInput,
): SourceArchivePlan {
  const importerOf = new Map<string, string>();
  for (const e of input.graph.edges) {
    if (!importerOf.has(e.target)) importerOf.set(e.target, e.importer);
  }

  const inKind = new Map<SourceArchiveKind, Map<string, string>>();
  const shared = new Map<string, string>();
  const occupant = new Map<string, string>();
  const claim = (archivePath: string, sourcePath: string) => {
    const existing = occupant.get(archivePath);
    if (existing !== undefined && existing !== sourcePath) {
      throw markErrorPaths(
        new UserError(
          `${existing} and ${sourcePath} would both be packed as ` +
            `${archivePath}. Rename or move one of them so each local ` +
            `module has its own archive path.`,
        ),
        [existing, sourcePath, archivePath],
      );
    }
    occupant.set(archivePath, sourcePath);
  };

  for (const k of input.kinds) {
    const placed = new Map<string, string>();
    inKind.set(k.kind, placed);
    for (const path of k.modules) {
      assertContained(path, input.allowedRoots, importerOf.get(path));
      const rel = [k.dir, ...(k.extraDirs ?? [])]
        .map((d) => relativeForward(d, path))
        .find((r) => r !== undefined && isInside(r));
      if (rel === undefined) continue;
      const archivePath = posixNormalize(`${k.kind}/${rel}`);
      claim(archivePath, path);
      placed.set(path, archivePath);
    }
  }
  // A module inside another kind's directory already has a copy there; a
  // kind that imports it from outside its own directory uses that copy,
  // preferring the one its relative imports reach unchanged.
  const copiesOf = new Map<string, string[]>();
  for (const placed of inKind.values()) {
    for (const [path, archivePath] of placed) {
      copiesOf.set(path, [...(copiesOf.get(path) ?? []), archivePath]);
    }
  }
  const borrowed = new Map<SourceArchiveKind, Map<string, string>>();
  for (const k of input.kinds) {
    const placed = inKind.get(k.kind)!;
    const fromOtherKinds = new Map<string, string>();
    borrowed.set(k.kind, fromOtherKinds);
    for (const path of k.modules) {
      if (placed.has(path)) continue;
      const copies = copiesOf.get(path);
      if (copies) {
        const mirrored = mirroredRootPath(k.dir, path);
        fromOtherKinds.set(
          path,
          mirrored !== undefined && copies.includes(mirrored)
            ? mirrored
            : copies[0],
        );
        continue;
      }
      if (shared.has(path)) continue;
      const archivePath = sharedPlacement(k.dir, input.extensionsRoot, path);
      claim(archivePath, path);
      shared.set(path, archivePath);
    }
  }

  const edgesByImporter = new Map<string, LocalEdge[]>();
  for (const e of input.graph.edges) {
    const list = edgesByImporter.get(e.importer) ?? [];
    list.push(e);
    edgesByImporter.set(e.importer, list);
  }

  const entries = new Map<string, SourceArchiveEntry>();
  const addEntry = (
    sourcePath: string,
    archivePath: string,
    locate: (target: string) => string | undefined,
  ) => {
    if (entries.has(archivePath)) return;
    const rewrites: SpecifierRewrite[] = [];
    for (const e of edgesByImporter.get(sourcePath) ?? []) {
      const targetPath = locate(e.target);
      if (targetPath === undefined) {
        throw markErrorPaths(
          new UserError(
            `Not in the archive: ${e.target} (imported from ${sourcePath} ` +
              `as ${e.specifier}).`,
          ),
          [e.target, sourcePath],
        );
      }
      const asWritten = isRelativeSpecifier(e.specifier)
        ? posixNormalize(posixJoin(posixDirname(archivePath), e.specifier))
        : undefined;
      if (asWritten === targetPath) continue;
      rewrites.push({
        span: e.span,
        from: e.specifier,
        to: relativeSpecifier(archivePath, targetPath),
      });
    }
    rewrites.sort((a, b) =>
      a.span.start.line - b.span.start.line ||
      a.span.start.character - b.span.start.character
    );
    entries.set(archivePath, { sourcePath, archivePath, rewrites });
  };

  for (const k of input.kinds) {
    const placed = inKind.get(k.kind)!;
    const fromOtherKinds = borrowed.get(k.kind)!;
    const locate = (target: string) =>
      placed.get(target) ?? fromOtherKinds.get(target) ?? shared.get(target);
    for (const path of k.modules) {
      // A copy borrowed from another kind is written by that kind.
      if (fromOtherKinds.has(path)) continue;
      addEntry(path, placed.get(path) ?? shared.get(path)!, locate);
    }
  }

  return {
    entries: [...entries.values()].sort((a, b) =>
      a.archivePath < b.archivePath ? -1 : a.archivePath > b.archivePath ? 1 : 0
    ),
  };
}

/**
 * each span must cover the quoted specifier it names, or this throws rather
 * than corrupt the file
 */
export function applySpecifierRewrites(
  text: string,
  rewrites: readonly SpecifierRewrite[],
): string {
  if (rewrites.length === 0) return text;
  const lines = text.split("\n");
  const ordered = [...rewrites].sort((a, b) =>
    b.span.start.line - a.span.start.line ||
    b.span.start.character - a.span.start.character
  );
  for (const r of ordered) {
    const { start, end } = r.span;
    if (start.line !== end.line || lines[start.line] === undefined) {
      throw new Error(
        `Import specifier span does not fit the file: ${JSON.stringify(r)}`,
      );
    }
    const chars = Array.from(lines[start.line]);
    const quoted = chars.slice(start.character, end.character).join("");
    const quote = quoted[0];
    if (
      quoted.length < 2 || quoted !== `${quote}${r.from}${quote}` ||
      !["'", '"', "`"].includes(quote)
    ) {
      throw new Error(
        `Import specifier span does not cover ${r.from}: found ${quoted}`,
      );
    }
    lines[start.line] = [
      ...chars.slice(0, start.character),
      `${quote}${r.to}${quote}`,
      ...chars.slice(end.character),
    ].join("");
  }
  return lines.join("\n");
}

/** Import-map targets a bare import is rewritten to: they resolve without a config. */
const REWRITABLE_TARGET_RE = /^(?:npm|jsr|node|https?):/;

/**
 * Text that could end or escape the string literal a target is written
 * into, so the archive would carry code no gate read: the gates read the
 * source on disk, not the rewritten copy.
 */
const UNSAFE_TARGET_RE = /["'`\\\r\n\u2028\u2029]|\$\{/;

/** a package specifier never holds whitespace, ; or parentheses */
function isRewritableSpecifierText(specifier: string): boolean {
  return isBareSpecifier(specifier) && !/[\s;()]/.test(specifier);
}

/**
 * a zod target the host shares ships as npm:zod@4: zod is never bundled or
 * audited, and every swamp version recognises that spelling when it rebundles a
 * pulled source
 */
function shippedTarget(target: string): string {
  return target.startsWith("npm:zod") && isZod4Specifier(target)
    ? "npm:zod@4"
    : target;
}

export interface BareImportPlan {
  rewrites: SpecifierRewrite[];
  /**
   * sorted and unique: Deno does not resolve them, their target is not one push
   * writes, or the parser cannot read the module; the bare-specifiers finding
   * names these
   */
  shippedAsWritten: string[];
  unsafe: { specifier: string; target: string }[];
}

/**
 * bare imports resolving to npm:, jsr:, node: or http(s): are rewritten as Deno
 * writes them; local targets are placed by planSourceArchive; the rest ship as
 * written; unparsable modules plan nothing
 */
export function planBareImports(
  source: string,
  resolver: BareImportResolver | undefined,
  sourcePath: string,
): BareImportPlan {
  const plan: BareImportPlan = {
    rewrites: [],
    shippedAsWritten: [],
    unsafe: [],
  };
  const sites = (scanImportSites(source, sourcePath) ?? []).filter((site) =>
    isBareSpecifier(site.specifier)
  );
  const asWritten = new Set<string>();
  for (const { specifier, span } of sites) {
    const target = resolver && isRewritableSpecifierText(specifier)
      ? resolver.resolve(sourcePath, specifier)
      : undefined;
    if (target !== undefined && isLocalTarget(target)) continue;
    if (target === undefined || !REWRITABLE_TARGET_RE.test(target)) {
      asWritten.add(specifier);
      continue;
    }
    if (UNSAFE_TARGET_RE.test(target)) {
      plan.unsafe.push({ specifier, target });
      continue;
    }
    plan.rewrites.push({
      span,
      from: specifier,
      to: shippedTarget(target.replace(/^(npm|jsr):\//, "$1:")),
    });
  }
  plan.shippedAsWritten = [...asWritten].sort();
  return plan;
}

/**
 * throws a UserError when a target holds text that could end or escape its
 * string literal: the gates read the source on disk, so the archived copy must
 * hold no code they did not see
 */
export function bareImportRewrites(
  source: string,
  resolver: BareImportResolver,
  sourcePath: string,
): SpecifierRewrite[] {
  const plan = planBareImports(source, resolver, sourcePath);
  const [unsafe] = plan.unsafe;
  if (unsafe) {
    throw markErrorPaths(
      new UserError(
        `The project's Deno config resolves ${
          JSON.stringify(unsafe.specifier)
        } ` +
          `(imported from ${sourcePath}) to ${
            JSON.stringify(unsafe.target)
          }, ` +
          `which holds a quote, backslash, backtick, line break or \${ ` +
          `that push cannot write into the archive's source. Fix the ` +
          `import map entry for ${JSON.stringify(unsafe.specifier)}.`,
      ),
      [sourcePath],
    );
  }
  return plan.rewrites;
}

function isLocalTarget(target: string): boolean {
  return target.startsWith("./") || target.startsWith("../") ||
    target.startsWith("/") || target.startsWith("file:");
}

/**
 * a bare rewrite at a span the plan already rewrites is dropped: the project
 * config resolved it to a local module and the plan placed it
 */
export function mergeSpecifierRewrites(
  planRewrites: readonly SpecifierRewrite[],
  bareRewrites: readonly SpecifierRewrite[],
): SpecifierRewrite[] {
  const at = (r: SpecifierRewrite) =>
    `${r.span.start.line}:${r.span.start.character}`;
  const planned = new Set(planRewrites.map(at));
  return [
    ...planRewrites,
    ...bareRewrites.filter((r) => !planned.has(at(r))),
  ].sort((a, b) =>
    a.span.start.line - b.span.start.line ||
    a.span.start.character - b.span.start.character
  );
}
