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

// Architectural fitness test for position and value provenance
// (swamp-club#3205, design/enablers/expressions.md "Position and Value
// Provenance").
//
// 1. A pass over substituted data decides what to evaluate with
//    `partitionAuthoredAt`, which also refuses expression text sitting in
//    data. Calling the raw-text `partitionAuthored` directly would re-admit
//    data that byte-matches an authored expression, so only its own module
//    may call it.
// 2. Every evaluated-cache writer states where data sits in what it saves.
//    `undefined` writes the legacy format and an empty map claims the whole
//    tree is authored; either one at a production save site would make replay
//    trust data. The scan is textual; the pin-lists prove it still matches.

import { assertGreater } from "@std/assert";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const RAW_TEXT_GATE = /\bpartitionAuthored\(/g;

/** Production files allowed to call the raw-text gate directly. */
const PINNED_RAW_TEXT_GATE_CALLERS: readonly string[] = [
  // The definition and its one caller, partitionAuthoredAt.
  "src/domain/expressions/expression_evaluation_service.ts",
];

/**
 * Evaluated-cache save calls and the index of their provenance argument.
 * Repository saves take it after the type (definitions) or first (workflows);
 * the libswamp dependency closures mirror them.
 */
const SAVE_CALLS: readonly { pattern: RegExp; index: number }[] = [
  { pattern: /\bevaluatedDefinitionRepo\.save\(/g, index: 2 },
  { pattern: /\bevaluatedDefRepo\.save\(/g, index: 2 },
  { pattern: /\bdeps\.saveEvaluatedDefinition\(/g, index: 2 },
  { pattern: /\bevaluatedWorkflowRepo\.save\(/g, index: 1 },
  { pattern: /\bdeps\.saveEvaluatedWorkflow\(/g, index: 1 },
];

/** Provenance arguments that claim nothing is data, or skip the record. */
const UNSAFE_PROVENANCE = /^(undefined|ProvenanceMap\.authored\(\))$/;

/**
 * Save sites allowed an empty map: a workflow with no expressions and no
 * inputs has nothing that could be data.
 */
const PINNED_AUTHORED_SAVES: readonly string[] = [
  "src/libswamp/workflows/evaluate.ts: ProvenanceMap.authored()",
];

/** The top-level arguments of the call whose `(` ends at `open`. */
function callArguments(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i++; i < source.length && source[i] !== quote; i++) {
        if (source[i] === "\\") i++;
      }
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) {
        args.push(source.slice(start, i).trim());
        return args.filter((a) => a !== "");
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

Deno.test("expression provenance rules: only partitionAuthoredAt calls the raw-text gate", async () => {
  const callers = new Set<string>();
  for await (const file of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(file);
    if (RAW_TEXT_GATE.test(source)) callers.add(repoRelative(file));
    RAW_TEXT_GATE.lastIndex = 0;
  }
  assertPinnedSet(
    [...callers].sort(),
    PINNED_RAW_TEXT_GATE_CALLERS,
    "Direct callers of partitionAuthored",
    "Use partitionAuthoredAt with the provenance of the data being evaluated, so expression text that arrived as data is refused even when it byte-matches an authored expression.",
  );
});

Deno.test("expression provenance rules: evaluated-cache writers record where data sits", async () => {
  let saveSites = 0;
  const unsafe: string[] = [];
  for await (const file of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(file);
    for (const { pattern, index } of SAVE_CALLS) {
      for (const match of source.matchAll(pattern)) {
        saveSites++;
        const args = callArguments(
          source,
          match.index! + match[0].length,
        );
        const provenance = args[index] ?? "undefined";
        if (UNSAFE_PROVENANCE.test(provenance)) {
          unsafe.push(`${repoRelative(file)}: ${provenance}`);
        }
      }
    }
  }
  // Proves the patterns still match the save calls they guard.
  assertGreater(saveSites, 5);
  assertPinnedSet(
    unsafe.sort(),
    PINNED_AUTHORED_SAVES,
    "Evaluated-cache saves without provenance",
    "Pass the map of the raw copy being saved (EvaluatedDefinition.provenance, WorkflowEvaluationResult.provenance), so --last-evaluated replay refuses the same data a fresh run does.",
  );
});

/**
 * Runtime passes over a definition that may hold spliced data. Each must
 * pass the definition's provenance. The deprecated legacy seam was removed
 * in typed-secrets 4.5, so no production caller may leave it out.
 */
const PINNED_RUNTIME_PASSES_WITHOUT_PROVENANCE: readonly string[] = [];

Deno.test("expression provenance rules: every runtime pass over a definition passes its provenance", async () => {
  let sites = 0;
  const without = new Set<string>();
  for await (const file of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(file);
    for (
      const match of source.matchAll(
        /\.resolveRuntimeExpressionsInDefinition\(/g,
      )
    ) {
      sites++;
      const args = callArguments(source, match.index! + match[0].length);
      if (!/\bprovenance\b/.test(args[4] ?? "")) {
        without.add(repoRelative(file));
      }
    }
  }
  // Proves the pattern still matches the runtime passes it guards.
  assertGreater(sites, 3);
  assertPinnedSet(
    [...without].sort(),
    PINNED_RUNTIME_PASSES_WITHOUT_PROVENANCE,
    "Runtime passes without provenance",
    "Pass the executed copy's map (EvaluatedDefinition.sanitizedProvenance) so data the definition pass spliced is never resolved by the runtime pass.",
  );
});
