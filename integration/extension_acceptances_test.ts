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
 * Declared acceptances, end to end on a real temp filesystem: the
 * quality.yaml sidecar beside the manifest is packaged at the archive root
 * beside manifest.yaml, byte for byte; the content hash moves when the
 * sidecar changes; and a sidecar that names a file outside the manifest's
 * directory is refused before any gate runs.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { parseExtensionManifest } from "../src/domain/extensions/extension_manifest.ts";
import { computePackageCacheHash } from "../src/domain/extensions/extension_package_cache.ts";
import { extractTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
  type ExtensionPushPrepareInput,
} from "../src/libswamp/extensions/push.ts";
import { buildPrepareInput } from "../src/libswamp/extensions/push_test_helpers.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type {
  Acceptance,
  SidecarAcceptanceEntry,
} from "../src/domain/extensions/extension_acceptances.ts";
import { analyzeExtensionSafety } from "../src/domain/extensions/extension_safety_analyzer.ts";
import {
  buildFindingsReport,
  type FindingsReport,
} from "../src/presentation/renderers/extension_findings_report.ts";

const MANIFEST = [
  "manifestVersion: 1",
  'name: "@acme/accepting"',
  'version: "2026.10.06.1"',
  "description: declared acceptances fixture",
  "models:",
  "  - model.ts",
  "",
].join("\n");

const SIDECAR = [
  "version: 1",
  "generated:",
  "  by: swamp-extensions/codegen",
  "  source: https://api.example.com/openapi.yaml",
  "  commit: 0123abcd",
  "accept:",
  "  - rule: ipv4-address-literals",
  "    file: docs/hosts.txt",
  "    reason: documented lab addresses",
  "",
].join("\n");

function fakeDeps(): ExtensionPushPrepareDeps {
  return {
    loadCredentials: () => Promise.resolve(null),
    fetchCollectives: () =>
      Promise.resolve({ collectives: ["acme"], entitlements: undefined }),
    extractContentMetadata: () =>
      Promise.resolve({
        models: [],
        extensions: [],
        workflows: [],
        vaults: [],
        datastores: [],
        reports: [],
        webhooks: [],
        skills: [],
      }),
    analyzeExtensionSafety: () => Promise.resolve({ errors: [], warnings: [] }),
    checkExtensionQuality: () => Promise.resolve({ passed: true, issues: [] }),
    extractDependencySpecifiers: () => Promise.resolve([]),
    checkDependencyTrust: () =>
      Promise.resolve({ errors: [], warnings: [], audited: [], passed: true }),
    checkReviewRules: () =>
      Promise.resolve({ errors: [], warnings: [], passed: true }),
    bundleEntryPoint: () => Promise.resolve("export const model = {};\n"),
    ensureDenoPath: () => Promise.resolve("unused-deno"),
    getDenoEnv: () => ({}),
    findPublishedVersion: () => Promise.resolve(null),
    getLatestVersionDetail: () => Promise.resolve(null),
  };
}

async function withExtension(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "acceptances-" });
  try {
    await Deno.writeTextFile(join(root, "manifest.yaml"), MANIFEST);
    await Deno.writeTextFile(
      join(root, "model.ts"),
      "export const model = { name: 'thing' };\n",
    );
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

function hashInput(
  root: string,
  manifest: ReturnType<typeof parseExtensionManifest>,
) {
  return {
    manifest,
    rootDir: root,
    manifestDir: root,
    modelFilePaths: [join(root, "model.ts")],
    vaultFilePaths: [],
    datastoreFilePaths: [],
    reportFilePaths: [],
    webhookFilePaths: [],
    workflowFilePaths: [],
    additionalFilePaths: [],
    binaryFilePaths: [],
    skillFilePaths: [],
    includeFilePaths: [],
    denoConfigPath: undefined,
    packageJsonPath: undefined,
  };
}

Deno.test("declared acceptances: quality.yaml beside the manifest is packaged at the archive root, byte for byte", async () => {
  await withExtension(async (root) => {
    await Deno.writeTextFile(join(root, "quality.yaml"), SIDECAR);
    const manifest = parseExtensionManifest(MANIFEST);
    const input = buildPrepareInput(manifest, root, {
      modelsDir: root,
      allModelFiles: [join(root, "model.ts")],
      modelEntryPoints: [join(root, "model.ts")],
      registryChecks: "skip",
    });
    const prepared = await extensionPushPrepare(
      createLibSwampContext(),
      fakeDeps(),
      input,
    );
    assert(prepared.sidecar);
    assertEquals(
      prepared.sidecar.value.generated?.by,
      "swamp-extensions/codegen",
    );

    const extracted = join(root, "extracted");
    await extractTarGz(
      new Blob([new Uint8Array(prepared.archiveBytes)]).stream(),
      extracted,
    );
    const packaged = await Deno.readTextFile(
      join(extracted, "extension", "quality.yaml"),
    );
    assertEquals(packaged, SIDECAR);
    // Beside the manifest, not under files/.
    await Deno.stat(join(extracted, "extension", "manifest.yaml"));
  });
});

Deno.test("declared acceptances: the content hash moves when the sidecar appears or changes", async () => {
  await withExtension(async (root) => {
    const manifest = parseExtensionManifest(MANIFEST);
    const without = await computePackageCacheHash(hashInput(root, manifest));
    await Deno.writeTextFile(join(root, "quality.yaml"), SIDECAR);
    const withSidecar = await computePackageCacheHash(
      hashInput(root, manifest),
    );
    assertNotEquals(without, withSidecar);
    await Deno.writeTextFile(
      join(root, "quality.yaml"),
      SIDECAR.replace("lab addresses", "test addresses"),
    );
    const changed = await computePackageCacheHash(hashInput(root, manifest));
    assertNotEquals(withSidecar, changed);
  });
});

Deno.test("declared acceptances: a sidecar with a traversal path is refused before any gate runs", async () => {
  await withExtension(async (root) => {
    await Deno.writeTextFile(
      join(root, "quality.yaml"),
      "version: 1\naccept:\n  - rule: ipv4-address-literals\n    file: ../hosts.txt\n    reason: r\n",
    );
    const manifest = parseExtensionManifest(MANIFEST);
    let gatesRan = 0;
    const deps = fakeDeps();
    deps.analyzeExtensionSafety = () => {
      gatesRan++;
      return Promise.resolve({ errors: [], warnings: [] });
    };
    const input = buildPrepareInput(manifest, root, {
      modelsDir: root,
      allModelFiles: [join(root, "model.ts")],
      modelEntryPoints: [join(root, "model.ts")],
      registryChecks: "skip",
    });
    const error = await assertRejects(() =>
      extensionPushPrepare(createLibSwampContext(), deps, input)
    ) as { code: string; message: string };
    assertEquals(error.code, "validation_failed");
    assert(error.message.includes("quality.yaml"));
    assertEquals(gatesRan, 0);
  });
});

// ── Structured acceptances, applied as an agent would (swamp-club#3107) ──

/** Applies every acceptance in the report to the files, as an agent would: no prose parsed. */
async function applyAcceptances(report: FindingsReport): Promise<void> {
  const comments = new Map<
    string,
    Extract<Acceptance, { form: "comment" }>[]
  >();
  const sidecars = new Map<string, SidecarAcceptanceEntry[]>();
  for (const warning of report.unresolvedWarnings ?? []) {
    const acceptance = warning.acceptance;
    if (!acceptance) continue;
    if (acceptance.form === "comment") {
      comments.set(acceptance.file, [
        ...comments.get(acceptance.file) ?? [],
        acceptance,
      ]);
    } else {
      sidecars.set(acceptance.file, [
        ...sidecars.get(acceptance.file) ?? [],
        acceptance.entry,
      ]);
    }
  }
  for (const [file, acceptances] of comments) {
    const lines = (await Deno.readTextFile(file)).split("\n");
    // Bottom-up, so an inserted line never moves a later edit's line.
    for (const a of acceptances.toSorted((x, y) => y.line - x.line)) {
      lines.splice(a.line - 1, 0, a.text);
    }
    await Deno.writeTextFile(file, lines.join("\n"));
  }
  for (const [file, entries] of sidecars) {
    // Add to the existing accept list; start the file only when it is absent.
    const existing = await Deno.readTextFile(file)
      .then((text) => parseYaml(text) as Record<string, unknown>)
      .catch((): Record<string, unknown> => ({ version: 1 }));
    const accept = (existing.accept as unknown[] | undefined) ?? [];
    await Deno.writeTextFile(
      file,
      stringifyYaml({ ...existing, accept: [...accept, ...entries] }),
    );
  }
}

const BLOB = "Q".repeat(120);

async function withFindingsExtension(
  fn: (root: string, input: ExtensionPushPrepareInput) => Promise<void>,
): Promise<void> {
  await withExtension(async (root) => {
    const model = join(root, "model.ts");
    await Deno.writeTextFile(
      model,
      [
        "export const model = { name: 'thing' };",
        // Two findings on one indented line: deno-command and base64-run.
        "export function run() {",
        `  return new Deno.Command("vendor", { args: ["${BLOB}"] }); // don't inline`,
        "}",
        // A base64 run inside a multi-line template literal, where a
        // comment line would become part of the string.
        "export const script = `",
        BLOB,
        "`;",
        "",
      ].join("\n"),
    );
    await Deno.mkdir(join(root, "docs"));
    const readme = join(root, "README.md");
    await Deno.writeTextFile(
      readme,
      // The fenced address cannot take an HTML comment: inside the fence it
      // is code, not a directive.
      "# Thing\n\nGateway: 10.0.0.1\nRouter: 10.0.0.2\n\n```sh\ncurl http://10.0.0.9\n```\n",
    );
    const hosts = join(root, "docs", "hosts.txt");
    const lab = join(root, "docs", "lab.txt");
    await Deno.writeTextFile(hosts, "10.0.0.3\n");
    await Deno.writeTextFile(lab, "10.0.0.4\n");
    const manifest = parseExtensionManifest(
      MANIFEST +
        "additionalFiles:\n  - README.md\n  - docs/hosts.txt\n  - docs/lab.txt\n",
    );
    const input = buildPrepareInput(manifest, root, {
      modelsDir: root,
      allModelFiles: [model],
      modelEntryPoints: [model],
      additionalFilePaths: [readme, hosts, lab],
      registryChecks: "skip",
    });
    await fn(root, input);
  });
}

function findingsDeps(root: string): ExtensionPushPrepareDeps {
  return {
    ...fakeDeps(),
    analyzeExtensionSafety,
    checkReviewRules: () =>
      Promise.resolve({
        errors: [],
        warnings: [{
          ruleId: "testing-completeness",
          dimension: "Testing Completeness",
          severity: "medium",
          file: join(root, "model.ts"),
          message: "No sibling `_test.ts` found.",
        }],
        passed: true,
      }),
  };
}

Deno.test("declared acceptances: every acceptance a dry run reports applies mechanically, and the re-run accepts each finding", async () => {
  await withFindingsExtension(async (root, input) => {
    const deps = findingsDeps(root);
    const first = await extensionPushPrepare(
      createLibSwampContext(),
      deps,
      input,
    );
    const report = buildFindingsReport({
      safetyWarnings: first.safetyWarnings,
      reviewWarnings: first.reviewRulesResult.warnings,
      acceptances: first.acceptances,
      commentSites: first.commentSites,
    }, root);
    const forms = (report.unresolvedWarnings ?? []).map((w) =>
      w.acceptance?.form === "comment"
        ? `${w.ruleId}:${w.line}:${w.acceptance.position}`
        : `${w.ruleId}:${w.line}:${w.acceptance?.form ?? "none"}`
    ).sort();
    assertEquals(forms, [
      "base64-run:3:line-above",
      "base64-run:6:none",
      "deno-command:3:line-above",
      "ipv4-address-literals:1:sidecar",
      "ipv4-address-literals:1:sidecar",
      "ipv4-address-literals:3:line-above",
      "ipv4-address-literals:4:line-above",
      "ipv4-address-literals:7:none",
      "testing-completeness:undefined:file-header",
    ]);
    // Every comment acceptance names its file, line and position.
    for (const w of report.unresolvedWarnings ?? []) {
      if (w.acceptance?.form !== "comment") continue;
      assert(w.acceptance.file.startsWith(root));
      assertEquals(typeof w.acceptance.line, "number");
    }

    await applyAcceptances(report);
    // Each inserted comment is indented like the line it names, so the
    // file stays formatted.
    const edited = (await Deno.readTextFile(join(root, "model.ts"))).split(
      "\n",
    );
    edited.forEach((line, i) => {
      if (!line.includes("swamp-quality-ignore") || i === 0) return;
      const below = edited.slice(i + 1).find((l) =>
        !l.includes("swamp-quality-ignore")
      )!;
      assertEquals(/^\s*/.exec(line)![0], /^\s*/.exec(below)![0], line);
    });

    const second = await extensionPushPrepare(
      createLibSwampContext(),
      deps,
      input,
    );
    // The two sidecar entries merged into one valid quality.yaml.
    assertEquals(second.sidecar?.value.accept, [
      { rule: "ipv4-address-literals", file: "docs/hosts.txt" },
      { rule: "ipv4-address-literals", file: "docs/lab.txt" },
    ]);
    // Only the two findings offered no acceptance remain; the template
    // literal and the fence are unchanged.
    assertEquals(
      second.safetyWarnings.map((w) => w.ruleId).sort(),
      ["base64-run", "ipv4-address-literals"],
    );
    assertStringIncludes(
      await Deno.readTextFile(join(root, "model.ts")),
      "export const script = `\n" + BLOB + "\n`;",
    );
    assertEquals(second.reviewRulesResult.errors, []);
    assertEquals(second.reviewRulesResult.warnings, []);
    assertEquals(second.acceptances.accepted.length, 7);
    for (const a of second.acceptances.accepted) {
      assertEquals("reason" in a, false);
    }
  });
});

Deno.test("declared acceptances: an error-level rule with no reason is still a blocking invalid-acceptance", async () => {
  await withFindingsExtension(async (root, input) => {
    await Deno.writeTextFile(
      join(root, "model.ts"),
      "export const model = { name: 'thing' }; // swamp-quality-ignore dynamic-code\n",
    );
    const error = await assertRejects(() =>
      extensionPushPrepare(createLibSwampContext(), findingsDeps(root), input)
    ) as { details?: { reviewRuleErrors?: { ruleId: string }[] } };
    assertEquals(
      error.details?.reviewRuleErrors?.map((e) => e.ruleId),
      ["invalid-acceptance"],
    );
  });
});
