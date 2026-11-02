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

import { LineIndex, type SourceComment } from "./extension_source_ast.ts";

/**
 * author is the extension's own code, including code after an unrecognised line
 * comment, which cannot be shown to be a dependency's; unattributed is
 * esbuild's prelude or a bundle with no module comments
 */
export type BundleModuleOrigin = "author" | "dependency" | "unattributed";

export interface BundleModule {
  path?: string;
  origin: BundleModuleOrigin;
}

interface ModuleMark {
  line: number;
  path: string;
  recognized: boolean;
}

// A module comment's text after `//`: one space, then a module path. esbuild
// writes the path as it is, spaces included, relative to the working directory
// or the output file (a bare `compose.ts` included), or a specifier such as
// `deno:https://...`.
const MODULE_COMMENT =
  /^ ((?:https?|npm|jsr|deno|node|file):\S+|\S.*\.(?:[cm]?[jt]sx?|json))$/i;

// Line comments esbuild keeps that are not module boundaries: annotations
// (`@__NO_SIDE_EFFECTS__`), source-map directives (`# sourceMappingURL=`),
// and legal comments that start with `!`, `@license` or `@preserve`. Only
// these forms, so a path that happens to start with `@` or `#` is still a
// boundary.
const ANNOTATION =
  /^\s*(?:@__[A-Za-z_]+__|#\s*source(?:Mapping)?URL=|!|@(?:license|preserve)\b)/;

const DEPENDENCY_PATH = new RegExp(
  [
    "^(?:https?|npm|jsr|deno|node):",
    "(?:^|/)(?:node_modules|deno-cache|deno_dir|\\.deno)/",
    "(?:^|/)registry\\.npmjs\\.org/",
    "(?:^|/)remote/https?/",
    "(?:^|/)jsr\\.io/",
    "(?:^|/)(?:Library/Caches/deno|\\.cache/deno|AppData/Local/deno)/",
  ].join("|"),
  "i",
);

function slashed(path: string): string {
  return path.replaceAll("\\", "/");
}

export function isDependencyModulePath(path: string): boolean {
  return DEPENDENCY_PATH.test(slashed(path));
}

/**
 * A dependency module's path without the machine it was bundled on: the
 * registry part of a cache path (`npm:zod/4.3.6/v4/core/util.js`), the URL
 * of a remote module, so the publisher's bundle and a rebuild on this
 * machine name the same dependency alike.
 */
export function dependencyLabel(path: string): string {
  const p = slashed(path);
  const npm = /(?:^|\/)registry\.npmjs\.org\/(.+)$/i.exec(p);
  if (npm) return `npm:${npm[1]}`;
  const nodeModules = p.lastIndexOf("node_modules/");
  if (nodeModules !== -1) {
    return `npm:${p.slice(nodeModules + "node_modules/".length)}`;
  }
  const remote = /(?:^|\/)remote\/(https?)\/(.+)$/i.exec(p);
  if (remote) return `${remote[1]}://${remote[2]}`;
  if (p.startsWith("deno:")) return p.slice("deno:".length);
  return p.replace(/^(?:\.\.\/)+/, "");
}

function markFor(line: number, text: string): ModuleMark | undefined {
  const match = MODULE_COMMENT.exec(text);
  if (match) return { line, path: match[1], recognized: true };
  if (ANNOTATION.test(text)) return undefined;
  return { line, path: text.trim(), recognized: false };
}

/**
 * every column-0 line comment except a known annotation is a boundary, so an
 * unrecognised module comment still ends the module above. The comments are
 * text whoever built the bundle chose.
 */
export class BundleModuleMap {
  private constructor(private readonly marks: readonly ModuleMark[]) {}

  /**
   * The map of a bundle that parsed, from the comments the parser found:
   * only line comments starting at column 0, so comment-like text inside a
   * string or template literal is not taken for a module.
   */
  static fromComments(
    source: string,
    comments: readonly SourceComment[],
  ): BundleModuleMap {
    const lines = new LineIndex(source);
    const marks: ModuleMark[] = [];
    for (const comment of comments) {
      if (comment.type !== "CommentLine") continue;
      if (comment.start > 0 && source[comment.start - 1] !== "\n") continue;
      const mark = markFor(lines.position(comment.start).line, comment.value);
      if (mark) marks.push(mark);
    }
    marks.sort((a, b) => a.line - b.line);
    return new BundleModuleMap(marks);
  }

  static fromText(source: string): BundleModuleMap {
    const marks: ModuleMark[] = [];
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
      if (!line.startsWith("//")) continue;
      const mark = markFor(i + 1, line.slice(2));
      if (mark) marks.push(mark);
    }
    return new BundleModuleMap(marks);
  }

  get moduleCount(): number {
    return this.marks.length;
  }

  moduleAt(line: number): BundleModule {
    let lo = 0;
    let hi = this.marks.length - 1;
    let found: ModuleMark | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.marks[mid].line < line) {
        found = this.marks[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found === undefined) return { origin: "unattributed" };
    return {
      path: found.path,
      origin: found.recognized && isDependencyModulePath(found.path)
        ? "dependency"
        : "author",
    };
  }
}
