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
import fc from "fast-check";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  escapeControlCharacters,
  escapeControlCharactersInText,
} from "../../domain/control_characters.ts";
import type { ExtensionSearchItem } from "../../libswamp/extensions/search.ts";
import type { DoctorExtensionsReport } from "../../libswamp/extensions/doctor.ts";
import type { ModelGetData } from "../../libswamp/models/get.ts";
import type { SourceLocation } from "../../domain/extensions/source_location.ts";
import { ExtensionReplacement } from "../../domain/extensions/extension_replacement.ts";
import { parseRepositoryUrl } from "../../domain/extensions/repository_url.ts";
import { createExtensionSearchRenderer } from "../renderers/extension_search.tsx";
import {
  renderAutoResolveCollectiveNotTrusted,
  renderAutoResolveInstalled,
  renderAutoResolveInstalledWithoutType,
  renderAutoResolveInstalling,
  renderAutoResolveNetworkError,
  renderAutoResolveTruncated,
} from "../renderers/extension_auto_resolve.ts";
import { createDoctorExtensionsRenderer } from "../renderers/doctor_extensions.ts";
import { renderModelGet } from "../renderers/model_get.ts";
import { renderDatastoreTypeScrollback } from "../renderers/datastore_type_search.tsx";
import { createVaultTypeSearchRenderer } from "../renderers/vault_type_search.tsx";
import { createReportTypeSearchRenderer } from "../renderers/report_type_search.tsx";
import { createExtensionPullRenderer } from "../renderers/extension_pull.ts";
import { createExtensionPushRenderer } from "../renderers/extension_push.ts";
import { dispatchRepositoryReport } from "../../cli/commands/extension_report_dispatcher.ts";
import { assertNoControlCharacters } from "./terminal_output_test_helpers.ts";

await initializeLogging({});

const text = fc.string({
  unit: fc.oneof(
    fc.constantFrom("\x00", "\x07", "\x1b", "\x7f", "\x9b", "\n", "\r", "["),
    fc.constantFrom("\x1b[31m", "\x1b[2J", "\x1b]0;title\x07"),
    fc.fullUnicode(),
  ),
});

const RUNS = { numRuns: 50 };

/** console output of every level, colour codes left in */
async function capture(run: () => void | Promise<void>): Promise<string> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => [m, console[m]] as const);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a ?? "")).join(" "));
    };
  }
  try {
    await run();
  } finally {
    for (const [m, original] of originals) console[m] = original;
  }
  return lines.join("\n");
}

// multi-line remote text keeps its tabs on purpose
function assertEscaped(
  output: string,
  single: readonly string[],
  multi: readonly string[] = [],
): void {
  assertNoControlCharacters(
    multi.length > 0 ? output.replaceAll("\t", "") : output,
  );
  for (const value of single) {
    const escaped = escapeControlCharacters(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
  for (const value of multi) {
    const escaped = escapeControlCharactersInText(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
}

const extensionArb = fc.record({
  name: text,
  description: text,
  repository: text,
  latestVersion: text,
  platform: text,
  label: text,
  contentType: text,
  createdAt: text,
  updatedAt: text,
  deprecationReason: text,
  supersededBy: text,
});

type ExtensionFields = typeof extensionArb extends fc.Arbitrary<infer T> ? T
  : never;

function extensionOf(x: ExtensionFields): ExtensionSearchItem {
  return {
    name: x.name,
    description: x.description,
    repository: x.repository,
    repositoryVerified: true,
    repositoryVerifiedUrl: null,
    latestVersion: x.latestVersion,
    latestRc: null,
    latestBeta: null,
    platforms: [x.platform],
    labels: [x.label],
    contentTypes: [x.contentType],
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
    deprecatedAt: "2026-01-01",
    deprecationReason: x.deprecationReason,
    supersededBy: x.supersededBy,
  };
}

Deno.test("createExtensionSearchRenderer: the plain list escapes every registry field, and JSON output is the input exactly", async () => {
  await fc.assert(
    fc.asyncProperty(extensionArb, async (x) => {
      const item = extensionOf(x);
      const data = {
        query: "",
        results: [item],
        meta: { total: 1, page: 1, perPage: 20 },
      };
      const log = await capture(() =>
        createExtensionSearchRenderer("log", { interactive: false })
          .handlers().completed({ kind: "completed", data })
      );
      assertEscaped(
        log,
        [
          x.name,
          x.repository,
          x.latestVersion,
          x.platform,
          x.label,
          x.contentType,
          x.deprecationReason,
          x.supersededBy,
        ],
        [x.description],
      );
      const json = await capture(() =>
        createExtensionSearchRenderer("json").handlers().completed({
          kind: "completed",
          data,
        })
      );
      assertEquals(JSON.parse(json), {
        query: "",
        extensions: [item],
        meta: data.meta,
      });
    }),
    RUNS,
  );
});

const resolveArb = fc.record({
  extension: text,
  version: text,
  newer: text,
  type: text,
  collective: text,
  error: text,
  missing: text,
  // short and on one line, so the summary is the whole value
  description: text.filter((d) =>
    !/[\n\r]/.test(d) && escapeControlCharacters(d).length < 70
  ),
});

Deno.test("renderAutoResolve*: no registry-supplied control character reaches the terminal, and JSON output is the input exactly", async () => {
  await fc.assert(
    fc.asyncProperty(resolveArb, async (r) => {
      const log = await capture(() => {
        renderAutoResolveInstalling(
          r.extension,
          r.version,
          `a${r.description}z`,
          "log",
        );
        renderAutoResolveInstalled(r.extension, r.version, 1, "log");
        renderAutoResolveInstalledWithoutType(
          r.extension,
          r.type,
          r.version,
          r.newer,
          "log",
        );
        renderAutoResolveTruncated(r.extension, "p", [r.missing], "log");
        renderAutoResolveCollectiveNotTrusted(r.collective, r.type, "log");
        renderAutoResolveNetworkError(r.type, r.error, "log");
      });
      assertEscaped(log, [
        r.extension,
        r.version,
        r.newer,
        r.type,
        r.collective,
        r.error,
        r.missing,
        `a${r.description}z`,
      ]);
      const json = await capture(() =>
        renderAutoResolveInstalling(r.extension, r.version, undefined, "json")
      );
      assertEquals(JSON.parse(json), {
        event: "auto_resolve",
        status: "installing",
        extension: r.extension,
        version: r.version,
      });
    }),
    RUNS,
  );
});

const doctorArb = fc.record({
  missingName: text,
  missingState: text,
  expectedPath: text,
  missingFile: text,
  aggName: text,
  aggVersion: text,
  aggOrigin: text,
  sourcePath: text,
  fingerprint: text,
  bundlePath: text,
  lastError: text,
  loaderError: text,
  orphanSourcePath: text,
  orphanExtension: text,
  bundleOrphanPath: text,
  bundleDir: text,
  opPath: text,
  opReason: text,
  orphanFileExt: text,
  orphanFilePath: text,
  collisionType: text,
  collisionName: text,
  winner: text,
  loser: text,
  warningPath: text,
  warningMessage: text,
  rescanReason: text,
  canonicalPath: text,
  transitionReason: text,
});

type DoctorFields = typeof doctorArb extends fc.Arbitrary<infer T> ? T
  : never;

// another swamp version or a hand-edited catalog may skip the validation these types assume
function doctorReportOf(d: DoctorFields): DoctorExtensionsReport {
  const pass = (registry: string) => ({ registry, status: "pass" });
  return {
    overallStatus: "fail",
    registries: {
      model: pass("model"),
      vault: pass("vault"),
      datastore: pass("datastore"),
      report: pass("report"),
      webhook: pass("webhook"),
    },
    orphanFiles: [{ extensionName: d.orphanFileExt, path: d.orphanFilePath }],
    missingExtensions: [{
      name: d.missingName,
      state: d.missingState,
      expectedPath: d.expectedPath,
      missingFiles: [d.missingFile],
      missingFileCount: 1,
      installsOnNextUse: false,
      remedy: "install",
    }],
    aggregateState: {
      aggregates: [{
        name: d.aggName,
        version: d.aggVersion,
        origin: d.aggOrigin,
        sourceCount: 1,
        stateDistribution: {},
      }],
      sourceDetails: [{
        sourcePath: d.sourcePath,
        stateTag: "ValidationFailed",
        fingerprint: d.fingerprint,
        bundlePath: d.bundlePath,
        kind: "model",
        lastError: d.lastError,
      }],
      catalogOrphans: [{
        sourcePath: d.orphanSourcePath,
        extensionName: d.orphanExtension,
        stateTag: "Indexed",
        bundlePath: "",
      }],
      bundleOrphans: [{
        absolutePath: "",
        repoRelativePath: d.bundleOrphanPath,
        bundleDir: d.bundleDir,
      }],
      totalSources: 1,
      healthySources: 0,
      orphanRowCount: 1,
      orphanBundleFileCount: 1,
    },
    repairReport: {
      mode: "dry-run",
      operations: [{
        kind: "catalog-row-pruned",
        path: d.opPath,
        reason: d.opReason,
      }],
      prunedRowCount: 1,
      evictedFileCount: 0,
      repulledExtensionCount: 0,
    },
    rescanSkipped: { reason: d.rescanReason, repairSkipped: false },
    recentTransitions: [{
      source: { canonicalPath: d.canonicalPath } as unknown as SourceLocation,
      fromState: null,
      toState: "Indexed",
      reason: d.transitionReason,
    }],
    loaderErrors: new Map([["model", d.loaderError]]),
    warnings: [{
      sourcePath: d.warningPath,
      category: "Other",
      message: d.warningMessage,
    }],
    memberCollisions: [{
      type: d.collisionType,
      memberKind: "method",
      name: d.collisionName,
      winner: d.winner,
      losers: [d.loser],
    }],
  } as unknown as DoctorExtensionsReport;
}

Deno.test("createDoctorExtensionsRenderer: no extension-supplied control character reaches the terminal, and every printed value is still there escaped", async () => {
  await fc.assert(
    fc.asyncProperty(doctorArb, async (d) => {
      const log = await capture(() =>
        createDoctorExtensionsRenderer("log", { verbose: true }).handlers()
          .completed({ kind: "completed", report: doctorReportOf(d) })
      );
      assertEscaped(
        log,
        [
          d.missingName,
          d.missingState,
          d.expectedPath,
          d.missingFile,
          d.aggName,
          d.aggVersion,
          d.aggOrigin,
          d.sourcePath,
          d.fingerprint.slice(0, 12),
          d.bundlePath,
          d.orphanSourcePath,
          d.orphanExtension,
          d.bundleOrphanPath,
          d.bundleDir,
          d.opPath,
          d.opReason,
          d.orphanFileExt,
          d.orphanFilePath,
          d.collisionType,
          d.collisionName,
          d.winner,
          d.loser,
          d.warningPath,
          d.warningMessage,
          d.rescanReason,
          d.canonicalPath,
          d.transitionReason,
        ],
        [d.lastError, d.loaderError],
      );
    }),
    RUNS,
  );
});

const modelArb = fc.record({
  name: text,
  type: text,
  description: text,
  id: text,
  tagKey: text,
  tagValue: text,
  argKey: text,
  argValue: text,
  typeVersion: text,
  currentTypeVersion: text,
  property: text,
  propertyType: text,
  enumValue: text,
  methodName: text,
  methodDescription: text,
  configuredMethod: text,
});

type ModelFields = typeof modelArb extends fc.Arbitrary<infer T> ? T : never;

function modelOf(m: ModelFields): ModelGetData {
  const schema = {
    type: "object",
    properties: {
      [m.property]: { type: m.propertyType, enum: [m.enumValue] },
    },
  };
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    type: m.type,
    version: 1,
    tags: { [m.tagKey]: m.tagValue },
    globalArguments: { [m.argKey]: m.argValue },
    typeVersion: m.typeVersion,
    currentTypeVersion: `${m.currentTypeVersion}!`,
    globalArgumentsSchema: schema,
    methods: [{
      name: m.methodName,
      description: m.methodDescription,
      arguments: schema,
      kindSource: "declared",
    }],
    configuredMethods: {
      [m.configuredMethod]: { arguments: { [m.argKey]: m.argValue } },
    },
  } as ModelGetData;
}

Deno.test("renderModelGet: no extension-supplied control character reaches the terminal, and JSON output is the input exactly", async () => {
  await fc.assert(
    fc.asyncProperty(modelArb, async (m) => {
      const data = modelOf(m);
      const log = await capture(() => renderModelGet(data, "log"));
      assertEscaped(
        log,
        [
          m.name,
          m.type,
          m.id,
          m.tagKey,
          m.tagValue,
          m.argKey,
          m.argValue,
          m.typeVersion,
          `${m.currentTypeVersion}!`,
          m.property,
          m.propertyType,
          m.enumValue,
          m.methodName,
          m.configuredMethod,
        ],
        [m.description, m.methodDescription],
      );
      const json = await capture(() => renderModelGet(data, "json"));
      assertEquals(JSON.parse(json), JSON.parse(JSON.stringify(data)));
    }),
    RUNS,
  );
});

const typeArb = fc.record({
  type: text,
  name: text,
  scope: text,
  description: text,
});

Deno.test("datastore, vault and report type search: the plain list escapes every extension-supplied field, and JSON output is the input exactly", async () => {
  await fc.assert(
    fc.asyncProperty(typeArb, async (t) => {
      const item = { type: t.type, name: t.name, description: t.description };
      assertEscaped(
        renderDatastoreTypeScrollback(item, undefined),
        [t.type, t.name],
        [t.description],
      );
      const vault = await capture(() =>
        createVaultTypeSearchRenderer("log", { interactive: false })
          .handlers().completed({
            kind: "completed",
            data: { query: "", results: [item] },
          })
      );
      assertEscaped(vault, [t.type, t.name], [t.description]);
      const reportItem = { ...item, scope: t.scope };
      const report = await capture(() =>
        createReportTypeSearchRenderer("log", { interactive: false })
          .handlers().completed({
            kind: "completed",
            data: { query: "", results: [reportItem] },
          })
      );
      assertEscaped(report, [t.type, t.scope], [t.description]);
      const json = await capture(() =>
        createVaultTypeSearchRenderer("json").handlers().completed({
          kind: "completed",
          data: { query: "", results: [item] },
        })
      );
      assertEquals(JSON.parse(json), { query: "", results: [item] });
    }),
    RUNS,
  );
});

const pullArb = fc.record({
  name: text,
  version: text,
  channel: text,
  parent: text,
});

Deno.test("createExtensionPullRenderer: replacement and pre-release lines escape registry versions and parents", async () => {
  await fc.assert(
    fc.asyncProperty(pullArb, async (p) => {
      const renderer = createExtensionPullRenderer("log");
      const log = await capture(() => {
        renderer.renderReplacement(ExtensionReplacement.create({
          name: p.name,
          current: null,
          incoming: {
            version: p.version,
            channel: null,
            publishedChannel: null,
          },
        }));
        renderer.renderUnoptedPrerelease({
          name: p.name,
          version: p.version,
          publishedChannel: p.channel,
          parent: p.parent,
        });
      });
      assertEscaped(log, [p.name, p.version, p.channel, p.parent]);
    }),
    RUNS,
  );
});

Deno.test("createExtensionPushRenderer: a registry check message prints escaped", async () => {
  await fc.assert(
    fc.asyncProperty(text, async (message) => {
      const log = await capture(() =>
        createExtensionPushRenderer("log").renderDryRun({
          name: "@test/ext",
          version: "2026.09.16.1",
          archiveSize: 100,
          visibility: "public",
          contentHash: undefined,
          registryChecks: [
            { name: "authentication", status: "failed", message },
            { name: "collective-membership", status: "not-run", message },
            { name: "version-exists", status: "passed", message },
          ],
          apiCalls: [],
        })
      );
      assertEscaped(log, [], [message]);
    }),
    RUNS,
  );
});

Deno.test("dispatchRepositoryReport: the handoff text escapes the manifest's repository and version", async () => {
  await fc.assert(
    fc.asyncProperty(text, text, async (repositoryUrl, version) => {
      const logs: string[] = [];
      await dispatchRepositoryReport(
        {
          kind: "repository",
          extensionName: "@adam/cfgmgmt",
          extensionVersion: version,
          repositoryUrl,
          parsed: parseRepositoryUrl("https://bitbucket.org/group/proj"),
        },
        {
          type: "bug",
          title: "T",
          body: "B",
          reporterContext: {
            extensionName: "@adam/cfgmgmt",
            extensionVersion: version,
            swampVersion: "20260422.000000.0-sha.abc",
            os: "darwin",
            arch: "aarch64",
            shell: "/bin/zsh",
            denoVersion: "1.45.0",
          },
          outputMode: "log",
        },
        {
          env: { get: () => undefined },
          ghRunner: {
            run: () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "" }),
          },
          openBrowser: () => Promise.resolve(),
          writeLog: (line) => logs.push(line),
        },
      );
      assertEscaped(logs.join("\n"), [], [repositoryUrl, version]);
    }),
    RUNS,
  );
});
