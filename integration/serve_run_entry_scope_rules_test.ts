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
 * Every serve run enters the vault scope of the principal that triggered it
 * (swamp-club#2676). This ratchet enumerates every call that starts a run in
 * `src/serve` and `src/libswamp/workflows` — `executeWorkflow*(`,
 * `execute(` (webhook's alias), `service.resume(` and `modelMethodRun(` —
 * and classifies each one:
 *
 * - **user-run**: a run a principal triggered. It must enter that
 *   principal's scope: an `executeWorkflowWithLocks` call passes
 *   `vaultAccess`; a `modelMethodRun` or `resume` generator is driven through
 *   `runGeneratorWithVaultAccess`.
 * - **queue**: a scheduler or webhook queue entry. It starts outside any
 *   scope (`withoutVaultAccess`) so the queue's inherited context never
 *   carries another entry's.
 * - **injected**: the scheduler's injected executor; serve's executor passes
 *   `vaultAccess` (checked in `src/cli/commands/serve.ts`).
 * - **control-plane**: bookkeeping a run triggers (enrollment, lease
 *   transitions, worker prune). It runs outside any scope.
 *
 * A new call must be classified here, and must carry its classification's
 * marker.
 */

import { assert } from "@std/assert";
import { join } from "@std/path";
import {
  assertPinnedSet,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
  topLevelOwners,
} from "./arch_fitness_helpers.ts";

type Classification = "user-run" | "queue" | "injected" | "control-plane";

/** `<file>: <owner>: <callee>` → its classification, one per call. */
const PINNED: Readonly<Record<string, Classification>> = {
  "src/libswamp/workflows/scheduled_execution.ts: ScheduledExecutionService: this.executeWorkflow":
    "queue",
  "src/libswamp/workflows/scheduled_execution.ts: ScheduledExecutionService: this.deps.executeWorkflow":
    "injected",
  "src/serve/dispatch_service.ts: DispatchService: modelMethodRun":
    "control-plane",
  "src/serve/handlers/admin_handlers.ts: handleWorkerPrune: modelMethodRun":
    "control-plane",
  "src/serve/handlers/model_handlers.ts: handleModelMethodRun: modelMethodRun#1":
    "user-run",
  "src/serve/handlers/model_handlers.ts: handleModelMethodRun: modelMethodRun#2":
    "user-run",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowResume: service.resume":
    "user-run",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowRun: executeWorkflowWithLocks#1":
    "user-run",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowRun: executeWorkflowWithLocks#2":
    "user-run",
  "src/serve/resume_launcher.ts: startDetachedResume: service.resume":
    "user-run",
  "src/serve/webhook.ts: WebhookService: execute": "user-run",
  "src/serve/webhook.ts: WebhookService: this.executeWorkflow": "queue",
  "src/serve/worker_gateway.ts: WorkerGateway: modelMethodRun": "control-plane",
};

const CALL =
  /(?<![\w.])((?:this\.(?:deps\.)?)?executeWorkflow\w*|modelMethodRun|execute|service\.resume)\(/g;

/** A call's text from its callee to its matching close paren. */
function callText(source: string, start: number): string {
  let depth = 0;
  for (let i = source.indexOf("(", start); i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) {
      return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

interface FoundCall {
  key: string;
  /** The call and the three lines before it. */
  context: string;
  call: string;
}

async function runEntryCalls(): Promise<FoundCall[]> {
  const found: FoundCall[] = [];
  for (const dir of ["serve", join("libswamp", "workflows")]) {
    for await (const path of productionSourceFiles(join(SRC_DIR, dir))) {
      const source = await Deno.readTextFile(path);
      const lines = source.split("\n");
      const owners = topLevelOwners(lines);
      const counts = new Map<string, number>();
      const perFile: { base: string; context: string; call: string }[] = [];
      for (const match of source.matchAll(CALL)) {
        const lineIndex = source.slice(0, match.index).split("\n").length - 1;
        const line = lines[lineIndex];
        if (isCommentLine(line)) continue;
        // A declaration, not a call.
        if (
          /\b(function|async|private)\s+\w*\s*$/.test(
            line.slice(0, line.indexOf(match[1])),
          )
        ) continue;
        const base = `${repoRelative(path)}: ${owners[lineIndex]}: ${match[1]}`;
        counts.set(base, (counts.get(base) ?? 0) + 1);
        perFile.push({
          base,
          context: lines.slice(Math.max(0, lineIndex - 3), lineIndex + 1)
            .join("\n"),
          call: callText(source, match.index),
        });
      }
      const seen = new Map<string, number>();
      for (const { base, context, call } of perFile) {
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        found.push({
          key: (counts.get(base) ?? 0) > 1 ? `${base}#${n}` : base,
          context,
          call,
        });
      }
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

Deno.test("serve run entries: every run-starting call is classified", async () => {
  const calls = await runEntryCalls();
  assertPinnedSet(
    calls.map((c) => c.key),
    Object.keys(PINNED).sort(),
    "Serve run entries (swamp-club#2676)",
    "Classify the new call in PINNED: a user run enters its triggering " +
      "principal's vault scope (vaultAccess / runGeneratorWithVaultAccess); " +
      "control-plane work runs under withoutVaultAccess.",
  );
});

Deno.test("serve run entries: each call carries its classification's marker", async () => {
  for (const { key, context, call } of await runEntryCalls()) {
    const classification = PINNED[key];
    switch (classification) {
      case "user-run":
        assert(
          /\bvaultAccess\b/.test(call) ||
            context.includes("runGeneratorWithVaultAccess("),
          `${key} starts a user run outside its principal's vault scope`,
        );
        break;
      case "queue":
        assert(
          context.includes("withoutVaultAccess("),
          `${key} must start each queue entry under withoutVaultAccess`,
        );
        break;
      case "control-plane":
        assert(
          context.includes("runGeneratorWithoutVaultAccess(") ||
            context.includes("withoutVaultAccess("),
          `${key} is control-plane work and must run outside any vault scope`,
        );
        break;
      case "injected":
        break;
    }
  }
});

Deno.test("serve run entries: the scheduler's executor passes vaultAccess", async () => {
  const serve = await Deno.readTextFile(
    join(SRC_DIR, "cli", "commands", "serve.ts"),
  );
  const at = serve.indexOf('triggerSource: "schedule"');
  assert(at !== -1, "serve.ts no longer wires the scheduler's executor");
  const options = serve.slice(at, serve.indexOf("}", at));
  assert(
    /vaultAccess: serviceRunVaultScope\(/.test(options),
    "the scheduler's executeWorkflowWithLocks call must pass vaultAccess",
  );
});

Deno.test("serve run entries: serve's HTTP handler starts every request outside any vault scope", async () => {
  // Deno can call a serve handler with the async context a run left
  // behind (a first-time dynamic import inside a run does), so every
  // request — WebSocket upgrades included — must leave it first.
  const serve = await Deno.readTextFile(
    join(SRC_DIR, "cli", "commands", "serve.ts"),
  );
  const servers = [...serve.matchAll(/Deno\.serve\(/g)];
  assert(servers.length === 1, "serve.ts starts one HTTP server");
  const call = callText(serve, servers[0].index);
  assert(
    /\bunscopedHttpHandler\(traceHttpRequests\(/.test(call),
    "serve's Deno.serve handler must be wrapped in unscopedHttpHandler",
  );
  assert(
    /function unscopedHttpHandler[\s\S]*?withoutVaultAccess\(/.test(serve),
    "unscopedHttpHandler must run the handler under withoutVaultAccess",
  );
});
