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

// Rewrites every import of a barrel file so each name is imported from the
// module the barrel re-exports it from. The barrel itself is left alone: it
// stays the declared list of what is public, it just stops being an import
// path, so `deno info` reports what a file really depends on.
//
// Usage (from the repository root):
//
//   deno run unbarrel            # rewrite importers of src/libswamp/mod.ts
//   deno run unbarrel --check    # report what would change, write nothing
//   deno run unbarrel <barrel>   # a different barrel, repo-root-relative
//
// The rewrite is idempotent: a second run finds nothing to do. It emits each
// rewritten statement on one line, so run `deno fmt` afterwards.
//
// `integration/ddd_layer_rules_test.ts` imports the parsing half of this
// file, so the codemod and the rule that polices its result read the barrel
// the same way.

import { parse, type ParserPlugin } from "@babel/parser";
import { walk } from "@std/fs/walk";
import { dirname, relative, resolve, SEPARATOR } from "@std/path";

const DEFAULT_BARREL = "src/libswamp/mod.ts";

// Directories that hold no source of this repository: tooling state, vendored
// packages, and other checkouts nested under `.claude/worktrees`.
const SKIPPED_DIR =
  /[\\/](?:experiments|\.agents|\.claude|\.github|\.jj|node_modules|\.git)$/;

/** A node of the Babel AST, narrowed to the fields this file reads. */
interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

/** Where the barrel gets one of its exported names from. */
export interface BarrelOrigin {
  /** Absolute path of the module, or the bare specifier when `bare`. */
  module: string;
  /** True for an import-map / npm / jsr specifier, which is kept verbatim. */
  bare: boolean;
  /** The name as that module exports it — differs from the key on a rename. */
  name: string;
  /** True when the barrel re-exports the name as a type only. */
  typeOnly: boolean;
}

/** Barrel export name → where it comes from. */
export type BarrelExports = Map<string, BarrelOrigin>;

/** How a source file refers to another module. */
export type ReferenceKind =
  /** `import { a } from "x"` / `import type { A } from "x"` */
  | "import"
  /** `export { a } from "x"` */
  | "export"
  /** `import("x").A` in a type position */
  | "import-type"
  /** `import d from "x"` */
  | "default"
  /** `import * as ns from "x"` / `export * as ns from "x"` */
  | "namespace"
  /** `export * from "x"` */
  | "export-all"
  /** `import "x"` */
  | "side-effect"
  /** `await import("x")` */
  | "dynamic"
  /** `typeof import("x")` — the whole module as a type */
  | "import-type-module";

/** One reference from a source file to another module. */
export interface ModuleReference {
  kind: ReferenceKind;
  /** The specifier exactly as written. */
  specifier: string;
  /** The names taken from the module, as the module exports them. */
  names: string[];
  /** One-based line of the reference. */
  line: number;
}

/** The outcome of rewriting one source file. */
export interface RewriteResult {
  /** The rewritten text; identical to the input when nothing changed. */
  text: string;
  /** How many references to the barrel were rewritten. */
  rewritten: number;
  /** References to the barrel that were left in place. */
  unhandled: UnhandledReference[];
}

/** A reference to the barrel the codemod cannot rewrite mechanically. */
export interface UnhandledReference {
  /** One-based line of the reference. */
  line: number;
  reason: string;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function parseModule(filePath: string, source: string): AstNode {
  const plugins: ParserPlugin[] = [
    "typescript",
    "explicitResourceManagement",
    "importAttributes",
    "decorators",
  ];
  if (filePath.endsWith("x")) plugins.push("jsx");
  const file = parse(source, {
    sourceType: "module",
    plugins,
    errorRecovery: false,
  });
  return file as unknown as AstNode;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null &&
    typeof (value as AstNode).type === "string";
}

/** Depth-first visit of every node beneath (and including) `node`. */
function visit(node: AstNode, fn: (node: AstNode) => void): void {
  fn(node);
  for (const key in node) {
    if (key === "loc" || key.endsWith("Comments")) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visit(item, fn);
    } else if (isNode(value)) {
      visit(value, fn);
    }
  }
}

/** The text of an `Identifier` or a string-literal module export name. */
function nameOf(node: unknown): string {
  const n = node as AstNode;
  return n.type === "StringLiteral" ? n.value as string : n.name as string;
}

function isStringLiteral(node: unknown): node is AstNode & { value: string } {
  return isNode(node) && node.type === "StringLiteral";
}

/** The string argument of a `TSImportType`, across Babel 7 and 8 shapes. */
function importTypeArgument(node: AstNode): AstNode & { value: string } {
  const argument = node.argument as AstNode;
  return (isStringLiteral(argument)
    ? argument
    : argument.literal) as AstNode & { value: string };
}

/** The leftmost identifier of `A` or `A.B.C`. */
function leftmostIdentifier(qualifier: AstNode): AstNode {
  let node = qualifier;
  while (node.type === "TSQualifiedName") node = node.left as AstNode;
  return node;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === "\n") line++;
  return line;
}

/** Absolute path a relative specifier points at, or undefined when bare. */
function resolveSpecifier(
  filePath: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return resolve(dirname(filePath), specifier);
}

/** A relative, forward-slash specifier from `filePath` to `target`. */
function specifierTo(filePath: string, origin: BarrelOrigin): string {
  if (origin.bare) return origin.module;
  const rel = relative(dirname(filePath), origin.module)
    .replaceAll(SEPARATOR, "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Read a barrel: every exported name and the module it is re-exported from.
 *
 * A barrel is only `export { … } from "…"` statements. Anything else —
 * `export *`, a local declaration — has no single origin to rewrite to, so it
 * throws instead of producing a partial map.
 */
export function parseBarrel(barrelPath: string, source: string): BarrelExports {
  const exports: BarrelExports = new Map();
  const program = parseModule(barrelPath, source).program as AstNode;

  for (const statement of program.body as AstNode[]) {
    const from = statement.source;
    if (
      statement.type !== "ExportNamedDeclaration" || !isStringLiteral(from)
    ) {
      throw new Error(
        `${barrelPath}:${lineOf(source, statement.start)}: a barrel may ` +
          `only contain \`export { … } from "…"\` statements, found ` +
          `${statement.type}`,
      );
    }
    const resolved = resolveSpecifier(barrelPath, from.value);
    for (const specifier of statement.specifiers as AstNode[]) {
      if (specifier.type !== "ExportSpecifier") {
        throw new Error(
          `${barrelPath}:${lineOf(source, specifier.start)}: a barrel may ` +
            `not re-export a whole module (${specifier.type})`,
        );
      }
      exports.set(nameOf(specifier.exported), {
        module: resolved ?? from.value,
        bare: resolved === undefined,
        name: nameOf(specifier.local),
        typeOnly: statement.exportKind === "type" ||
          specifier.exportKind === "type",
      });
    }
  }
  return exports;
}

/**
 * Every reference `source` makes to another module, in source order.
 *
 * `names` are the names as the referenced module exports them, so
 * `import { a as b } from "x"` reports `a`.
 */
export function findModuleReferences(
  filePath: string,
  source: string,
): ModuleReference[] {
  const references: ModuleReference[] = [];
  const add = (
    node: AstNode,
    kind: ReferenceKind,
    specifier: string,
    names: string[] = [],
  ) => {
    references.push({
      kind,
      specifier,
      names,
      line: lineOf(source, node.start),
    });
  };

  visit(parseModule(filePath, source), (node) => {
    switch (node.type) {
      case "ImportDeclaration": {
        const specifier = (node.source as AstNode).value as string;
        const specifiers = node.specifiers as AstNode[];
        if (specifiers.length === 0) {
          add(node, "side-effect", specifier);
          break;
        }
        const named = specifiers.filter((s) => s.type === "ImportSpecifier");
        if (named.length > 0) {
          add(node, "import", specifier, named.map((s) => nameOf(s.imported)));
        }
        if (specifiers.some((s) => s.type === "ImportDefaultSpecifier")) {
          add(node, "default", specifier);
        }
        if (specifiers.some((s) => s.type === "ImportNamespaceSpecifier")) {
          add(node, "namespace", specifier);
        }
        break;
      }
      case "ExportNamedDeclaration": {
        if (!isStringLiteral(node.source)) break;
        const specifiers = node.specifiers as AstNode[];
        const named = specifiers.filter((s) => s.type === "ExportSpecifier");
        if (named.length > 0) {
          add(
            node,
            "export",
            node.source.value,
            named.map((s) => nameOf(s.local)),
          );
        }
        if (named.length < specifiers.length) {
          add(node, "namespace", node.source.value);
        }
        break;
      }
      case "ExportAllDeclaration":
        add(node, "export-all", (node.source as AstNode).value as string);
        break;
      case "TSImportType": {
        const specifier = importTypeArgument(node).value;
        if (isNode(node.qualifier)) {
          add(node, "import-type", specifier, [
            nameOf(leftmostIdentifier(node.qualifier)),
          ]);
        } else {
          add(node, "import-type-module", specifier);
        }
        break;
      }
      case "ImportExpression":
        if (isStringLiteral(node.source)) {
          add(node, "dynamic", node.source.value);
        }
        break;
      case "CallExpression": {
        const [argument] = node.arguments as unknown[];
        if (
          (node.callee as AstNode).type === "Import" &&
          isStringLiteral(argument)
        ) {
          add(node, "dynamic", argument.value);
        }
        break;
      }
    }
  });
  return references;
}

/** One name of a rewritten statement, already rendered. */
interface RewrittenName {
  text: string;
  typeOnly: boolean;
}

function renderStatement(
  keyword: "import" | "export",
  specifier: string,
  names: RewrittenName[],
): string {
  // A statement whose names are all types is written `import type { … }` so
  // it is erased entirely. `import { type A }` can survive as a runtime
  // import of the module, which is the edge this codemod exists to remove.
  const allTypes = names.every((n) => n.typeOnly);
  const list = names
    .map((n) => !allTypes && n.typeOnly ? `type ${n.text}` : n.text)
    .join(", ");
  return `${keyword} ${allTypes ? "type " : ""}{ ${list} } from "${specifier}";`;
}

/**
 * Rewrite the references `source` makes to the barrel into direct ones.
 *
 * Handled: named `import … from`, named `export … from` and type-position
 * `import("…").Name`. Renames and `type` modifiers are kept; a name the barrel
 * exports as a type stays a type. Everything else that reaches the barrel —
 * a namespace, default, side-effect or dynamic import — has no mechanical
 * equivalent and is returned in `unhandled`.
 */
export function rewriteSource(
  filePath: string,
  source: string,
  barrelPath: string,
  barrel: BarrelExports,
): RewriteResult {
  const unhandled: UnhandledReference[] = [];
  const edits: Edit[] = [];
  let rewritten = 0;
  const root = parseModule(filePath, source);
  const comments = (root.comments ?? []) as AstNode[];
  const pointsAtBarrel = (specifier: unknown): boolean =>
    isStringLiteral(specifier) &&
    resolveSpecifier(filePath, specifier.value) === barrelPath;
  const skip = (node: AstNode, reason: string) => {
    unhandled.push({ line: lineOf(source, node.start), reason });
  };

  const rewriteStatement = (statement: AstNode, keyword: "import" | "export") => {
    const specifiers = statement.specifiers as AstNode[];
    const wanted = keyword === "import" ? "ImportSpecifier" : "ExportSpecifier";
    if (specifiers.length === 0) {
      return skip(statement, `side-effect ${keyword} of the barrel`);
    }
    const other = specifiers.find((s) => s.type !== wanted);
    if (other) {
      return skip(statement, `${other.type} takes the whole barrel`);
    }
    if (
      comments.some((c) => c.start > statement.start && c.end < statement.end)
    ) {
      return skip(statement, `comment inside the ${keyword} would be lost`);
    }
    const kind = keyword === "import" ? "importKind" : "exportKind";
    const groups = new Map<string, RewrittenName[]>();
    for (const specifier of specifiers) {
      // import { <taken> as <bound> } / export { <taken> as <bound> }
      const taken = nameOf(
        keyword === "import" ? specifier.imported : specifier.local,
      );
      const bound = nameOf(
        keyword === "import" ? specifier.local : specifier.exported,
      );
      const origin = barrel.get(taken);
      if (!origin) {
        return skip(statement, `${taken} is not exported by the barrel`);
      }
      const target = specifierTo(filePath, origin);
      const names = groups.get(target) ?? [];
      names.push({
        text: origin.name === bound ? bound : `${origin.name} as ${bound}`,
        typeOnly: statement[kind] === "type" || specifier[kind] === "type" ||
          origin.typeOnly,
      });
      groups.set(target, names);
    }
    rewritten++;
    edits.push({
      start: statement.start,
      end: statement.end,
      text: [...groups]
        .map(([target, names]) => renderStatement(keyword, target, names))
        .join("\n"),
    });
  };

  visit(root, (node) => {
    switch (node.type) {
      case "ImportDeclaration":
        if (pointsAtBarrel(node.source)) rewriteStatement(node, "import");
        break;
      case "ExportNamedDeclaration":
        if (pointsAtBarrel(node.source)) rewriteStatement(node, "export");
        break;
      case "ExportAllDeclaration":
        if (pointsAtBarrel(node.source)) {
          skip(node, "export * takes the whole barrel");
        }
        break;
      case "TSImportType": {
        const argument = importTypeArgument(node);
        if (!pointsAtBarrel(argument)) break;
        if (!isNode(node.qualifier)) {
          skip(node, "import() type takes the whole barrel");
          break;
        }
        const name = leftmostIdentifier(node.qualifier);
        const origin = barrel.get(nameOf(name));
        if (!origin) {
          skip(node, `${nameOf(name)} is not exported by the barrel`);
          break;
        }
        rewritten++;
        edits.push({
          start: argument.start,
          end: argument.end,
          text: `"${specifierTo(filePath, origin)}"`,
        }, { start: name.start, end: name.end, text: origin.name });
        break;
      }
      case "ImportExpression":
        if (pointsAtBarrel(node.source)) {
          skip(node, "dynamic import of the barrel");
        }
        break;
      case "CallExpression":
        if (
          (node.callee as AstNode).type === "Import" &&
          pointsAtBarrel((node.arguments as unknown[])[0])
        ) {
          skip(node, "dynamic import of the barrel");
        }
        break;
    }
  });

  let text = source;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return { text, rewritten, unhandled };
}

/** Every `.ts` / `.tsx` file of the repository at `root`, sorted. */
export async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (
    const entry of walk(root, {
      exts: [".ts", ".tsx"],
      includeDirs: false,
      skip: [SKIPPED_DIR],
    })
  ) {
    files.push(entry.path);
  }
  return files.sort();
}

/** What a run over a repository did. */
export interface UnbarrelSummary {
  /** Repo-relative paths of the files that changed (or would, on a check). */
  changedFiles: string[];
  /** References rewritten across all files. */
  rewritten: number;
  /** References left in place, with file, line and reason. */
  unhandled: string[];
  /** Names the barrel exports. */
  barrelNames: number;
}

/**
 * Rewrite every importer of the barrel under `root`. With `write: false`
 * nothing is written and the summary describes what would change.
 */
export async function unbarrel(
  root: string,
  barrelRelativePath: string,
  options: { write: boolean },
): Promise<UnbarrelSummary> {
  const barrelPath = resolve(root, barrelRelativePath);
  const barrel = parseBarrel(barrelPath, await Deno.readTextFile(barrelPath));
  const summary: UnbarrelSummary = {
    changedFiles: [],
    rewritten: 0,
    unhandled: [],
    barrelNames: barrel.size,
  };

  for (const filePath of await collectFiles(root)) {
    if (filePath === barrelPath) continue;
    const source = await Deno.readTextFile(filePath);
    // Cheap pre-filter: a file that never spells the barrel's file name
    // cannot import it.
    if (!source.includes(barrelPath.split(SEPARATOR).at(-1)!)) continue;
    const result = rewriteSource(filePath, source, barrelPath, barrel);
    summary.unhandled.push(
      ...result.unhandled.map((u) =>
        `${relative(root, filePath)}:${u.line}: ${u.reason}`
      ),
    );
    if (result.text === source) continue;
    summary.changedFiles.push(relative(root, filePath));
    summary.rewritten += result.rewritten;
    if (options.write) await Deno.writeTextFile(filePath, result.text);
  }
  return summary;
}

async function main(): Promise<void> {
  const check = Deno.args.includes("--check");
  const [barrel = DEFAULT_BARREL] = Deno.args.filter((a) => a !== "--check");
  const summary = await unbarrel(Deno.cwd(), barrel, { write: !check });

  for (const file of summary.changedFiles) {
    console.log(`${check ? "Would rewrite" : "Rewrote"}: ${file}`);
  }
  console.log(
    `\n${check ? "Would rewrite" : "Rewrote"} ${summary.rewritten} ` +
      `references to ${barrel} in ${summary.changedFiles.length} files ` +
      `(${summary.barrelNames} names in the barrel).`,
  );
  if (!check && summary.changedFiles.length > 0) {
    console.log("Run `deno fmt` to wrap the rewritten statements.");
  }
  if (summary.unhandled.length > 0) {
    console.error(
      `\nLeft in place — rewrite these by hand (${summary.unhandled.length}):`,
    );
    for (const line of summary.unhandled) console.error(`  ${line}`);
  }
  if (summary.unhandled.length > 0 || (check && summary.rewritten > 0)) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
