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

import { assertEquals, assertGreater } from "@std/assert";
import { walk } from "@std/fs/walk";
import { join, relative, SEPARATOR } from "@std/path";
import { UNGATED_PUSH_HANDLERS } from "../src/serve/sync_gate.ts";

const ROOT = join(import.meta.dirname!, "..");
const SERVE_HANDLERS_DIR = join(ROOT, "src", "serve", "handlers");

function normalise(p: string): string {
  return SEPARATOR === "\\" ? p.replaceAll("\\", "/") : p;
}

Deno.test("serve handlers must not construct fresh definition or workflow repos", async () => {
  const violations: string[] = [];

  for await (
    const entry of walk(SERVE_HANDLERS_DIR, {
      exts: [".ts"],
      skip: [/_test\.ts$/],
    })
  ) {
    const content = await Deno.readTextFile(entry.path);
    const rel = normalise(relative(ROOT, entry.path));

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        line.includes("new YamlDefinitionRepository(") ||
        line.includes("new YamlWorkflowRepository(")
      ) {
        // Auto-definition repos scoped to autoDefinitionsDir are
        // write-only repos for direct-type-execution and file grants —
        // they don't do general definition lookups, so the path
        // divergence doesn't apply.
        if (line.includes("autoDefRepo")) continue;
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
  }

  assertEquals(
    violations,
    [],
    "Serve handlers must use ctx.repoContext repos (pre-warmed at boot) " +
      "instead of constructing fresh YamlDefinitionRepository or " +
      "YamlWorkflowRepository instances. Fresh repos miss the " +
      "datastore-resolved paths under managedConfig + namespace. " +
      "Pass the pre-warmed repo via the injectedDefinitionRepo / " +
      "injectedWorkflowRepo parameter on the libswamp create*Deps " +
      "function instead.\n\nViolations:\n" +
      violations.join("\n"),
  );
});

const DATA_DEPS_PATTERN =
  /create(?:DataGet|DataList|DataVersions|DataDelete|DataRename|DataPrune)Deps\(/;

Deno.test("serve handlers must pass injected definition repo to createData*Deps", async () => {
  const violations: string[] = [];

  for await (
    const entry of walk(SERVE_HANDLERS_DIR, {
      exts: [".ts"],
      skip: [/_test\.ts$/],
    })
  ) {
    const content = await Deno.readTextFile(entry.path);
    const rel = normalise(relative(ROOT, entry.path));

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (DATA_DEPS_PATTERN.test(line)) {
        const callStart = i;
        let callBlock = "";
        for (let j = i; j < lines.length && j < i + 10; j++) {
          callBlock += lines[j];
          if (lines[j].includes(");")) break;
        }
        if (!callBlock.includes("definitionRepo")) {
          violations.push(`${rel}:${callStart + 1}: ${line.trim()}`);
        }
      }
    }
  }

  assertEquals(
    violations,
    [],
    "Serve handlers calling createData*Deps must pass " +
      "ctx.repoContext.definitionRepo as the injectedDefinitionRepo " +
      "parameter. Without it, the function constructs a fresh " +
      "YamlDefinitionRepository that misses managed-config definitions " +
      "(swamp-club#2109).\n\nViolations:\n" +
      violations.join("\n"),
  );
});

const SERVE_DIR = join(ROOT, "src", "serve");

/**
 * Returns the `[start, end)` span of every `<callee>(...)` call in `source`,
 * from the callee name to its matching close paren.
 */
function callSpans(source: string, callee: string): [number, number][] {
  const spans: [number, number][] = [];
  const pattern = new RegExp(`\\b${callee}\\(`, "g");
  for (const match of source.matchAll(pattern)) {
    const start = match.index!;
    let depth = 0;
    let i = start + callee.length;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    spans.push([start, i + 1]);
  }
  return spans;
}

/** Collects identifiers named inside every `withSyncGate(...)` call. */
function gatedIdentifiers(source: string): Set<string> {
  const names = new Set<string>();
  for (const [start, end] of callSpans(source, "withSyncGate")) {
    for (
      const match of source.slice(start, end).matchAll(/[A-Za-z_$][\w$]*/g)
    ) {
      names.add(match[0]);
    }
  }
  return names;
}

/** A raw push: one that commits to the datastore directly. */
const RAW_PUSH = /pushChangedToRemote\(ctx\)|syncService[?.]*\.pushChanged\(/g;

interface ServeFunction {
  name: string;
  file: string;
  body: string;
}

/**
 * Every top-level function in `src/serve` (except the gate itself), split on
 * declarations so a call is attributed to the function whose body holds it,
 * plus the set of identifiers gated exclusively at a dispatch site.
 */
async function collectServeFunctions(): Promise<{
  functions: ServeFunction[];
  dispatchGated: Set<string>;
}> {
  const functions: ServeFunction[] = [];
  const dispatchGated = new Set<string>();
  for await (
    const entry of walk(SERVE_DIR, { exts: [".ts"], skip: [/_test\.ts$/] })
  ) {
    const content = await Deno.readTextFile(entry.path);
    const rel = normalise(relative(ROOT, entry.path));
    if (rel.endsWith("src/serve/sync_gate.ts")) continue;

    for (const name of gatedIdentifiers(content)) dispatchGated.add(name);

    const declarations = [
      ...content.matchAll(/^(?:export )?(?:async )?function (\w+)/gm),
    ];
    for (let i = 0; i < declarations.length; i++) {
      const start = declarations[i].index!;
      const end = i + 1 < declarations.length
        ? declarations[i + 1].index!
        : content.length;
      functions.push({
        name: declarations[i][1],
        file: rel,
        body: content.slice(start, end),
      });
    }
  }
  return { functions, dispatchGated };
}

Deno.test("serve functions that push must run under the sync gate", async () => {
  const { functions, dispatchGated } = await collectServeFunctions();
  const violations: string[] = [];
  let pushers = 0;

  for (const { name, file, body } of functions) {
    const pushes = [...body.matchAll(RAW_PUSH)].map((m) => m.index!);
    const lockCalls = callSpans(body, "acquireModelLocks");
    if (pushes.length === 0 && lockCalls.length === 0) continue;
    pushers++;

    // Gated for the whole handler at its dispatch site, or a deliberate,
    // documented exemption.
    if (dispatchGated.has(name) || UNGATED_PUSH_HANDLERS.has(name)) continue;

    // Otherwise this is a run path: every push must sit inside a shared-gate
    // span, and every model-lock acquisition must route its pull and flush
    // push through the gate via wrapSync. The old rule matched only literal
    // pushChanged calls, so pushes made by acquireModelLocks' flush were
    // invisible to it — which is how every run path came to push ungated
    // (swamp-club#2405).
    const shared = callSpans(body, "withSharedSyncGate");
    for (const at of pushes) {
      if (!shared.some(([start, end]) => at > start && at < end)) {
        violations.push(`${file}: ${name} pushes outside withSharedSyncGate`);
      }
    }
    for (const [start, end] of lockCalls) {
      if (!body.slice(start, end).includes("wrapSync")) {
        violations.push(
          `${file}: ${name} calls acquireModelLocks without wrapSync`,
        );
      }
    }
  }

  assertGreater(pushers, 0, "expected to find pushing serve functions");
  assertEquals(
    violations,
    [],
    "Every datastore sync in serve must hold the sync gate. A handler that " +
      "mutates the local cache and pushes runs as one exclusive unit — wrap " +
      "it in withSyncGate(ctx.syncGate, ...) at its dispatch site in " +
      "connection.ts (swamp-club#2247). A run path pushes under the shared " +
      "mode — wrap the push in withSharedSyncGate(ctx.syncGate, ...) and " +
      "pass { wrapSync: (fn) => withSharedSyncGate(ctx.syncGate, fn) } to " +
      "acquireModelLocks, or use createStepLockHook, which does both " +
      "(swamp-club#2405). Only add a function to UNGATED_PUSH_HANDLERS in " +
      "src/serve/sync_gate.ts if nothing can overlap it, with a comment " +
      "saying why.\n\nViolations:\n" + violations.join("\n"),
  );
});

Deno.test("dispatch-gated serve handlers must not take the shared sync gate", async () => {
  const { functions, dispatchGated } = await collectServeFunctions();
  const violations = functions
    .filter(({ name, body }) =>
      dispatchGated.has(name) &&
      (body.includes("withSharedSyncGate(") ||
        body.includes("createStepLockHook("))
    )
    .map(({ name, file }) => `${file}: ${name}`);

  assertEquals(
    violations,
    [],
    "A handler gated exclusively at its dispatch site already holds the " +
      "sync gate, and the gate is not reentrant: taking the shared mode " +
      "inside it waits on itself until GATE_WAIT_TIMEOUT_MS. Push directly " +
      "(the handler's exclusive hold already covers it), or launch the run " +
      "detached and never await it, as workflow.approve does for " +
      "auto-resume.\n\nViolations:\n" + violations.join("\n"),
  );
});

const WORKER_DEPS_PATTERN =
  /create(?:WorkerTokenCreate|WorkerTokenRevoke|WorkerModelRun)Deps\(/;

Deno.test("serve handlers must pass vaultsDir to createWorker*Deps", async () => {
  const violations: string[] = [];

  for await (
    const entry of walk(SERVE_HANDLERS_DIR, {
      exts: [".ts"],
      skip: [/_test\.ts$/],
    })
  ) {
    const content = await Deno.readTextFile(entry.path);
    const rel = normalise(relative(ROOT, entry.path));

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (WORKER_DEPS_PATTERN.test(line)) {
        const callStart = i;
        let callBlock = "";
        for (let j = i; j < lines.length && j < i + 10; j++) {
          callBlock += lines[j];
          if (lines[j].includes(");")) break;
        }
        if (!callBlock.includes("vaultsDir")) {
          violations.push(`${rel}:${callStart + 1}: ${line.trim()}`);
        }
      }
    }
  }

  assertEquals(
    violations,
    [],
    "Serve handlers calling createWorker*Deps must pass " +
      "{ vaultsDir: ctx.vaultsDir } so VaultService scans the correct " +
      "vault config directory under managedConfig. Without it, the " +
      "function falls back to join(repoDir, 'vaults'), which misses " +
      "user-configured vaults (swamp-club#2276).\n\nViolations:\n" +
      violations.join("\n"),
  );
});
