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
 * Fitness test for spread arguments:
 *
 *   No array of unbounded size is spread into the arguments of
 *   `Math.max`, `Math.min`, `String.fromCharCode`, `.push`, `.unshift` or
 *   `.splice`.
 *
 * Spreading an array into a call puts every element on the stack as an
 * argument. V8 throws `RangeError: Maximum call stack size exceeded` once
 * that passes roughly 125k elements, so any array that grows with runtime
 * data (data versions, run outputs, log lines, query rows, forEach steps)
 * eventually breaks the command using it. swamp-club#2565 was every write to
 * a resource failing past ~129k versions because of `Math.max(...versions)`.
 *
 * Use `maxOf` / `minOf` from `src/domain/array_extrema.ts`, or a `for…of`
 * loop that pushes one element at a time. A spread over an array that is
 * bounded by construction may stay, pinned below with the reason it is
 * bounded. Spreads inside array or object literals (`[...a]`, `{...o}`) are
 * not calls and are not matched.
 *
 * Static — no subprocesses, nothing is executed.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  ROOT,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

/** Calls with an argument ceiling, as `Math.max(`, `.push(` etc. */
const CALL_START =
  /(?:\bMath\.(?:max|min)|\bString\.fromCharCode|\.(?:push|unshift|splice))(\.apply)?\s*\(/g;

/** Longest call text kept in a pin key. */
const MAX_KEY_LENGTH = 100;

/**
 * Returns the text of each call in `source` that spreads an argument into
 * one of the functions in {@link CALL_START}, or passes an array to one of
 * them through `.apply`. Whitespace is collapsed so a multi-line call reads
 * as one line, and long calls are cut at {@link MAX_KEY_LENGTH}. Comment
 * lines are ignored.
 */
function findSpreadCalls(source: string): string[] {
  const code = source
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith("//") || trimmed.startsWith("*") ||
          trimmed.startsWith("/*")
        ? ""
        : line;
    })
    .join("\n");

  const hits: string[] = [];
  for (const match of code.matchAll(CALL_START)) {
    const openParen = match.index + match[0].length - 1;
    const { spreads, end } = scanArguments(code, openParen);
    if (match[1] === undefined && !spreads) continue;
    // Include the receiver, so `.push(` reads as `out.push(`.
    let start = match.index;
    while (start > 0 && /[\w$#.]/.test(code[start - 1])) start--;
    const text = code.slice(start, end).replace(/\s+/g, " ")
      .replace(/\( /g, "(").replace(/,? \)/g, ")");
    hits.push(
      text.length > MAX_KEY_LENGTH ? `${text.slice(0, MAX_KEY_LENGTH)}…` : text,
    );
  }
  return hits;
}

/**
 * Scans the argument list whose `(` is at `openParen`. `spreads` is whether
 * `...` appears directly in it — not nested in an inner call, array, object
 * or string — and `end` is the index just past its closing `)`.
 */
function scanArguments(
  code: string,
  openParen: number,
): { spreads: boolean; end: number } {
  let depth = 0;
  let spreads = false;
  for (let i = openParen; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(code, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return { spreads, end: i + 1 };
    } else if (depth === 1 && code.startsWith("...", i)) spreads = true;
  }
  return { spreads, end: code.length };
}

/** Index of the quote closing the string literal that opens at `start`. */
function skipString(code: string, start: number): number {
  const quote = code[start];
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === "\\") i++;
    else if (code[i] === quote) return i;
  }
  return code.length;
}

Deno.test("findSpreadCalls: matches a spread in any argument position", () => {
  assertEquals(findSpreadCalls("const m = Math.max(...versions);"), [
    "Math.max(...versions)",
  ]);
  assertEquals(findSpreadCalls("const w = Math.max(14, ...widths) + 2;"), [
    "Math.max(14, ...widths)",
  ]);
  assertEquals(findSpreadCalls("this.#out.splice(i, 1, ...insertions);"), [
    "this.#out.splice(i, 1, ...insertions)",
  ]);
});

Deno.test("findSpreadCalls: collapses a multi-line call to one line", () => {
  const source = [
    "    files.push(",
    "      ...await listFiles(dir),",
    "    );",
  ].join("\n");
  assertEquals(findSpreadCalls(source), [
    "files.push(...await listFiles(dir))",
  ]);
});

Deno.test("findSpreadCalls: matches the apply form", () => {
  assertEquals(findSpreadCalls("Math.min.apply(null, values);"), [
    "Math.min.apply(null, values)",
  ]);
  assertEquals(findSpreadCalls("out.push.apply(out, items);"), [
    "out.push.apply(out, items)",
  ]);
});

Deno.test("findSpreadCalls: cuts long calls to a fixed length", () => {
  const [hit] = findSpreadCalls(`out.push(...${"x".repeat(200)});`);
  assertEquals(hit.length, 101);
  assertEquals(hit.endsWith("…"), true);
});

Deno.test("findSpreadCalls: ignores spreads that are not arguments", () => {
  assertEquals(findSpreadCalls("out.push([...a, ...b]);"), []);
  assertEquals(findSpreadCalls("out.push({ ...base, x: 1 });"), []);
  assertEquals(findSpreadCalls("out.push(merge(...parts));"), []);
  assertEquals(findSpreadCalls('out.push("wait...");'), []);
  assertEquals(findSpreadCalls("out.push(`${a}...`);"), []);
  assertEquals(findSpreadCalls("const all = [...a, ...b];"), []);
  assertEquals(findSpreadCalls("const m = Math.max(a, b);"), []);
});

Deno.test("findSpreadCalls: ignores comment lines", () => {
  assertEquals(
    findSpreadCalls(
      [
        "// Math.max(...versions) overflowed",
        " * The naive `btoa(String.fromCharCode(...bytes))` spreads",
      ].join("\n"),
    ),
    [],
  );
});

/**
 * Spread calls whose array is bounded by construction, grouped by file with
 * the reason they are bounded. Each call is its text as
 * {@link findSpreadCalls} renders it.
 */
const PINNED: ReadonlyArray<
  { file: string; reason: string; calls: readonly string[] }
> = [
  {
    file: "packages/dashboard/src/views/Overview.tsx",
    reason: "one value per chart bucket",
    calls: [
      "Math.max(...data.map((d) => Object.values(d).reduce((a, b) => a + b, 0)), 1)",
    ],
  },
  {
    file: "src/cli/commands/serve.ts",
    reason: "workflow runs still active at shutdown",
    calls: [
      "Math.min(...workflowRuns.map((r) => r.startedAt.getTime()))",
    ],
  },
  {
    file: "src/cli/commands/serve.ts",
    reason: "admins and allowed users in the serve config",
    calls: [
      "authConfig.admins.splice(0, authConfig.admins.length, ...resolution.admins)",
      "authConfig.allowedUsers.splice(0, authConfig.allowedUsers.length, ...resolution.allowedUsers)",
    ],
  },
  {
    file: "src/cli/resolve_extension_files.ts",
    reason: "files, entry points or warnings of one extension package",
    calls: [
      "allDatastoreFiles.push(...datastoreImportResult.resolvedFiles)",
      "allReportFiles.push(...reportImportResult.resolvedFiles)",
      "allVaultFiles.push(...vaultImportResult.resolvedFiles)",
      "allWebhookFiles.push(...webhookImportResult.resolvedFiles)",
    ],
  },
  {
    file: "src/domain/access/grant_file.ts",
    reason: "validation results or errors for one document",
    calls: [
      "allErrors.push(...result.errors)",
    ],
  },
  {
    file: "src/domain/access/grant_file_reconciler.ts",
    reason: "writes for the grants in one grant file",
    calls: [
      "allWrites.push(...writes)",
    ],
  },
  {
    file: "src/domain/access/policy_snapshot.ts",
    reason: "grants held by one subject",
    calls: [
      "result.push(...grants)",
    ],
  },
  {
    file: "src/domain/auth/verification_proof.ts",
    reason: "fixed-length signature bytes",
    calls: [
      "String.fromCharCode(...bytes)",
    ],
  },
  {
    file: "src/domain/extensions/extension_dependency_trust_checker.ts",
    reason: "trust findings for one dependency",
    calls: [
      "allErrors.push(...errors)",
      "allWarnings.push(...warnings)",
    ],
  },
  {
    file: "src/domain/extensions/extension_loader.ts",
    reason: "files, entry points or warnings of one extension package",
    calls: [
      "files.push(...nested)",
      "files.push(...this.discoverFilesSync(join(dir, entry.name), relativePath, includeTestFiles))",
    ],
  },
  {
    file: "src/domain/extensions/extension_skill_validator.ts",
    reason: "files in one skill directory, capped at 2MB",
    calls: [
      "files.push(...await collectFiles(fullPath))",
    ],
  },
  {
    file: "src/domain/models/bundle.ts",
    reason: "fixed-size chunk",
    calls: [
      "String.fromCharCode(...chunk)",
    ],
  },
  {
    file: "src/domain/models/method_execution_service.ts",
    reason: "secrets resolved for one method call",
    calls: [
      "secretValues.push(...extractSensitiveFieldValues(methodArgSchema, methodArgs))",
      "secretValues.push(...extractSensitiveFieldValues(modelDef.globalArguments, globalArgs))",
      "secretValues.push(...secretBag.rawValues)",
    ],
  },
  {
    file: "src/domain/models/validation_service.ts",
    reason: "validation results or errors for one document",
    calls: [
      "errors.push(...modelErrors.filter((e): e is ExpressionPathError => e !== null))",
      "errors.push(...selfErrors)",
      "results.push(...checkResults)",
    ],
  },
  {
    file: "src/domain/models/zod_field_metadata.ts",
    reason: "fields of one schema",
    calls: [
      "results.push(...extractFieldsWithMetadata(unwrappedField, matches, fieldPath))",
    ],
  },
  {
    file: "src/domain/repo/repo_service.ts",
    reason: "scaffolding files for one AI tool",
    calls: [
      "changedFiles.push(...r.changedFiles)",
    ],
  },
  {
    file: "src/domain/workflows/model_reference_extractor.ts",
    reason: "model references in one workflow definition",
    calls: [
      "references.push(...nestedRefs)",
    ],
  },
  {
    file: "src/domain/workflows/validation_service.ts",
    reason: "validation results or errors for one document",
    calls: [
      "results.push(...await this.validateGlobalArgInputRefs(workflow))",
      "results.push(...await this.validateModelMethodInputs(job.name, step.name, modelRef, taskData.methodN…",
      "results.push(...await this.validateStepInputs(workflow))",
      "results.push(...await this.validateWorkflowTaskInputs(job.name, step.name, taskData.workflowIdOrName…",
      "results.push(...this.validateAffinityPlacement(workflow))",
      "results.push(...this.validateAssertExprNotInterpolated(workflow))",
      "results.push(...this.validateGuardExpressionTypes(workflow))",
      "results.push(...this.validateNoStepCycles(workflow))",
      "results.push(...this.validateQueueTimeoutPlacement(workflow))",
      "results.push(...this.validateStepDependencyRefs(workflow))",
      "results.push(...this.validateUniqueStepNames(workflow))",
      "results.push(...this.validateWritesPlacement(workflow))",
    ],
  },
  {
    file: "src/infrastructure/editor/editor_service.ts",
    reason: "words of the $EDITOR setting",
    calls: [
      "args.push(...editorParts)",
    ],
  },
  {
    file: "src/libswamp/extensions/install_extension_service.ts",
    reason: "files, entry points or warnings of one extension package",
    calls: [
      "out.push(...await collectTsFiles(path))",
      "out.push(...flattenInstallResults(dep))",
    ],
  },
  {
    file: "src/libswamp/extensions/pull.ts",
    reason: "files, entry points or warnings of one extension package",
    calls: [
      "conflicts.push(...skillConflicts)",
      "entryPoints.push(...subEntries)",
      "extracted.push(...sub)",
      "extractedFiles.push(...recorded)",
      "files.push(...await collectTsFiles(join(dir, entry.name)))",
      "files.push(...await listFiles(path))",
      'lines.push("The following files already exist and would be overwritten:", ...files.map((c) => ` ${c}…',
      'lines.push("The following skill directories already exist; the extension\'s " + "files would be writt…',
      "out.push(...await listFilesAndLinks(path))",
      "safetyWarnings.push(...safetyResult.warnings)",
      "skillCreatedPaths.push(...(preExisted ? extracted.filter((f) => !filesBefore.has(f)) : [skillDirRela…",
      "skillFiles.push(...extracted)",
      "skillRecordedPaths.push(...recorded)",
    ],
  },
  {
    file: "src/libswamp/extensions/reconcile_from_disk_service.ts",
    reason: "files, entry points or warnings of one extension package",
    calls: [
      "out.push(...await collectTsFiles(path))",
      "result.push(...localExts)",
      "result.push(...pulledExts)",
    ],
  },
  {
    file: "src/libswamp/sources/add.ts",
    reason: "skill files copied from one source",
    calls: [
      "allCopied.push(...copied)",
      "allInstalledSkills.push(...copied)",
    ],
  },
  {
    file: "src/libswamp/workflows/validate.ts",
    reason: "required keys of one schema",
    calls: [
      "globalRequired.push(...(globalSchema.required ?? []))",
    ],
  },
  {
    file: "src/presentation/output/access_token_output.ts",
    reason: "tokens of one account",
    calls: [
      "Math.max(header.length, ...rows.map((row) => row[i].length))",
    ],
  },
  {
    file: "src/presentation/output/auth_token_output.ts",
    reason: "tokens of one account",
    calls: [
      "Math.max(header.length, ...rows.map((row) => row[i].length))",
    ],
  },
  {
    file: "src/presentation/output/console_writer.ts",
    reason: "names or attribute keys of one run or record",
    calls: [
      "Math.max(...displayKeys.map((k) => k.length), 1)",
      "Math.max(...keys.map((k) => k.length), 1)",
      "Math.max(...names.map((n) => n.length), 1)",
      'dataEntries.push(...formatAttributeEntries(key, val, maxKeyLen, " "))',
    ],
  },
  {
    file: "src/presentation/output/serve_check_config_output.ts",
    reason: "admins and allowed users in the serve config",
    calls: [
      "lines.push(...entryLines(admins, provider))",
      "lines.push(...entryLines(allowedUsers, provider))",
    ],
  },
  {
    file: "src/presentation/output/worker_output.ts",
    reason: "tokens, workers or queued steps in one table",
    calls: [
      "Math.max(header.length, ...rows.map((row) => row[i].length))",
    ],
  },
  {
    file: "src/presentation/renderers/access_can_i.ts",
    reason: "one decision per resource asked about",
    calls: [
      "Math.max(...result.decisions.map((d) => d.resource.length))",
    ],
  },
  {
    file: "src/presentation/renderers/auth_login.ts",
    reason: "fixed set of login summary rows",
    calls: [
      "Math.max(...allRows.map((r) => r.label.length))",
      "Math.max(...allRows.map((r) => stripAnsi(r.value).length))",
    ],
  },
  {
    file: "src/presentation/renderers/auth_whoami.ts",
    reason: "collectives of one account",
    calls: [
      'Math.max(...entitlements.map((c) => (c.planName ?? c.plan ?? "").length))',
      "Math.max(...entitlements.map((c) => c.slug.length))",
    ],
  },
  {
    file: "src/presentation/renderers/data_query_tui/autocomplete_dropdown.tsx",
    reason: "items visible in the dropdown",
    calls: [
      "Math.max(...visibleItems.map((i) => i.label.length))",
    ],
  },
  {
    file: "src/presentation/renderers/extension_list.ts",
    reason: "installed extensions",
    calls: [
      "Math.max(...exts.map((ext) => ext.latestVersion ? ext.latestVersion.length + 1 : 1))",
      "Math.max(...exts.map((ext) => ext.name.length))",
      'Math.max(...exts.map((ext) => { const tag = ext.channel && ext.channel !== "stable" ? ` [${ext.chann…',
    ],
  },
  {
    file: "src/presentation/renderers/extension_outdated.ts",
    reason: "installed extensions",
    calls: [
      "Math.max(...exts.map((x) => x.name.length))",
    ],
  },
  {
    file: "src/presentation/renderers/extension_update.ts",
    reason: "installed extensions",
    calls: [
      "Math.max(...result.extensions.map((e) => e.name.length))",
    ],
  },
  {
    file: "src/presentation/renderers/model_create.ts",
    reason: "attributes, methods or arguments of one model type",
    calls: [
      "lines.push(...formatMethodLines(data.methods))",
      "lines.push(...schemaAttrs)",
    ],
  },
  {
    file: "src/presentation/renderers/model_get.ts",
    reason: "attributes, methods or arguments of one model type",
    calls: [
      "lines.push(...formatMethodLines(data.methods))",
      'lines.push(...formatRecord(data.globalArguments, " "))',
      'lines.push(...formatRecord(data.tags, " "))',
      'lines.push(...formatRecord(method.arguments, " "))',
      "lines.push(...methodAttrs)",
      "lines.push(...schemaAttrs)",
    ],
  },
  {
    file: "src/presentation/renderers/model_method_describe.ts",
    reason: "attributes, methods or arguments of one model type",
    calls: [
      "lines.push(...argAttrs)",
    ],
  },
  {
    file: "src/presentation/renderers/model_search.tsx",
    reason: "attributes, methods or arguments of one model type",
    calls: [
      "lines.push(...formatMethodLines(detail.methods))",
      "lines.push(...schemaAttrs)",
    ],
  },
  {
    file: "src/presentation/renderers/model_validate.ts",
    reason: "validation results or errors for one document",
    calls: [
      "lines.push(...formatValidationLines(data.validations))",
      "lines.push(...formatValidationLines(model.validations))",
      "lines.push(...formatWarningLines(data.warnings))",
      "lines.push(...formatWarningLines(model.warnings))",
    ],
  },
  {
    file: "src/presentation/renderers/quest_pass.ts",
    reason: "quests on one pass",
    calls: [
      "Math.max(...rows.map((r) => vlen(xpTag(r.xp))))",
      "Math.max(14, ...rows.map((r) => vlen(r.name)))",
    ],
  },
  {
    file: "src/presentation/renderers/summarise.ts",
    reason: "methods of one model or workflows in one repo summary",
    calls: [
      "Math.max(...groups.map((g) => g.workflowName.length))",
      "Math.max(...model.methods.map((m) => m.method.length))",
    ],
  },
  {
    file: "src/presentation/renderers/type_describe.ts",
    reason: "attributes, methods or arguments of one model type",
    calls: [
      "lines.push(...attrs)",
      "lines.push(...formatDataOutputSpecs(data.dataOutputSpecs))",
      "lines.push(...formatMethodLines(data.methods))",
    ],
  },
  {
    file: "src/presentation/renderers/type_search.tsx",
    reason: "attributes, methods or arguments of one model type",
    calls: [
      "lines.push(...formatMethodLines(detail.methods))",
    ],
  },
  {
    file: "src/presentation/renderers/workflow_validate.ts",
    reason: "validation results or errors for one document",
    calls: [
      "lines.push(...formatValidationLines(data.validations))",
      "lines.push(...formatValidationLines(workflow.validations))",
    ],
  },
  {
    file: "src/serve/handlers/access_handlers.ts",
    reason: "validation results or errors for one document",
    calls: [
      'allErrors.push(...externalResult.errors.map((e) => ({ ...e, filename: "external-grants-file", })))',
      "allErrors.push(...result.errors)",
    ],
  },
];

Deno.test("no unbounded array is spread into a call's arguments", async () => {
  const sites = new Set<string>();
  for (const dir of [SRC_DIR, join(ROOT, "packages")]) {
    for await (const path of productionSourceFiles(dir)) {
      const source = await Deno.readTextFile(path);
      for (const line of findSpreadCalls(source)) {
        sites.add(`${repoRelative(path)}: ${line}`);
      }
    }
  }

  assertPinnedSet(
    [...sites].sort(),
    PINNED.flatMap((p) => p.calls.map((call) => `${p.file}: ${call}`)),
    "Spread arguments to Math.max/Math.min/String.fromCharCode/push/unshift/splice",
    "Spreading an array into a call throws RangeError past ~125k elements " +
      "(swamp-club#2565). Use maxOf/minOf from src/domain/array_extrema.ts " +
      "or a for…of loop. Pin the site here only if the array is bounded by " +
      "construction, and give the reason.",
  );
});
