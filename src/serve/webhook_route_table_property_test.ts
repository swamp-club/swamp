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
import type { WebhookConfigEntry } from "./serve_config.ts";
import { type WebhookEndpoint, WebhookEnvironmentError } from "./webhook.ts";
import type { RouteFileLoad } from "./webhook_route_files.ts";
import {
  buildWebhookRouteTable,
  type WebhookRouteTableDeps,
} from "./webhook_reload.ts";

const FILES = ["a.yaml", "b.yaml", "c.yaml", "d.yaml"];
const ROUTES = ["/hooks/r0", "/hooks/r1", "/hooks/r2"];

type FileState =
  | { kind: "absent" }
  | { kind: "broken" }
  | {
    kind: "ok";
    route: string;
    workflow: string;
    answer: "ok" | "missing" | "down";
  };

const fileState: fc.Arbitrary<FileState> = fc.oneof(
  fc.constant({ kind: "absent" as const }),
  fc.constant({ kind: "broken" as const }),
  fc.record({
    kind: fc.constant("ok" as const),
    route: fc.constantFrom(...ROUTES),
    workflow: fc.constantFrom("w1", "w2"),
    answer: fc.constantFrom("ok" as const, "missing" as const, "down" as const),
  }),
);

const dirState = fc.tuple(...FILES.map(() => fileState));

function deps(
  state: readonly FileState[],
  untrusted: ReadonlySet<string>,
): WebhookRouteTableDeps {
  return {
    source: "config",
    parse: (configs: readonly WebhookConfigEntry[]) => {
      const [config] = configs;
      if (config.secret.endsWith(":missing")) {
        return Promise.reject(new Error("no such key"));
      }
      if (config.secret.endsWith(":down")) {
        return Promise.reject(new WebhookEnvironmentError("vault timed out"));
      }
      return Promise.resolve([{
        route: config.route,
        workflowIdOrName: config.workflow,
        secret: "resolved",
        verifier: { scheme: "github" },
      }]);
    },
    loadRouteFiles: (): Promise<RouteFileLoad> => {
      const loaded: RouteFileLoad["files"][number][] = [];
      const refused: RouteFileLoad["refused"][number][] = [];
      state.forEach((fs, i) => {
        const file = FILES[i];
        if (fs.kind === "absent") return;
        if (fs.kind === "broken") {
          refused.push({ file, message: `Refused ${file}` });
          return;
        }
        loaded.push({
          file,
          entry: {
            route: fs.route,
            workflow: fs.workflow,
            secret: `@vault=v:${fs.answer}`,
          },
        });
      });
      const claims = new Map<string, number>();
      for (const l of loaded) {
        claims.set(l.entry.route, (claims.get(l.entry.route) ?? 0) + 1);
      }
      const files = loaded.filter((l) => claims.get(l.entry.route) === 1);
      for (const l of loaded.filter((l) => claims.get(l.entry.route)! > 1)) {
        refused.push({
          file: l.file,
          route: l.entry.route,
          message: `Refused ${l.file}: clash`,
        });
      }
      return Promise.resolve({ files, refused });
    },
    keepRefusal: (ep) => untrusted.has(ep.route) ? "untrusted" : undefined,
  };
}

function loadsCleanly(state: readonly FileState[], index: number): boolean {
  const fs = state[index];
  if (fs.kind !== "ok" || fs.answer !== "ok") return false;
  return state.filter((o) => o.kind === "ok" && o.route === fs.route)
    .length === 1;
}

Deno.test("buildWebhookRouteTable: last good routes never break the route table invariants", async () => {
  await fc.assert(
    fc.asyncProperty(
      dirState,
      dirState,
      fc.subarray(ROUTES),
      async (before, after, untrustedList) => {
        const untrusted = new Set(untrustedList);
        const previous: readonly WebhookEndpoint[] =
          (await buildWebhookRouteTable(deps(before, new Set()), []))
            .endpoints;
        const table = await buildWebhookRouteTable(
          deps(after, untrusted),
          [],
          previous,
        );

        const routes = table.endpoints.map((e) => e.route);
        assertEquals(new Set(routes).size, routes.length, "one per route");

        const fresh = new Set<string>();
        after.forEach((_, i) => {
          if (loadsCleanly(after, i)) fresh.add(FILES[i]);
        });
        for (const file of fresh) {
          assert(
            table.endpoints.some((e) => e.file === file),
            `${file} loads, so it serves`,
          );
        }
        for (const endpoint of table.endpoints) {
          const index = FILES.indexOf(endpoint.file ?? "");
          assert(after[index].kind !== "absent", "a deleted file never serves");
          if (fresh.has(endpoint.file!)) continue;
          assert(
            previous.some((p) =>
              p.file === endpoint.file && p.route === endpoint.route &&
              JSON.stringify(p.routeFileEntry) ===
                JSON.stringify(endpoint.routeFileEntry)
            ),
            `${endpoint.file} serves only as its own last good route`,
          );
          assert(
            !untrusted.has(endpoint.route),
            "a kept route must still be trusted",
          );
        }
        assertEquals(
          table.kept.map((k) => k.file).sort(),
          table.endpoints
            .filter((e) => !fresh.has(e.file!))
            .map((e) => e.file!)
            .sort(),
          "kept lists exactly the files serving without loading this time",
        );
      },
    ),
    { numRuns: 300 },
  );
});
