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

import { assert, assertEquals } from "@std/assert";
import { dirname, join, relative, SEPARATOR } from "@std/path";
import {
  dirname as posixDirname,
  join as posixJoin,
  normalize as posixNormalize,
} from "@std/path/posix";
import fc from "fast-check";
import { importMapResolver } from "./dependency_resolution/import_map.ts";
import { scanImportSites } from "./dependency_resolution/import_sites.ts";
import type { LocalEdge } from "./extension_source_graph.ts";
import {
  applySpecifierRewrites,
  bareImportRewrites,
  planSourceArchive,
  SHARED_ARCHIVE_DIR,
} from "./source_archive_plan.ts";

const REPO = join(Deno.build.os === "windows" ? "C:\\" : "/", "repo");
const EXT = join(REPO, "extensions");

const toSpecifier = (from: string, to: string) => {
  const rel = relative(dirname(from), to).replaceAll(SEPARATOR, "/");
  return rel.startsWith("../") ? rel : `./${rel}`;
};

/** A module layout: where each file lives in the repo, the kind directory, and imports between files. */
const layout: fc.Arbitrary<Layout> = fc.record({
  kindDir: fc.constantFrom(
    ["extensions", "models"],
    ["extensions", "models", "k"],
  ),
  files: fc.uniqueArray(
    fc.tuple(
      fc.constantFrom(
        [],
        ["extensions"],
        ["extensions", "models"],
        ["extensions", "models", "k"],
        ["extensions", "models", "_lib"],
        ["extensions", "lib"],
        ["extensions", "bundles"],
        ["shared"],
        ["shared", "deep"],
      ),
      fc.constantFrom("a", "b", "c", "d"),
    ),
    {
      minLength: 1,
      maxLength: 8,
      selector: ([dir, name]) => [...dir, name].join("/"),
    },
  ),
  edgePicks: fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 16 }),
});

interface Layout {
  kindDir: string[];
  files: Array<[string[], string]>;
  edgePicks: Array<[number, number]>;
}

function build(l: Layout) {
  const kindDir = join(REPO, ...l.kindDir);
  const paths = l.files.map(([dir, name]) => join(REPO, ...dir, `${name}.ts`));
  const edges: LocalEdge[] = [];
  const seen = new Set<string>();
  for (const [i, j] of l.edgePicks) {
    const importer = paths[i % paths.length];
    const target = paths[j % paths.length];
    if (importer === target || seen.has(`${importer}>${target}`)) continue;
    seen.add(`${importer}>${target}`);
    const specifier = toSpecifier(importer, target);
    const line = edges.filter((e) => e.importer === importer).length;
    edges.push({
      importer,
      target,
      specifier,
      span: {
        start: { line, character: 20 },
        end: { line, character: 22 + specifier.length },
      },
    });
  }
  return { kindDir, paths, edges };
}

function run(kindDir: string, paths: string[], edges: LocalEdge[]) {
  return planSourceArchive({
    kinds: [{ kind: "models", dir: kindDir, modules: paths }],
    graph: {
      modules: paths.map((path) => ({ path, kind: "code" as const })),
      edges,
      missing: [],
    },
    extensionsRoot: EXT,
    allowedRoots: [REPO, EXT],
  });
}

const config = { numRuns: 300 };

Deno.test("planSourceArchive (property): every import resolves to its target inside the archive", () => {
  fc.assert(
    fc.property(layout, (l: Layout) => {
      const { kindDir, paths, edges } = build(l);
      const plan = run(kindDir, paths, edges);
      const sourceAt = new Map(
        plan.entries.map((e) => [e.archivePath, e.sourcePath]),
      );
      for (const entry of plan.entries) {
        assert(!entry.archivePath.split("/").includes(".."));
        for (const e of edges.filter((x) => x.importer === entry.sourcePath)) {
          const rewrite = entry.rewrites.find((r) =>
            r.span.start.line === e.span.start.line
          );
          const specifier = rewrite ? rewrite.to : e.specifier;
          const resolved = posixNormalize(
            posixJoin(posixDirname(entry.archivePath), specifier),
          );
          assertEquals(sourceAt.get(resolved), e.target);
        }
      }
    }),
    config,
  );
});

Deno.test("planSourceArchive (property): files inside the kind directory are rewritten only for imports into _shared", () => {
  fc.assert(
    fc.property(layout, (l: Layout) => {
      const { kindDir, paths, edges } = build(l);
      const plan = run(kindDir, paths, edges);
      for (const entry of plan.entries) {
        if (!entry.archivePath.startsWith("models/")) continue;
        for (const r of entry.rewrites) {
          const target = posixNormalize(
            posixJoin(posixDirname(entry.archivePath), r.to),
          );
          assert(target.startsWith(`${SHARED_ARCHIVE_DIR}/`), target);
        }
      }
    }),
    config,
  );
});

Deno.test("planSourceArchive (property): the plan does not depend on module or edge order", () => {
  fc.assert(
    fc.property(layout, (l: Layout) => {
      const { kindDir, paths, edges } = build(l);
      assertEquals(
        run(kindDir, paths, edges),
        run(kindDir, [...paths].reverse(), [...edges].reverse()),
      );
    }),
    config,
  );
});

// ── Bare-import rewrites (swamp-club#3637) ──────────────────────────────

const BARE_IMPORTS = {
  ms: "npm:ms@2.1.3",
  "@std/path": "jsr:@std/path@^1",
  "lodash/": "npm:/lodash@4.17.21/",
};

/** Lines a module might hold: imports of mapped, unmapped and local names, and import text as data. */
const arbModuleLine = fc.constantFrom(
  'import ms from "ms";',
  "import { join } from '@std/path';",
  'import { posix } from "@std/path/posix";',
  'import fp from "lodash/fp";',
  'import u from "unmapped";',
  'import { x } from "./x.ts";',
  'const m = await import("ms");',
  'export * from "ms";',
  '// import ms from "ms";',
  "const s = \"import ms from 'ms'\";",
  'const t = `import ms from "ms"`;',
  "const e = '🎉'; import a from \"ms\";",
  "const n = 1;",
);

// Unique lines, so no binding is declared twice and every module parses.
const arbModule = fc.uniqueArray(arbModuleLine, { maxLength: 12 }).map((
  lines,
) => lines.join("\n"));

Deno.test("bareImportRewrites: a rewritten module has no bare import the map resolves", () => {
  fc.assert(
    fc.property(arbModule, (source) => {
      const out = applySpecifierRewrites(
        source,
        bareImportRewrites(source, importMapResolver(BARE_IMPORTS), "/m.ts"),
      );
      for (const { specifier } of scanImportSites(out, "/m.ts") ?? []) {
        assert(
          !Object.keys(BARE_IMPORTS).some((k) =>
            specifier === k || specifier.startsWith(`${k}/`) ||
            (k.endsWith("/") && specifier.startsWith(k))
          ),
          `still bare after the rewrite: ${specifier}`,
        );
      }
    }),
  );
});

Deno.test("bareImportRewrites: changes only the specifiers it names", () => {
  fc.assert(
    fc.property(arbModule, (source) => {
      const rewrites = bareImportRewrites(
        source,
        importMapResolver(BARE_IMPORTS),
        "/m.ts",
      );
      const out = applySpecifierRewrites(source, rewrites);
      // Undoing each rewrite at its own position restores the source.
      const outLines = out.split("\n");
      const sorted = [...rewrites].sort((a, b) =>
        b.span.start.line - a.span.start.line ||
        b.span.start.character - a.span.start.character
      );
      for (const r of sorted) {
        const chars = Array.from(outLines[r.span.start.line]);
        const start = r.span.start.character;
        const end = start + Array.from(r.to).length + 2;
        assertEquals(chars.slice(start + 1, end - 1).join(""), r.to);
        outLines[r.span.start.line] = [
          ...chars.slice(0, start + 1),
          r.from,
          ...chars.slice(end - 1),
        ].join("");
      }
      assertEquals(outLines.join("\n"), source);
      assertEquals(out.split("\n").length, source.split("\n").length);
    }),
  );
});
