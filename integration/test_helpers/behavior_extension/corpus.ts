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

/**
 * The golden corpus for the behavior-spelling extension compatibility test
 * (swamp-club#3338): writes each fixture to a temp repo, model-spelled or
 * behavior-spelled, and turns it into what the registry receives from a push
 * (content metadata, archive listing and re-emitted manifest) plus the
 * catalog-gap verdict of each source file.
 */

import { dirname, fromFileUrl, join, relative, SEPARATOR } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import type { ExtensionFixture } from "./fixtures.ts";
import { extractContentMetadata } from "../../../src/domain/extensions/extension_content_extractor.ts";
import { modelCatalogGap } from "../../../src/domain/extensions/model_catalog_gap.ts";
import { resolveExtensionFiles } from "../../../src/cli/resolve_extension_files.ts";
import { DenoInfoModuleGraphReader } from "../../../src/infrastructure/runtime/deno_info_module_graph_reader.ts";
import type { RepositoryContext } from "../../../src/infrastructure/persistence/repository_factory.ts";
import {
  extensionPushPrepare,
  type ExtensionPushPrepared,
  type ExtensionPushPrepareDeps,
} from "../../../src/libswamp/extensions/push.ts";
import { createLibSwampContext } from "../../../src/libswamp/context.ts";
import { extractTarGz } from "../../../src/infrastructure/archive/tar_archive.ts";
import { computeChecksum } from "../../../src/domain/models/checksum.ts";
import { emptyArchiveIndex } from "../../../src/libswamp/extensions/extension_tree_index_test_helpers.ts";

const HERE = dirname(fromFileUrl(import.meta.url));

/** The golden of every model-spelled fixture. */
export const EXTENSION_GOLDEN_PATH = join(HERE, "goldens", "extensions.json");

/** How a fixture is spelled when written out. */
export type Spelling = "model" | "behavior";

/**
 * A source file respelled: `export const model` becomes
 * `export const behavior`. Nothing else changes.
 */
export function respellSource(content: string): string {
  return content.replaceAll(
    /export(\s+)const(\s+)model(\s*[=:])/g,
    "export$1const$2behavior$3",
  );
}

/**
 * Writes `fixture` into `root` as a repo: the sources under
 * `extensions/models/` (model spelling) or `extensions/behaviors/` with the
 * behavior export (behavior spelling), and `extensions/manifest.yaml`
 * listing them under `models:` or `behaviors:`. Returns the manifest path.
 */
export async function writeFixture(
  fixture: ExtensionFixture,
  root: string,
  spelling: Spelling,
): Promise<string> {
  const dirName = spelling === "model" ? "models" : "behaviors";
  const base = join(root, "extensions", dirName);
  for (const [rel, content] of Object.entries(fixture.files)) {
    const path = join(base, ...rel.split("/"));
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      spelling === "behavior" && rel.endsWith(".ts")
        ? respellSource(content)
        : content,
    );
  }
  const manifestPath = join(root, "extensions", "manifest.yaml");
  await Deno.writeTextFile(
    manifestPath,
    stringifyYaml({
      manifestVersion: 1,
      name: `@acme/${fixture.id}`,
      version: "2026.05.01.1",
      description: `Fixture ${fixture.id}`,
      [dirName]: [...fixture.models],
      ...(fixture.include ? { include: [...fixture.include] } : {}),
    }),
  );
  return manifestPath;
}

/** The catalog-gap verdict of each `.ts` file, keyed by its fixture path. */
export function catalogGaps(
  fixture: ExtensionFixture,
  spelling: Spelling,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rel, content] of Object.entries(fixture.files)) {
    if (!rel.endsWith(".ts")) continue;
    out[rel] = modelCatalogGap(
      spelling === "behavior" ? respellSource(content) : content,
    );
  }
  return out;
}

/** Content metadata of the fixture's entry points, read in place. */
export async function extractorMetadata(
  fixture: ExtensionFixture,
  root: string,
  spelling: Spelling,
): Promise<unknown> {
  const base = join(
    root,
    "extensions",
    spelling === "model" ? "models" : "behaviors",
  );
  return await extractContentMetadata(
    fixture.models.map((m) => join(base, ...m.split("/"))),
    base,
    [],
  );
}

function prepareDeps(): ExtensionPushPrepareDeps {
  return {
    loadCredentials: () => Promise.resolve(null),
    fetchCollectives: () =>
      Promise.resolve({ collectives: [], entitlements: undefined }),
    extractContentMetadata,
    analyzeExtensionSafety: () => Promise.resolve({ errors: [], warnings: [] }),
    checkExtensionQuality: () => Promise.resolve({ passed: true, issues: [] }),
    extractDependencySpecifiers: () => Promise.resolve([]),
    checkDependencyTrust: () =>
      Promise.resolve({ errors: [], warnings: [], audited: [], passed: true }),
    checkReviewRules: () =>
      Promise.resolve({ errors: [], warnings: [], passed: true }),
    // A bundle that keeps the entry point's text, so the export name the
    // author wrote travels into the archive as it would through deno bundle.
    // Like deno bundle it erases the types, so push can parse it as
    // JavaScript: the fixtures' type-only imports and export annotations.
    indexArchive: emptyArchiveIndex,
    bundleEntryPoint: async (entryPoint) =>
      `// bundle\n${eraseFixtureTypes(await Deno.readTextFile(entryPoint))}`,
    ensureDenoPath: () => Promise.resolve("/unused/deno"),
    getDenoEnv: () => ({}),
    findPublishedVersion: () => Promise.resolve(null),
    getLatestVersionDetail: () => Promise.resolve(null),
  };
}

/**
 * Resolves the manifest at `manifestPath` and runs the push prepare phase
 * in-process, packaging only: no registry calls, local gates collected.
 */
export async function preparePush(
  repoDir: string,
  manifestPath: string,
): Promise<ExtensionPushPrepared> {
  const resolved = await resolveExtensionFiles({
    repoDir,
    manifestPath,
    // Only workflow entries read the repository context; the corpus has none.
    repoContext: {} as RepositoryContext,
    logger: getLogger(["swamp", "test", "behavior-extension"]),
    moduleGraphReader: new DenoInfoModuleGraphReader(Deno.execPath()),
  });
  return await extensionPushPrepare(createLibSwampContext(), prepareDeps(), {
    ...resolved,
    repoDir,
    manifestDir: dirname(resolved.absoluteManifestPath),
    dryRun: true,
    registryChecks: "skip",
    localGates: "collect",
  });
}

/** What a pushed archive holds: its file listing, manifest and file hashes. */
export interface ArchiveSnapshot {
  files: string[];
  manifest: string;
  sha256: Record<string, string>;
  /** The dependency audit record, each bundle hash replaced by its path. */
  auditRecord: unknown;
}

/** Extracts `archive` in-process and snapshots it. */
export async function snapshotArchive(
  archive: Uint8Array,
): Promise<ArchiveSnapshot> {
  const dir = await Deno.makeTempDir({ prefix: "behavior-ext-archive-" });
  try {
    await extractTarGz(ReadableStream.from([archive]), dir);
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for await (const entry of Deno.readDir(d)) {
        const path = join(d, entry.name);
        if (entry.isDirectory) await walk(path);
        else files.push(relative(dir, path).split(SEPARATOR).join("/"));
      }
    };
    await walk(dir);
    files.sort();
    const sha256: Record<string, string> = {};
    for (const f of files) {
      sha256[f] = await computeChecksum(
        await Deno.readFile(join(dir, ...f.split("/"))),
      );
    }
    const record = JSON.parse(
      await Deno.readTextFile(join(dir, "extension", "dependency-audit.json")),
    );
    return {
      files,
      manifest: await Deno.readTextFile(
        join(dir, "extension", "manifest.yaml"),
      ),
      sha256,
      auditRecord: {
        ...record,
        bundles: Object.keys(record.bundles ?? {}),
      },
    };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** The review findings a push reports, with paths relative to `root`. */
export function reviewWarnings(
  prepared: ExtensionPushPrepared,
  root: string,
): Array<{ ruleId: string; file: string; message: string }> {
  return prepared.reviewRulesResult.warnings.map((w) => ({
    ruleId: w.ruleId,
    file: w.file.startsWith("(")
      ? w.file
      : relative(root, w.file).split(SEPARATOR).join("/"),
    message: w.message,
  }));
}

/** Everything the golden pins for one fixture in one spelling. */
export interface FixtureSnapshot {
  extractor: unknown;
  catalogGaps: Record<string, unknown>;
  contentMetadata: unknown;
  archive: ArchiveSnapshot;
  reviewWarnings: Array<{ ruleId: string; file: string; message: string }>;
}

/** Writes `fixture` to a fresh temp repo and snapshots it. */
export async function snapshotFixture(
  fixture: ExtensionFixture,
  spelling: Spelling,
): Promise<FixtureSnapshot> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "behavior-ext-" }),
  );
  try {
    const manifestPath = await writeFixture(fixture, root, spelling);
    const prepared = await preparePush(root, manifestPath);
    return {
      extractor: await extractorMetadata(fixture, root, spelling),
      catalogGaps: catalogGaps(fixture, spelling),
      contentMetadata: prepared.contentMetadata,
      archive: await snapshotArchive(prepared.archiveBytes),
      reviewWarnings: reviewWarnings(prepared, root),
    };
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

function eraseFixtureTypes(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.startsWith("import type "))
    .join("\n")
    .replace(/^(export const \w+): [\w.<>]+ =/gm, "$1 =");
}
