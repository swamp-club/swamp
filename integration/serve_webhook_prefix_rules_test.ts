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
import { join } from "@std/path";
import {
  assertPinnedSet,
  countedKeys,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";
import { serveDashboardRoute } from "../src/serve/dashboard_assets.ts";
import { isDataPlaneRequest } from "../src/serve/data_plane.ts";
import { matchDatastoreRoute } from "../src/serve/datastore_routes.ts";
import { matchDelegationRoute } from "../src/serve/delegation_routes.ts";
import { resolveHttpRoute } from "../src/serve/http_request_span.ts";
import { matchSignalRoute } from "../src/serve/signal_http.ts";
import { WEBHOOK_ROUTE_PREFIX } from "../src/serve/webhook_route.ts";

// local/ and start/ host no webhooks today; scanning them keeps a future
// host that forwards webhooks inside the rule
const SCAN_ROOTS = [
  join(SRC_DIR, "cli", "commands", "serve.ts"),
  join(SRC_DIR, "serve"),
];

type MatchKind = "exact" | "prefix" | "root";

interface ServePath {
  readonly file: string;
  readonly kind: MatchKind;
  readonly path: string;
  readonly via: string;
}

const COMPARED = /(?:[!=]==\s*|\bcase\s+)"(\/[^"]*)"|"(\/[^"]*)"\s*[!=]==/g;
const STARTS_WITH = /\bstartsWith\(\s*"(\/[^"]*)"/g;
const ROUTE_CONSTANT =
  /\bconst\s+([A-Z][A-Z0-9_]*(?:PATH|PREFIX|ROUTE))\s*(?::\s*\w+\s*)?=\s*"(\/[^"]*)"/g;
const ROUTE_PROPERTY = /\b([a-z]\w*(?:Path|Prefix|Route))\s*:\s*"(\/[^"]*)"/g;
// a regex literal anchored at the path start: its first segment, or a group
const ROUTE_REGEX = /\/\^\\\/(?:\((?:\?:)?([\w-]+(?:\|[\w-]+)*)\)|([\w-]+))/g;

// Floors, so a scan that stops matching fails loudly.
const MIN_PER_KIND: Record<MatchKind, number> = {
  exact: 30,
  prefix: 8,
  root: 5,
};

async function servePaths(): Promise<ServePath[]> {
  const files: string[] = [SCAN_ROOTS[0]];
  for await (const file of productionSourceFiles(SCAN_ROOTS[1])) {
    files.push(file);
  }
  const paths: ServePath[] = [];
  for (const absolute of files) {
    const source = await Deno.readTextFile(absolute);
    const file = repoRelative(absolute);
    for (const m of source.matchAll(COMPARED)) {
      paths.push({ file, kind: "exact", path: m[1] ?? m[2], via: "compare" });
    }
    for (const m of source.matchAll(STARTS_WITH)) {
      paths.push({ file, kind: "prefix", path: m[1], via: "startsWith" });
    }
    for (const m of source.matchAll(ROUTE_CONSTANT)) {
      const kind = m[1].endsWith("PREFIX") ? "prefix" : "exact";
      paths.push({ file, kind, path: m[2], via: m[1] });
    }
    for (const m of source.matchAll(ROUTE_PROPERTY)) {
      const kind = m[1].endsWith("Prefix") ? "prefix" : "exact";
      paths.push({ file, kind, path: m[2], via: m[1] });
    }
    for (const m of source.matchAll(ROUTE_REGEX)) {
      for (const segment of (m[1] ?? m[2]).split("|")) {
        paths.push({ file, kind: "root", path: `/${segment}`, via: m[0] });
      }
    }
  }
  return paths;
}

function collides({ kind, path }: ServePath): boolean {
  if (kind === "exact") return path.startsWith(WEBHOOK_ROUTE_PREFIX);
  // a regex root is unbounded, so it is judged as a prefix
  return path.startsWith(WEBHOOK_ROUTE_PREFIX) ||
    WEBHOOK_ROUTE_PREFIX.startsWith(path);
}

function describe({ file, kind, path, via }: ServePath): string {
  return `${file}: ${kind} ${path} via ${via}`;
}

Deno.test("serve webhook prefix: serve answers no path under the webhook route-file prefix", async () => {
  const collisions = (await servePaths()).filter(collides).map(describe);

  assertPinnedSet(
    countedKeys(collisions),
    [
      // the prefix itself
      `src/serve/webhook_route.ts: prefix ${WEBHOOK_ROUTE_PREFIX} via WEBHOOK_ROUTE_PREFIX`,
      // validates a configured webhook route, matches no request
      "src/serve/serve_config.ts: prefix / via startsWith",
      // validates a configured webhook route, matches no request
      "src/serve/webhook.ts: prefix / via startsWith",
    ],
    `serve paths overlapping ${WEBHOOK_ROUTE_PREFIX}`,
    `Webhook route files own ${WEBHOOK_ROUTE_PREFIX} and are matched before ` +
      "serve's own routes, so a reviewed route file would silently take this " +
      "path over. Move the route out of the prefix. Exempt only code that " +
      "matches no request path.",
  );
});

Deno.test("serve webhook prefix: the scan still sees every kind of serve route matcher", async () => {
  const paths = await servePaths();
  const seen = new Set(
    paths.map(({ file, kind, path }) => `${file}: ${kind} ${path}`),
  );
  const missing = [
    "src/serve/protocol.ts: exact /api/v1/request",
    "src/serve/protocol.ts: exact /api/v1/action",
    "src/serve/datastore_routes.ts: prefix /api/v1/datastore/",
    "src/serve/delegation_routes.ts: prefix /api/v1/delegations/",
    "src/serve/dashboard_assets.ts: prefix /dashboard/",
    "src/serve/device_auth_handler.ts: exact /auth/device",
    "src/serve/dashboard_session_handler.ts: exact /auth/dashboard/device",
    "src/cli/commands/serve.ts: exact /ready",
    "src/serve/http_request_span.ts: root /data",
    "src/serve/http_request_span.ts: root /bundle",
    "src/serve/signal_http.ts: root /api",
  ].filter((route) => !seen.has(route));
  assertEquals(
    missing,
    [],
    "the scan no longer finds these serve routes, so a matcher written that " +
      "way is unchecked; widen the scan in this test",
  );

  for (const [kind, floor] of Object.entries(MIN_PER_KIND)) {
    const count = paths.filter((p) => p.kind === kind).length;
    assert(
      count >= floor,
      `found ${count} ${kind} route matchers in serve sources, expected at ` +
        `least ${floor}`,
    );
  }
});

Deno.test("serve webhook prefix: serve's route matchers answer nothing under the prefix", async () => {
  const probes = [
    WEBHOOK_ROUTE_PREFIX,
    `${WEBHOOK_ROUTE_PREFIX}x`,
    `${WEBHOOK_ROUTE_PREFIX}a/b/c`,
    `${WEBHOOK_ROUTE_PREFIX}api/v1/request`,
    `${WEBHOOK_ROUTE_PREFIX}api/v1/signal`,
    `${WEBHOOK_ROUTE_PREFIX}api/v1/datastore/ns/commits`,
    `${WEBHOOK_ROUTE_PREFIX}api/v1/delegations/x`,
    `${WEBHOOK_ROUTE_PREFIX}data/x`,
    `${WEBHOOK_ROUTE_PREFIX}bundle/x`,
    `${WEBHOOK_ROUTE_PREFIX}dashboard`,
  ];
  for (const path of probes) {
    const req = () => new Request(`http://localhost${path}`);
    assertEquals(isDataPlaneRequest(req()), false, `data plane: ${path}`);
    assertEquals(matchDatastoreRoute(path), undefined, `datastore: ${path}`);
    assertEquals(matchDelegationRoute(path), undefined, `delegation: ${path}`);
    assertEquals(matchSignalRoute(path), undefined, `signal: ${path}`);
    assertEquals(resolveHttpRoute(path), undefined, `known routes: ${path}`);
    // the dist dir is never read for a path outside the dashboard
    assertEquals(
      await serveDashboardRoute("/nonexistent", req()),
      null,
      `dashboard: ${path}`,
    );
  }
});
