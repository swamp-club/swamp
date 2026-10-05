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
 * Serve commits through root units of work (datastore rework Phase 2,
 * swamp-club#3034). A serve request or run that pushes runs in one
 * `runInRootUnitOfWork` root whose flush is the push. These ratchets pin
 * where serve opens a root, and every push that is not yet a root's flush,
 * so a new push cannot bypass the unit of work unnoticed.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  assertPinnedSet,
  countedKeys,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
  topLevelOwners,
} from "./arch_fitness_helpers.ts";

const SERVE_DIR = join(SRC_DIR, "serve");

/** A `<callee>(...)` call: its span and its top-level argument spans. */
interface Call {
  start: number;
  end: number;
  args: [number, number][];
}

/**
 * Every `<callee>(...)` call in `source`, from the callee name to its
 * matching close paren, with the span of each top-level argument. A
 * `function <callee>(` declaration is not a call.
 */
function calls(source: string, callee: string): Call[] {
  const found: Call[] = [];
  const pattern = new RegExp(`(?<!function )\\b${callee}\\(`, "g");
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const args: [number, number][] = [];
    let depth = 0;
    let argStart = start + match[0].length;
    let i = argStart;
    for (; i < source.length; i++) {
      const ch = source[i];
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) {
        args.push([argStart, i]);
        argStart = i + 1;
      }
    }
    if (source.slice(argStart, i).trim() !== "") args.push([argStart, i]);
    found.push({ start, end: i + 1, args });
  }
  return found;
}

/**
 * `source` with the text of every comment and of every string and template
 * literal replaced by spaces, keeping newlines and length so offsets and line
 * numbers still match. Code inside a template's `${...}` is kept. Brackets and
 * pushes inside a string or comment are then never mistaken for code. Regular
 * expression literals are not recognised; serve's flush arguments contain
 * none.
 */
function maskNonCode(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // Each open template literal records the brace depth of its `${`.
  const templates: number[] = [];
  let braces = 0;
  let i = 0;
  const skipTemplateText = () => {
    const start = i;
    for (; i < source.length; i++) {
      if (source[i] === "\\") {
        i++;
      } else if (source[i] === "`") {
        blank(start, i);
        templates.pop();
        i++;
        return;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        blank(start, i);
        templates[templates.length - 1] = braces;
        braces++;
        i += 2;
        return;
      }
    }
    blank(start, i);
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== "\n") {
        j += source[j] === "\\" ? 2 : 1;
      }
      blank(i + 1, j);
      i = j + 1;
    } else if (ch === "`") {
      templates.push(-1);
      i++;
      skipTemplateText();
    } else if (ch === "{") {
      braces++;
      i++;
    } else if (ch === "}") {
      braces--;
      i++;
      if (templates.length > 0 && templates[templates.length - 1] === braces) {
        skipTemplateText();
      }
    } else {
      i++;
    }
  }
  return out.join("");
}

interface ServeSource {
  file: string;
  /** The source with comments and string literal text masked out. */
  code: string;
  /** The top-level declaration owning each line. */
  owners: string[];
}

async function serveSources(): Promise<ServeSource[]> {
  const sources: ServeSource[] = [];
  for await (const path of productionSourceFiles(SERVE_DIR)) {
    const lines = (await Deno.readTextFile(path)).split("\n");
    sources.push({
      file: repoRelative(path),
      code: maskNonCode(lines.join("\n")),
      owners: topLevelOwners(lines),
    });
  }
  return sources;
}

function ownerAt(source: ServeSource, offset: number): string {
  const line = source.code.slice(0, offset).split("\n").length - 1;
  return `${source.file}: ${source.owners[line]}`;
}

/**
 * The functions that open a root unit of work, each with the index of its
 * options argument, whose `flush` is the root's push.
 */
const ROOT_OPENERS: Readonly<Record<string, number>> = {
  runInRootUnitOfWork: 1,
  // Stages per-path writes through a root, then pushes (swamp-club#3034).
  stageWritesThenPush: 2,
};

/** Every call in `source` that opens a root, with its options argument. */
function rootCalls(
  source: string,
): { start: number; options?: [number, number] }[] {
  return Object.entries(ROOT_OPENERS).flatMap(([callee, index]) =>
    calls(source, callee).map(({ start, args }) => ({
      start,
      options: args[index],
    }))
  );
}

/** Whether `offset` sits in a root's options argument: the root's flush. */
function inRootFlush(
  roots: { options?: [number, number] }[],
  offset: number,
): boolean {
  return roots.some(({ options }) =>
    options !== undefined && offset > options[0] && offset < options[1]
  );
}

/** Owners of pushes matching `pattern` that are not a root's flush. */
function pushesOutsideRoots(
  sources: ServeSource[],
  pattern: RegExp,
): string[] {
  const keys: string[] = [];
  for (const source of sources) {
    const roots = rootCalls(source.code);
    for (const match of source.code.matchAll(pattern)) {
      if (!inRootFlush(roots, match.index)) {
        keys.push(ownerAt(source, match.index));
      }
    }
  }
  return countedKeys(keys);
}

/** Owners of every call in serve that opens a root. */
function rootEntryPoints(sources: ServeSource[]): string[] {
  return countedKeys(
    sources.flatMap((source) =>
      rootCalls(source.code).map(({ start }) => ownerAt(source, start))
    ),
  );
}

// ---------------------------------------------------------------------------
// Pinned lists
// ---------------------------------------------------------------------------

/**
 * Calls to `pushChangedToRemote`, with any argument, that are not a root's
 * flush. Empty: every serve handler that pushes through it does so as its
 * root's flush.
 */
const PINNED_DIRECT_PUSH_CHANGED_TO_REMOTE_CALLERS: readonly string[] = [];

/** Serve functions that open a root unit of work. */
const PINNED_SERVE_ROOT_ENTRY_POINTS: readonly string[] = [
  // Request handlers whose push runs after their work on every outcome.
  "src/serve/handlers/access_handlers.ts: handleAccessTokenMint",
  "src/serve/handlers/access_handlers.ts: handleAccessTokenRevoke",
  "src/serve/handlers/access_handlers.ts: handleAccessTokenRotate",
  "src/serve/handlers/admin_handlers.ts: handleWorkerPrune",
  "src/serve/handlers/admin_handlers.ts: handleWorkerTokenCreate",
  "src/serve/handlers/admin_handlers.ts: handleWorkerTokenRevoke",
  "src/serve/handlers/data_handlers.ts: handleDataDelete",
  "src/serve/handlers/data_handlers.ts: handleDataGc",
  "src/serve/handlers/data_handlers.ts: handleDataPrune",
  "src/serve/handlers/data_handlers.ts: handleDataRename",
  "src/serve/handlers/data_handlers.ts: handleRunGc",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowApprove",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowReject",
  "src/serve/suspended_run_cancel.ts: cancelLocatedRunAndPush",
  // Workflow runs from the workflow.run handler, webhooks and the scheduler:
  // the post-run push. Each step's model lock still pushes on its own.
  "src/serve/deps.ts: executeWorkflowWithLocks",
  // Hand marks re-staged just before their push, through
  // stageWritesThenPush. Each root covers only the marks and the push, as a
  // failed write pushed nothing before.
  "src/serve/device_auth_handler.ts: mintServerTokenImpl",
  "src/serve/grant_write_tracking.ts: publishGrantWrites",
  "src/serve/handlers/access_handlers.ts: handleAccessReload",
  "src/serve/stage_writes_then_push.ts: stageWritesThenPush",
];

/**
 * `syncService.pushChanged` calls in serve that are not a root's flush, each
 * with the reason it is not one yet.
 */
const PINNED_SERVE_RAW_PUSHES: readonly string[] = [
  // The push the converted handlers flush through.
  "src/serve/handlers/shared.ts: pushChangedToRemote",
  // Handlers that push only on success, after the reply (swamp-club#3035).
  "src/serve/handlers/admin_handlers.ts: handleVaultMigrate",
  "src/serve/handlers/model_handlers.ts: handleModelCreate",
  "src/serve/handlers/model_handlers.ts: handleModelDelete",
  "src/serve/handlers/model_handlers.ts: handleModelEdit",
  "src/serve/handlers/vault_handlers.ts: handleVaultCreate",
  "src/serve/handlers/vault_handlers.ts: handleVaultEdit",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowCreate",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowDelete",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowEdit",
  // Model method runs and resumes, under the shared gate (swamp-club#3035).
  "src/serve/handlers/model_handlers.ts: handleModelMethodRun (x2)",
  "src/serve/handlers/workflow_handlers.ts: handleWorkflowResume",
  "src/serve/resume_launcher.ts: startDetachedResume",
  // Background garbage collection, outside any request.
  "src/serve/bookkeeping_gc.ts: reapBatch",
  "src/serve/worker_gc_service.ts: pruneWorkersAndPush",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const sources = await serveSources();

Deno.test("serve root units: pushChangedToRemote runs only as a root's flush (swamp-club#3034)", () => {
  assertPinnedSet(
    pushesOutsideRoots(sources, /(?<!function )\bpushChangedToRemote\(/g),
    PINNED_DIRECT_PUSH_CHANGED_TO_REMOTE_CALLERS,
    "Direct pushChangedToRemote calls in serve",
    "A serve handler pushes through its request's root unit of work: wrap the\n" +
      "handler's work in runInRootUnitOfWork(ctx.repoContext, { flush: () =>\n" +
      "pushChangedToRemote(ctx) }, ...) instead of calling it directly.",
  );
});

Deno.test("serve root units: serve entry points opening a root are pinned (swamp-club#3034)", () => {
  assertPinnedSet(
    rootEntryPoints(sources),
    PINNED_SERVE_ROOT_ENTRY_POINTS,
    "Serve functions that open a root unit of work",
    "A root opened inside another root for the same hook with its own push\n" +
      "throws. Check the new entry point never runs inside another root, then\n" +
      "add it here.",
  );
});

Deno.test("serve root units: raw pushes outside a root are pinned (swamp-club#3034)", () => {
  assertPinnedSet(
    pushesOutsideRoots(sources, /\bsyncService[?.]*\.pushChanged\(/g),
    PINNED_SERVE_RAW_PUSHES,
    "syncService.pushChanged calls in serve that are not a root's flush",
    "New serve code pushes as a root unit's flush (runInRootUnitOfWork), not\n" +
      "by calling pushChanged directly. If it cannot yet, add it here with the\n" +
      "reason.",
  );
});

Deno.test("serve root units: the scan tells a root's flush from a push in its body, ignoring strings and comments", () => {
  const code = [
    "async function handler() {",
    "  await runInRootUnitOfWork(ctx.repoContext, {",
    "    flush: () => pushChangedToRemote(ctx),",
    "  }, async () => {",
    "    await pushChangedToRemote(ctx);",
    "  });",
    "  // await pushChangedToRemote(ctx);",
    "}",
    "async function stringly() {",
    '  await runInRootUnitOfWork(ctx.repoContext, { label: ")", ',
    '    note: `${")"} (`, flush: () => pushChangedToRemote(ctx) },',
    "    async () => {}); // a ) here, and pushChangedToRemote(ctx)",
    '  log("pushChangedToRemote(ctx)");',
    "}",
    "async function stageWritesThenPush(context, paths, options) {}",
    "async function caller() {",
    "  await stageWritesThenPush(ctx.repoContext, [], {",
    "    flush: () => pushChangedToRemote(ctx),",
    "  });",
    "}",
  ].join("\n");
  const lines = code.split("\n");
  const probe: ServeSource = {
    file: "probe.ts",
    code: maskNonCode(code),
    owners: topLevelOwners(lines),
  };
  assertEquals(
    pushesOutsideRoots([probe], /(?<!function )\bpushChangedToRemote\(/g),
    ["probe.ts: handler"],
  );
  assertEquals(rootEntryPoints([probe]), [
    "probe.ts: caller",
    "probe.ts: handler",
    "probe.ts: stringly",
  ]);
});
