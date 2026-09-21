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

/** Collects identifiers named inside every `withSyncGate(...)` call. */
function gatedIdentifiers(source: string): Set<string> {
  const names = new Set<string>();
  let from = 0;
  while (true) {
    const start = source.indexOf("withSyncGate(", from);
    if (start === -1) return names;
    let depth = 0;
    let i = source.indexOf("(", start);
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    for (const match of source.slice(start, i).matchAll(/[A-Za-z_$][\w$]*/g)) {
      names.add(match[0]);
    }
    from = i;
  }
}

Deno.test("serve functions that push must run under the sync gate", async () => {
  const pushers: { name: string; file: string }[] = [];
  const gated = new Set<string>();

  for await (
    const entry of walk(SERVE_DIR, { exts: [".ts"], skip: [/_test\.ts$/] })
  ) {
    const content = await Deno.readTextFile(entry.path);
    const rel = normalise(relative(ROOT, entry.path));
    if (rel.endsWith("src/serve/sync_gate.ts")) continue;

    for (const name of gatedIdentifiers(content)) gated.add(name);

    // Split on top-level function declarations so a push call is attributed
    // to the function whose body contains it.
    const declarations = [
      ...content.matchAll(/^(?:export )?(?:async )?function (\w+)/gm),
    ];
    for (let i = 0; i < declarations.length; i++) {
      const start = declarations[i].index!;
      const end = i + 1 < declarations.length
        ? declarations[i + 1].index!
        : content.length;
      const body = content.slice(start, end);
      if (
        body.includes("pushChangedToRemote(ctx)") ||
        /syncService[?.]*\.pushChanged\(/.test(body)
      ) {
        pushers.push({ name: declarations[i][1], file: rel });
      }
    }
  }

  assertGreater(pushers.length, 0, "expected to find pushing serve functions");

  const violations = pushers
    .filter(({ name }) => !gated.has(name) && !UNGATED_PUSH_HANDLERS.has(name))
    .map(({ name, file }) => `${file}: ${name}`);

  assertEquals(
    violations,
    [],
    "A serve function that mutates the local cache and pushes must run as " +
      "one unit under the sync gate — otherwise a poller pull can land " +
      "between the local delete and the push, the push sees the path " +
      "present on disk, and the delete is silently undone " +
      "(swamp-club#2247). Wrap the call in withSyncGate(ctx.syncGate, ...) " +
      "at its dispatch site in connection.ts, or add it to " +
      "UNGATED_PUSH_HANDLERS in src/serve/sync_gate.ts with a comment " +
      "saying why it is safe.\n\nViolations:\n" + violations.join("\n"),
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
