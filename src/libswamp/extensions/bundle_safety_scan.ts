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
import { BUNDLE_FORMAT_VERSION } from "../../domain/models/bundle.ts";
import { EXTENSION_BUNDLE_KINDS } from "../../infrastructure/persistence/paths.ts";
import {
  MAX_DEPENDENCY_AUDIT_RECORD_BYTES,
  parseDependencyAuditRecord,
  parseDependencyAuditRecordV2,
} from "@swamp-club/extension-scoring/dependency-audit";

/** What scanning an extension's bundles found. */
export interface BundleScan {
  /** Findings that refuse the install. */
  errors: SafetyIssue[];
  /** Findings in dependency code, reported only. */
  dependencyIssues: BundleDependencyIssue[];
  /**
   * Each scanned bundle's forward-slash archive path, unescaped, to the
   * `sha256:<hex>` of its bytes, as push records it.
   */
  hashes: Map<string, string>;
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
  const scan: BundleScan = {
    errors: [],
    dependencyIssues: [],
    hashes: new Map(),
  };
  for (const { bundleKind } of EXTENSION_BUNDLE_KINDS) {
    // Every file, whatever its name: on a case-insensitive filesystem the
    // loader opens `thing.JS` (and on Windows `thing.js.`) as `thing.js`.
    for (const file of await listFiles(join(extractDir, bundleKind))) {
      const archivePath = relative(extractDir, file).split(SEPARATOR).join(
        "/",
      );
      // An archive path: printed, so escaped like every archive path pull
      // prints.
      const name = escapeControlCharacters(archivePath);
      // One read: the bytes hashed are the bytes scanned (swamp-club#3972).
      const bytes = await Deno.readFile(file);
      scan.hashes.set(archivePath, await sha256Of(bytes));
      const result = analyzeBundleSafety(
        new TextDecoder().decode(bytes),
        name,
      );
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

async function sha256Of(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${
    Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")
  }`;
}

/** What an archive's dependency audit record says about its bundles. */
export interface BundleRecordCheck {
  /**
   * Run the archive's bundles rather than rebuilding them from source:
   * there is no v2 record (an archive pushed before it), or the record's
   * bundle format is the one this swamp runs.
   */
  keepArchiveBundles: boolean;
  /** Why the archive is refused, one line per bundle; empty when it is not. */
  refusals: string[];
}

/**
 * Checks the scanned bundles against the archive's dependency audit record
 * (swamp-club#3972). `recordText` is the record, or undefined when the
 * archive has none. A v1 record carries no hashes, so its bundles are kept
 * as `extension install` keeps them. A v2 record must list every bundle,
 * with the hash of the bytes scanned, and every bundle it lists must be
 * there: the record and the bundles were written by one push, so a bundle
 * changed apart from its record is refused. That is consistency within the
 * archive, not who published it. The record's keys are only compared with
 * the scanned paths, never opened.
 */
export function checkBundleRecord(
  hashes: ReadonlyMap<string, string>,
  recordText: string | undefined,
): BundleRecordCheck {
  if (recordText === undefined) {
    return { keepArchiveBundles: true, refusals: [] };
  }
  const unreadable = {
    keepArchiveBundles: false,
    refusals: [
      "dependency-audit.json: not a dependency audit record this swamp can read",
    ],
  };
  if (
    new TextEncoder().encode(recordText).length >
      MAX_DEPENDENCY_AUDIT_RECORD_BYTES
  ) {
    return unreadable;
  }
  const record = parseDependencyAuditRecordV2(recordText);
  if (!record) {
    return parseDependencyAuditRecord(recordText)
      ? { keepArchiveBundles: true, refusals: [] }
      : unreadable;
  }
  const refusals: string[] = [];
  const listed = new Map(Object.entries(record.bundles));
  for (const [path, hash] of [...hashes].sort(([a], [b]) => a < b ? -1 : 1)) {
    const recorded = listed.get(path);
    const name = escapeControlCharacters(path);
    if (recorded === undefined) {
      refusals.push(`${name}: not listed in dependency-audit.json`);
    } else if (recorded !== hash) {
      refusals.push(
        `${name}: does not match the SHA-256 dependency-audit.json records for it`,
      );
    }
  }
  for (const path of [...listed.keys()].sort()) {
    if (!hashes.has(path)) {
      refusals.push(
        `${
          escapeControlCharacters(path)
        }: listed in dependency-audit.json but not in the archive`,
      );
    }
  }
  return {
    keepArchiveBundles: record.bundleFormat === BUNDLE_FORMAT_VERSION,
    refusals,
  };
}
