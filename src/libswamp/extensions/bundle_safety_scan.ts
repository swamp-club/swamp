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

import { join, relative, SEPARATOR } from "@std/path";
import {
  analyzeBundleSafety,
  type BundleDependencyIssue,
  type SafetyIssue,
} from "../../domain/extensions/extension_safety_analyzer.ts";
import { escapeControlCharacters } from "../../domain/control_characters.ts";
import { EXTENSION_BUNDLE_KINDS } from "../../infrastructure/persistence/paths.ts";

/** What scanning an extension's bundles found. */
export interface BundleScan {
  /** Findings that refuse the install. */
  errors: SafetyIssue[];
  /** Findings in dependency code, reported only. */
  dependencyIssues: BundleDependencyIssue[];
}

/**
 * Scans every bundle of an extracted extension archive (swamp-club#3383),
 * in name order. Each bundle is named by its path in the archive, such as
 * `bundles/foo.js`, with control characters escaped. `listFiles` lists a
 * directory's files recursively and answers an empty list for a missing one.
 */
export async function scanExtractedBundles(
  extractDir: string,
  listFiles: (dir: string) => Promise<string[]>,
): Promise<BundleScan> {
  const scan: BundleScan = { errors: [], dependencyIssues: [] };
  for (const { bundleKind } of EXTENSION_BUNDLE_KINDS) {
    // Every file, whatever its name: on a case-insensitive filesystem the
    // loader opens `thing.JS` (and on Windows `thing.js.`) as `thing.js`.
    for (const file of await listFiles(join(extractDir, bundleKind))) {
      // An archive path: printed, so escaped like every archive path pull
      // prints.
      const name = escapeControlCharacters(
        relative(extractDir, file).split(SEPARATOR).join("/"),
      );
      const result = analyzeBundleSafety(await Deno.readTextFile(file), name);
      // Loops, not spreads: a bundle decides how many findings it has.
      for (const error of result.errors) scan.errors.push(error);
      for (const issue of result.dependencyIssues) {
        scan.dependencyIssues.push(issue);
      }
    }
  }
  return scan;
}

/** The lines that list bundle safety errors in a refusal. */
export function describeBundleErrors(errors: readonly SafetyIssue[]): string {
  return errors.map((e) =>
    `  ${e.file}${e.line !== undefined ? ` line ${e.line}` : ""}: ${e.message}`
  ).join("\n");
}

/**
 * One pull warning per dependency module with dynamic-code findings,
 * naming the bundles that hold it. A dependency in `reported` was already
 * warned about and is left out.
 */
export function bundleDependencyWarnings(
  issues: readonly BundleDependencyIssue[],
  reported: ReadonlySet<string> = new Set(),
): Array<{ file: string; message: string }> {
  const bundlesByDependency = new Map<string, string[]>();
  for (const { dependency, issue } of issues) {
    if (reported.has(dependency)) continue;
    const bundles = bundlesByDependency.get(dependency) ?? [];
    if (!bundles.includes(issue.file)) bundles.push(issue.file);
    bundlesByDependency.set(dependency, bundles);
  }
  return [...bundlesByDependency].map(([dependency, bundles]) => ({
    file: dependency,
    message: `Dependency code uses eval() or new Function(), in ${
      bundles.length === 1 ? bundles[0] : `${bundles.length} bundles`
    }. Findings in dependency code are reported, not refused.`,
  }));
}
