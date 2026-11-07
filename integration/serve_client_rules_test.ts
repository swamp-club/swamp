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
import { walk } from "@std/fs";
import { fromFileUrl, relative, SEPARATOR } from "@std/path";
import { assertPinnedSet } from "./arch_fitness_helpers.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

async function sourceFiles(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (
    const entry of walk(`${ROOT}${dir}`, {
      exts: [".ts"],
      skip: [/_test\.ts$/],
    })
  ) {
    const rel = relative(ROOT, entry.path).split(SEPARATOR).join("/");
    files.set(rel, await Deno.readTextFile(entry.path));
  }
  return files;
}

function callBody(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    if (source[i] === ")" && --depth === 0) return source.slice(open, i);
  }
  return source.slice(open);
}

// Each emits with no caller's credential behind it: login before a token
// exists, system, scheduler, webhook, worker.
const NO_CALLER_CREDENTIAL = [
  "src/serve/device_auth_handler.ts#1",
  "src/serve/dispatch_secret_loads.ts#1",
  "src/serve/handlers/shared.ts#4",
  "src/serve/trigger_audit.ts#1",
  "src/serve/trigger_audit.ts#2",
];

Deno.test("serve client rules: every audit event names the client unless no caller's credential is behind it", async () => {
  const without: string[] = [];
  for (const [rel, source] of await sourceFiles("src/serve")) {
    let site = 0;
    for (const match of source.matchAll(/buildAuditEvent\(/g)) {
      site++;
      const body = callBody(source, match.index + "buildAuditEvent".length);
      if (!/\bclient\b/.test(body)) without.push(`${rel}#${site}`);
    }
  }
  assertPinnedSet(
    without,
    NO_CALLER_CREDENTIAL,
    "audit call sites without a client",
    "a request-bound audit event must carry the client, or it silently reads as direct",
  );
});

Deno.test("serve client rules: no request schema or handler reads a client from a payload", async () => {
  const offenders: string[] = [];
  for (const [rel, source] of await sourceFiles("src/serve")) {
    if (/payload\??\.client\b/.test(source)) offenders.push(rel);
    if (
      rel === "src/serve/connection.ts" && /\bclient\s*:\s*z\./.test(source)
    ) {
      offenders.push(`${rel} (schema)`);
    }
  }
  assertEquals(offenders, []);
});

// Each builds a caller with no client on purpose: auth mode none has no caller,
// and a deposit is replayed with no session. AccessPrincipal itself requires the
// key, so the compiler holds every other site.
const DECIDES_WITHOUT_CLIENT = [
  "src/serve/datastore_api.ts#3",
  "src/serve/http_caller_auth.ts#1",
  "src/serve/signal_http.ts#1",
];

// no client on purpose: a trigger has no caller's token, a run's vault use is
// delegated by `run`, and access.check of another subject explains a person
const CLIENT_LEFT_UNDEFINED = [
  "src/serve/handlers/access_handlers.ts#1",
  "src/serve/run_vault_access_policy.ts#1",
  "src/serve/run_vault_access_policy.ts#2",
  "src/serve/run_vault_access_policy.ts#3",
  "src/serve/trigger_authorizer.ts#1",
];

Deno.test("serve client rules: every access principal names the client unless it decides for a run or a trigger", async () => {
  const without: string[] = [];
  for (const [rel, source] of await sourceFiles("src/serve")) {
    let site = 0;
    for (
      const match of source.matchAll(
        /(?:\{\s*principal(?::[^,]*)?,\s*(?:collectives|groups)[^}]*\})/g,
      )
    ) {
      site++;
      if (!/\bclient\b/.test(match[0])) without.push(`${rel}#${site}`);
    }
  }
  assertPinnedSet(
    without,
    DECIDES_WITHOUT_CLIENT,
    "access principals without a client",
    "a request's decision without a client silently reads as direct, so a client deny would not fire",
  );
});

Deno.test("serve client rules: only a run or a trigger decides with its client left undefined", async () => {
  const sites: string[] = [];
  for (const [rel, source] of await sourceFiles("src/serve")) {
    let site = 0;
    for (const _ of source.matchAll(/\bclient:\s*undefined\b/g)) {
      site++;
      sites.push(`${rel}#${site}`);
    }
  }
  assertPinnedSet(
    sites,
    CLIENT_LEFT_UNDEFINED,
    "decisions with the client left undefined",
    "a request's decision with no client skips the ceiling and silently reads as direct",
  );
});

Deno.test("serve client rules: a run's vault policy never hands a decision the run's client", async () => {
  const policy = await Deno.readTextFile(
    `${ROOT}src/serve/run_vault_access_policy.ts`,
  );
  const start = policy.indexOf("#accessPrincipal(): Promise");
  const end = policy.indexOf("export interface RunVaultScopeContext");
  assert(start !== -1 && start < end, "the policy's markers moved");
  assertEquals(
    policy.slice(start, end).replaceAll("client: undefined", "").includes(
      "client",
    ),
    false,
  );
});

// An id is read only as the key to that integration's own record: to find its
// ceiling, and to close its sessions when its record changes.
const READS_INTEGRATION_ID = [
  "src/domain/access/grant_based_access_decision_service.ts",
  "src/serve/handlers/shared.ts",
];

Deno.test("serve client rules: an integration id is read only to look up that integration", async () => {
  const uses: string[] = [];
  for (const dir of ["src/serve", "src/domain", "src/libswamp", "src/cli"]) {
    for (const [rel, source] of await sourceFiles(dir)) {
      if (rel === "src/domain/access/client.ts") continue;
      if (/\bintegrationOfClient\(/.test(source)) uses.push(rel);
    }
  }
  assertPinnedSet(
    uses,
    READS_INTEGRATION_ID,
    "readers of an integration id",
    "behaviour may depend on a client's kind; an id is only a key to its own record",
  );
});

Deno.test("serve client rules: nothing in production issues an integration token", async () => {
  const offenders: string[] = [];
  for (const dir of ["src/serve", "src/domain", "src/libswamp", "src/cli"]) {
    for (const [rel, source] of await sourceFiles(dir)) {
      if (rel === "src/domain/access/client.ts") continue;
      if (/kind:\s*["']integration["']/.test(source)) offenders.push(rel);
    }
  }
  assertEquals(offenders, []);
});

Deno.test("serve client rules: behaviour never branches on a client id", async () => {
  const uses: string[] = [];
  for (const dir of ["src/serve", "src/domain", "src/libswamp", "src/cli"]) {
    for (const [rel, source] of await sourceFiles(dir)) {
      if (rel === "src/domain/access/client.ts") continue;
      if (/["'`]direct:|["'`]integration:/.test(source)) {
        uses.push(`${rel} (literal)`);
      }
      if (/DIRECT_(CLI|DASHBOARD|TOKEN)_CLIENT\s*(===|!==)/.test(source)) {
        uses.push(`${rel} (comparison)`);
      }
      if (/(===|!==)\s*DIRECT_(CLI|DASHBOARD|TOKEN)_CLIENT/.test(source)) {
        uses.push(`${rel} (comparison)`);
      }
    }
  }
  assertEquals(uses, []);
});
