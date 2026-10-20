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
import { isBareSpecifier, isZod4Specifier } from "../models/bundle.ts";
import {
  findImportSpecifiers,
  type ImportMap,
  resolveBareImport,
} from "./extension_dependency_extractor.ts";
import { QUALITY_SIDECAR_FILENAME } from "./extension_quality_sidecar.ts";
import {
  type AstNode,
  isNode,
  parseExtensionSource,
} from "./extension_source_ast.ts";
import type {
  LocalEdge,
  SourceModuleGraph,
  SpecifierSpan,
} from "./extension_source_graph.ts";

/** The archive directory each content kind's sources are copied under. */
export type SourceArchiveKind =
  | "models"
  | "vaults"
  | "datastores"
  | "reports"
  | "webhooks";

/** The modules one content kind reaches, and the directory its archive paths are relative to. */
export interface SourceArchiveKindInput {
  kind: SourceArchiveKind;
  /** Absolute path of the kind's directory (its archive directory's source). */
  dir: string;
  /**
   * Further directories whose files the kind also packs at
   * `<kind>/<path relative to that directory>` — the models directory of a
   * `behaviors:` manifest (swamp-club#3338). Mirroring and `_shared/` stay
   * relative to `dir`.
   */
  extraDirs?: readonly string[];
  /** Absolute paths of every local module the kind's entry points reach, entry points included. */
  modules: readonly string[];
}

export interface PlanSourceArchiveInput {
  /** Kinds in a fixed order; the first kind to place a shared module decides its path. */
  kinds: readonly SourceArchiveKindInput[];
  graph: SourceModuleGraph;
  /** Anchor for `_shared/` paths: the extensions root the content hash is relative to. */
  extensionsRoot: string;
  /** Directories every module must lie inside (the repository and the extensions root). */
  allowedRoots: readonly string[];
}

/** Replace the specifier inside `span` with `to`. */
export interface SpecifierRewrite {
  span: SpecifierSpan;
  from: string;
  to: string;
}

/** One file in the archive's source copy. */
export interface SourceArchiveEntry {
  sourcePath: string;
  /** Forward-slash path under `extension/`. */
  archivePath: string;
  /** Empty when the file is copied byte for byte. */
  rewrites: SpecifierRewrite[];
}

export interface SourceArchivePlan {
  entries: SourceArchiveEntry[];
}

/** Archive directory for shared modules no mirrored path can hold. */
export const SHARED_ARCHIVE_DIR = "_shared";

/** Stands in for a `..` segment under {@link SHARED_ARCHIVE_DIR}; the registry rejects `..` in archive paths. */
const UP_SEGMENT = "_up";

/**
 * Top-level archive names a mirrored shared module may not take: push writes
 * them itself, pull installs them as a kind's sources or bundles, they are
 * reserved for shared modules, or (`drivers`, `driver-bundles`) push wrote
 * them before driver support was removed (swamp-club#1924) and pull ignores
 * them.
 */
const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set([
  "manifest.yaml",
  QUALITY_SIDECAR_FILENAME,
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
 * Whether `name`, a top-level entry of the archive's `extension/` directory,
 * is one push writes or ignores itself rather than a shared module it
 * mirrored there. Pull installs every other top-level entry, and
 * `_shared/`, as shared source (swamp-club#3384), so push and pull read the
 * same names.
 */
export function isReservedArchiveRootName(name: string): boolean {
  return RESERVED_ROOT_NAMES.has(name);
}

function toForwardSlashes(p: string): string {
  return SEPARATOR === "\\" ? p.replaceAll("\\", "/") : p;
}

/** `path` relative to `dir` with forward slashes, or undefined when `path` is on another root. */
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
 * Plans the archive's source copy: an archive path for every local module
 * each kind reaches, and the specifier rewrites that keep every local import
 * resolving inside the archive.
 *
 * - A module inside its kind's directory keeps the path it has always had,
 *   `<kind>/<path relative to the kind directory>`; each kind gets its own
 *   copy, as before.
 * - A module outside it that lies inside another kind's directory uses that
 *   kind's copy (a report importing `../models/_lib/x.ts` reaches
 *   `models/_lib/x.ts` unchanged).
 * - Any other module outside it is placed once: at its mirrored path at the archive
 *   root when it is one level above the kind directory (`../lib/x.ts` ->
 *   `lib/x.ts`), else under `_shared/` by its path from the extensions root.
 * - An import whose specifier, read from the importer's archive path, does
 *   not reach the target's archive path is rewritten. Files whose imports all
 *   resolve as written are copied byte for byte.
 *
 * Throws a UserError when a module lies outside every allowed root or two
 * different files would share an archive path.
 */
export function planSourceArchive(
  input: PlanSourceArchiveInput,
): SourceArchivePlan {
  const importerOf = new Map<string, string>();
  for (const e of input.graph.edges) {
    if (!importerOf.has(e.target)) importerOf.set(e.target, e.importer);
  }

  // In-kind copies, per kind: module path -> archive path.
  const inKind = new Map<SourceArchiveKind, Map<string, string>>();
  // Shared placements, once per module.
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
 * Applies specifier rewrites to a module's text. Spans are zero-based lines
 * and code-point columns, quotes included; each must cover the quoted
 * specifier it names, or this throws rather than corrupt the file.
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

/**
 * The offsets of the string literals Babel parses as the module specifier
 * of an import: a static import or `export ... from`, a dynamic `import()`
 * and a `typeof import()` type. Undefined when `source` does not parse. The
 * token scanner cannot tell a regex literal from a string, so only a span
 * the parser confirms is rewritten (swamp-club#3637).
 */
function importSourceOffsets(
  source: string,
  jsx: boolean,
): Set<number> | undefined {
  const program = parseExtensionSource(source, { jsx });
  if (!program) return undefined;
  const offsets = new Set<number>();
  const add = (node: unknown) => {
    if (
      isNode(node) && node.type === "StringLiteral" &&
      typeof node.start === "number"
    ) {
      offsets.add(node.start);
    }
  };
  // Explicit stack: extension source can nest deeply.
  const stack: AstNode[] = [program];
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
      case "ImportExpression":
        add(node.source);
        break;
      case "CallExpression": {
        const callee = node.callee;
        const args = node.arguments;
        if (isNode(callee) && callee.type === "Import" && Array.isArray(args)) {
          add(args[0]);
        }
        break;
      }
      case "TSImportType": {
        const argument = node.argument;
        add(
          isNode(argument) && argument.type === "TSLiteralType"
            ? argument.literal
            : argument,
        );
        break;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) stack.push(item);
      } else if (isNode(value)) {
        stack.push(value);
      }
    }
  }
  return offsets;
}

/**
 * Whether bare specifier text is one push rewrites at all: a package
 * specifier never holds whitespace, `;` or parentheses (swamp-club#3637).
 */
function isRewritableSpecifierText(specifier: string): boolean {
  return isBareSpecifier(specifier) && !/[\s;()]/.test(specifier);
}

/**
 * The specifier a rewrite ships for an import-map target: the target as
 * written, except that a zod target the host shares (zod 4 at its root or
 * `/v4`, the same namespace) ships as `npm:zod@4`. Zod is never bundled or
 * audited — every swamp shares its own zod 4 — and `npm:zod@4` is the
 * spelling every swamp version, older ones included, recognises when it
 * rebundles a pulled source.
 */
function shippedTarget(target: string): string {
  return target.startsWith("npm:zod") && isZod4Specifier(target)
    ? "npm:zod@4"
    : target;
}

/** How push ships the bare imports one module writes. */
export interface BareImportPlan {
  /** The rewrites {@link bareImportRewrites} applies. */
  rewrites: SpecifierRewrite[];
  /**
   * The bare imports that ship as written, sorted and unique: no import
   * map, no usable target, or a module the parser cannot read, so its sites
   * cannot be confirmed. The bare-specifiers finding names these.
   */
  shippedAsWritten: string[];
  /** Imports whose target could end or escape its string literal. */
  unsafe: { specifier: string; target: string }[];
}

/**
 * How push ships each bare import `source` writes (swamp-club#3637): those
 * the import map resolves to an `npm:`, `jsr:`, `node:` or `http(s):`
 * specifier are rewritten to it, as the map writes it (a zod 4 target as
 * `npm:zod@4`, see {@link shippedTarget}); a `key/` target written
 * `npm:/name@v/` is written `npm:name@v/`, which Deno reads the same and the
 * registry's specifier parser reads at all. One the map resolves to a local
 * path is a local module edge {@link planSourceArchive} places. Every other
 * bare import ships as written.
 *
 * A site is rewritten only when Babel parses that exact literal as an
 * import's module specifier; a scanner site the parse shows is not one is
 * not an import at all. When the module does not parse, nothing is
 * rewritten and every bare import ships as written.
 */
export function planBareImports(
  source: string,
  imports: ImportMap | undefined,
  sourcePath: string,
): BareImportPlan {
  const plan: BareImportPlan = {
    rewrites: [],
    shippedAsWritten: [],
    unsafe: [],
  };
  const sites = findImportSpecifiers(source).filter((site) =>
    isBareSpecifier(site.specifier)
  );
  if (sites.length === 0) return plan;
  const confirmed = importSourceOffsets(source, /\.[jt]sx$/.test(sourcePath));
  const asWritten = new Set<string>();
  for (const { specifier, span, offset } of sites) {
    if (confirmed && !confirmed.has(offset)) continue;
    const target = imports && isRewritableSpecifierText(specifier)
      ? resolveBareImport(specifier, imports)
      : undefined;
    if (target !== undefined && isLocalTarget(target)) continue;
    if (
      !confirmed || target === undefined || !REWRITABLE_TARGET_RE.test(target)
    ) {
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
 * The rewrites {@link planBareImports} plans for `source`. Throws a
 * UserError when a target the source uses holds text that could end or
 * escape its string literal: the gates read the source on disk, so the
 * archived copy must hold no code they did not see.
 */
export function bareImportRewrites(
  source: string,
  imports: ImportMap,
  sourcePath: string,
): SpecifierRewrite[] {
  const plan = planBareImports(source, imports, sourcePath);
  const [unsafe] = plan.unsafe;
  if (unsafe) {
    throw markErrorPaths(
      new UserError(
        `The deno.json import map resolves ${
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

/** A target the module graph resolves to a local file, which the plan places. */
function isLocalTarget(target: string): boolean {
  return target.startsWith("./") || target.startsWith("../") ||
    target.startsWith("/") || target.startsWith("file:");
}

/**
 * The plan's rewrites for a module plus its bare-import rewrites, sorted by
 * span. A bare rewrite at a span the plan already rewrites is dropped: the
 * import map resolved it to a local module, and the plan placed it.
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
