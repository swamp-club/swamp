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
 * Serve handlers authorize the resource a request resolves to, never the raw
 * id-or-name the client sent: a grant matches a resource name, so a raw UUID
 * sidesteps name-scoped denies (swamp-club#2674). Handlers build that
 * resource with resource_resolution.ts.
 *
 * This is a cheap textual guard alongside the behavioral one in
 * serve_id_deny_conformance_test.ts: it flags any `name: payload.<field>`
 * where <field> is a raw resource identifier. The pinned entries are the
 * handlers other issues own, plus the edit handlers' deliberate fallback
 * for a request that resolved to nothing. It can only shrink.
 */

import { join, relative, SEPARATOR } from "@std/path";
import { assertPinnedSet } from "./arch_fitness_helpers.ts";

const ROOT = join(import.meta.dirname!, "..");
const SERVE_DIR = join(ROOT, "src", "serve");
const FILES = [
  "handlers/model_handlers.ts",
  "handlers/workflow_handlers.ts",
  "handlers/data_handlers.ts",
  "handlers/report_handlers.ts",
  "connection.ts",
];

const RAW_NAME =
  /name: payload\??\.(modelIdOrName|workflowIdOrName|outputIdOrModelName|outputIdArg|runIdOrWorkflow|workflowName|definitionName)\b/;
const FUNCTION = /^(?:export )?(?:async )?function\*? (\w+)/;

const PINNED = [
  // Direct type execution may create its definition — swamp-club#2672.
  "src/serve/handlers/model_handlers.ts::resolveMethodRunTarget::modelIdOrName",
  // Edit resolves first and replies not_found when nothing matched; the raw
  // name is only authorized for that reply.
  "src/serve/handlers/workflow_handlers.ts::handleWorkflowEdit::workflowIdOrName",
];

function normalise(p: string): string {
  return SEPARATOR === "\\" ? p.replaceAll("\\", "/") : p;
}

Deno.test("serve handlers authorize resolved resources, not raw payload identifiers", async () => {
  const found = new Set<string>();
  for (const file of FILES) {
    const path = join(SERVE_DIR, file);
    const rel = normalise(relative(ROOT, path));
    let enclosing = "<module>";
    for (const line of (await Deno.readTextFile(path)).split("\n")) {
      const fn = FUNCTION.exec(line);
      if (fn) enclosing = fn[1];
      const raw = RAW_NAME.exec(line);
      if (raw) found.add(`${rel}::${enclosing}::${raw[1]}`);
    }
  }
  assertPinnedSet(
    [...found].sort(),
    PINNED,
    "Serve authorization on raw payload identifiers",
    "Authorize the resource the identifier resolves to instead: resolve it " +
      "with resource_resolution.ts (resolveModelTarget / " +
      "resolveWorkflowTarget), authorize with authorizeResolved, and act on " +
      "targetArgument(...) — see swamp-club#2674.",
  );
});

/**
 * A `*` resource name never matches a name-scoped deny, and a condition on
 * resource fields fails closed against one, so no handler authorizes a
 * model, data or workflow resource named `*` (swamp-club#2675). A request
 * over many resources checks each one (filterByResources, an include
 * filter), a check on a kind itself uses kindResource, and an operation over
 * every resource uses authorizeAllOrReject.
 */
Deno.test("serve handlers never authorize a model, data or workflow resource named *", async () => {
  const handlers = join(SERVE_DIR, "handlers");
  const found: string[] = [];
  for await (const entry of Deno.readDir(handlers)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith("_test.ts")) continue;
    const path = join(handlers, entry.name);
    const text = await Deno.readTextFile(path);
    const star =
      /kind: "(model|data|workflow)",\s*name: "\*"|name: "\*",\s*kind: "(model|data|workflow)"/g;
    for (const match of text.matchAll(star)) {
      const line = text.slice(0, match.index).split("\n").length;
      found.push(`${normalise(relative(ROOT, path))}:${line}`);
    }
  }
  assertPinnedSet(
    found.sort(),
    [],
    "Authorization of a resource named *",
    "Filter per resource with filterByResources or an include filter, use " +
      "kindResource for a check on the kind itself, or authorizeAllOrReject " +
      "for an operation over every resource — see swamp-club#2675.",
  );
});
