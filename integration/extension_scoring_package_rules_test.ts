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

// @swamp-club/extension-scoring is the scoring logic swamp and the Swamp
// Club registry share (swamp-club#3781). It is published to JSR for the
// registry and for consumers on other runtimes, so it stays pure: it imports
// only its own files and @std/semver, calls no runtime API, and swamp keeps
// no second copy of what it moved there.

import { assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";
import { join } from "@std/path";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  ROOT,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const PACKAGE_DIR = join(ROOT, "packages", "extension-scoring");

const IMPORT_SPECIFIER =
  /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;

function codeLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}

async function packageSourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const path of productionSourceFiles(PACKAGE_DIR)) {
    files.push(path);
  }
  return files.sort();
}

Deno.test("extension-scoring package: imports only its own files and @std/semver", async () => {
  const outside: string[] = [];
  for (const path of await packageSourceFiles()) {
    const source = codeLines(await Deno.readTextFile(path)).join("\n");
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        if (specifier.includes("/src/") || specifier.startsWith("../../")) {
          outside.push(`${repoRelative(path)} -> ${specifier}`);
        }
        continue;
      }
      if (specifier === "@std/semver") continue;
      outside.push(`${repoRelative(path)} -> ${specifier}`);
    }
  }
  assertEquals(outside, []);
});

Deno.test("extension-scoring package: calls no runtime API", async () => {
  const uses: string[] = [];
  for (const path of await packageSourceFiles()) {
    const lines = codeLines(await Deno.readTextFile(path));
    for (const line of lines) {
      if (/\b(?:Deno|process|Bun)\./.test(line)) {
        uses.push(`${repoRelative(path)}: ${line.trim()}`);
      }
    }
  }
  assertEquals(uses, []);
});

// The swamp modules the package replaced. Recreating one recreates the
// second copy this package exists to remove.
const MOVED_MODULES = [
  "src/domain/licensing",
  "src/domain/extensions/extension_doc_failure.ts",
  "src/domain/extensions/extension_secret_docs_detector.ts",
  "src/domain/extensions/dependency_version_resolution.ts",
  "src/domain/extensions/dependency_audit_record.ts",
  "src/domain/extensions/testdata/dependency_audit_vectors.json",
];

Deno.test("extension-scoring package: the swamp copies it replaced stay gone", async () => {
  const present: string[] = [];
  for (const rel of MOVED_MODULES) {
    try {
      await Deno.stat(join(ROOT, rel));
      present.push(rel);
    } catch {
      // gone, as it should be
    }
  }
  assertEquals(present, []);
});

/** Every name the package's entry modules export. */
async function packageExports(): Promise<Set<string>> {
  const names = new Set<string>();
  for await (
    const entry of walk(PACKAGE_DIR, {
      exts: [".ts"],
      includeDirs: false,
      skip: [/_test\.ts$/],
    })
  ) {
    const source = await Deno.readTextFile(entry.path);
    for (
      const m of source.matchAll(
        /^export (?:async )?(?:function|const|class|interface|type) ([A-Za-z_$][\w$]*)/gm,
      )
    ) {
      names.add(m[1]);
    }
  }
  return names;
}

// Pinned ratchet: swamp declarations sharing a name with a package export,
// none of them a copy. RubricFactor and RubricScore are the CLI's own report
// shape, built from the package's score; findManifestRoot is the filesystem
// side of the package's search; the rest are unrelated. Nothing new may
// join them.
const PINNED_REDECLARATIONS: readonly string[] = [
  "src/domain/expressions/persisted_evaluation.ts: ArgumentSchemas",
  "src/domain/extensions/extension_rubric_scorer.ts: RubricFactor",
  "src/domain/extensions/extension_rubric_scorer.ts: RubricScore",
  "src/domain/extensions/extension_rubric_scorer.ts: findManifestRoot",
  "src/presentation/output/console_writer.ts: stripAnsi",
  "src/presentation/renderers/auth_login.ts: stripAnsi",
];

Deno.test("extension-scoring package: swamp declares nothing the package exports", async () => {
  const exported = await packageExports();
  const found: string[] = [];
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(path);
    for (
      const m of source.matchAll(
        /^(?:export )?(?:async )?(?:function|const|class|interface|type) ([A-Za-z_$][\w$]*)/gm,
      )
    ) {
      if (exported.has(m[1])) found.push(`${repoRelative(path)}: ${m[1]}`);
    }
  }
  assertPinnedSet(
    [...new Set(found)].sort(),
    PINNED_REDECLARATIONS,
    "Swamp declarations of names the extension-scoring package exports",
    "Import the name from @swamp-club/extension-scoring instead of\n" +
      "declaring a second copy in swamp.",
  );
});
