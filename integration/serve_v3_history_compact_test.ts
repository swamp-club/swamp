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
import { waitFor } from "@swamp-club/swamp-testing";
import {
  modelCommit,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  type V3DatastoreConfig,
  v3DatastoreConfigOf,
  v3DatastoreFor,
  V3MaintenanceTimer,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";
import { startProcessHost } from "./process_host.ts";
import {
  createServeCtx,
  type Frame,
  grant,
  sendRequest,
} from "./serve_request_harness.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

const COMMITS = 3_100;

type ServeHostRequest =
  | {
    kind: "open";
    repoDir: string;
    location: V3DatastoreConfig;
    ctx: ConnectionContext;
  }
  | { kind: "compact"; id: string; waitMs?: number }
  /** a tick whose chunk sweep is held until released */
  | { kind: "tick" }
  | { kind: "releaseTick" }
  | { kind: "close" };

type ServeHostMessage =
  | { opened: true }
  | { asked: string }
  | { ticking: true }
  | { answered: string; frame: Frame }
  | { order: readonly string[] }
  | { closed: true }
  | { failed: string };

/** swamp serve leading a v3 datastore: its lifetime hold and maintenance timer */
function serveHost(
  post: (message: ServeHostMessage) => void,
): (request: ServeHostRequest) => void {
  let timer: V3MaintenanceTimer | undefined;
  let ctx: ConnectionContext | undefined;
  let waitMs: number | undefined;
  let tickGate: PromiseWithResolvers<void> | undefined;
  const order: string[] = [];
  const handled = (work: Promise<void>) =>
    work.catch((error) => post({ failed: String(error?.stack ?? error) }));
  return (request) => {
    switch (request.kind) {
      case "open":
        handled((async () => {
          await holdV3Writer(request.location, request.repoDir, {
            retakeLost: true,
          });
          const handle = v3DatastoreFor(request.repoDir, request.location);
          const fence = handle.commitStore.writerFence();
          const appends: Promise<unknown>[] = [];
          for (let seq = 1; seq <= COMMITS; seq++) {
            appends.push(handle.commitStore.append(
              modelCommit(seq, [versionOp("seeded", seq)], {
                txnId: crypto.randomUUID(),
                at: "2020-01-01T00:00:00.000Z",
                ...(fence === undefined ? {} : { fence }),
              }),
            ));
          }
          await Promise.all(appends);
          const collectChunks = handle.collectChunks.bind(handle);
          handle.collectChunks = async (...args) => {
            if (tickGate !== undefined) {
              post({ ticking: true });
              await tickGate.promise;
              order.push("tick");
            }
            return await collectChunks(...args);
          };
          const compactHistoryNow = handle.compactHistoryNow.bind(handle);
          handle.compactHistoryNow = (...args) => {
            order.push("compaction");
            return compactHistoryNow(...args);
          };
          const maintenance = new V3MaintenanceTimer(handle, 60 * 60 * 1000);
          timer = maintenance;
          maintenance.start();
          ctx = {
            ...request.ctx,
            v3HistoryCompaction: {
              compactNow: (budgetMs: number, signal: AbortSignal) => {
                post({ asked: "compactNow" });
                return maintenance.compactNow(budgetMs, signal, waitMs);
              },
            },
          };
          post({ opened: true });
        })());
        return;
      case "compact":
        waitMs = request.waitMs;
        handled((async () => {
          const frames = await sendRequest(ctx!, {
            type: "datastore.history.compact",
            id: request.id,
          });
          post({ answered: request.id, frame: frames[0] });
          post({ order: [...order] });
        })());
        return;
      case "tick":
        tickGate = Promise.withResolvers<void>();
        timer!.tick();
        return;
      case "releaseTick":
        tickGate?.resolve();
        tickGate = undefined;
        return;
      case "close":
        handled((async () => {
          await timer?.stop();
          await closeV3Datastores();
          post({ closed: true });
        })());
        return;
    }
  };
}

Deno.test({
  name:
    "serve datastore.history.compact: the leader folds its history then finds nothing due, waits out a tick in flight, and answers busy past a short wait",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos) => {
      await closeV3Datastores();
      const messages: ServeHostMessage[] = [];
      const serve = startProcessHost<ServeHostRequest, ServeHostMessage>(
        "serve",
        serveHost,
        (message) => messages.push(message),
      );
      const seen = async <T extends ServeHostMessage>(
        test: (message: ServeHostMessage) => message is T,
        description: string,
        from = 0,
      ): Promise<T> => {
        await waitFor(
          () =>
            messages.slice(from).some(test) ||
            messages.some((m) => "failed" in m),
          description,
          { timeoutMs: 120_000 },
        );
        const failed = messages.find((m) => "failed" in m);
        if (failed !== undefined && "failed" in failed) {
          throw new Error(`serve failed: ${failed.failed}`);
        }
        return messages.slice(from).find(test)!;
      };
      const answer = async (id: string, waitMs?: number) => {
        const from = messages.length;
        serve.postMessage({ kind: "compact", id, waitMs });
        return (await seen(
          (m): m is { answered: string; frame: Frame } =>
            "answered" in m && m.answered === id,
          `the answer to ${id}`,
          from,
        )).frame;
      };
      try {
        const location = await v3DatastoreConfigOf(
          repos.repoA,
          repos.a.datastoreConfig,
        );
        serve.postMessage({
          kind: "open",
          repoDir: repos.repoA,
          location,
          ctx: createServeCtx(repos.serveRepo, [
            grant({
              actions: ["admin"],
              resource: { kind: "access", pattern: "*" },
            }),
          ]),
        });
        await seen(
          (m): m is { opened: true } => "opened" in m,
          "serve opened",
        );

        const first = await answer("first");
        assertEquals(
          first.type,
          "datastore.history.compact",
          JSON.stringify(first),
        );
        const folded = first.payload?.data as Record<string, unknown>;
        assertEquals(folded.applies, true);
        assertEquals(folded.outcome, "compacted");
        assert((folded.compacted as number) >= COMMITS - 2_500);

        const second = await answer("second");
        assertEquals(second.payload?.data, {
          applies: true,
          outcome: "not_due",
          eligibleCommits: 0,
          minCommits: 500,
          retainCommits: 2_500,
        });

        const ticking = messages.length;
        serve.postMessage({ kind: "tick" });
        await seen(
          (m): m is { ticking: true } => "ticking" in m,
          "a tick in flight",
          ticking,
        );
        const busy = await answer("busy", 10);
        assertEquals(busy.type, "error");
        assertEquals(busy.error?.code, "maintenance_busy");

        const asked = messages.length;
        serve.postMessage({ kind: "compact", id: "waits" });
        await seen(
          (m): m is { asked: string } => "asked" in m,
          "the request waiting on the tick",
          asked,
        );
        serve.postMessage({ kind: "releaseTick" });
        const waited = (await seen(
          (m): m is { answered: string; frame: Frame } =>
            "answered" in m && m.answered === "waits",
          "the answer once the tick ended",
          asked,
        )).frame;
        assertEquals(waited.type, "datastore.history.compact");
        assertEquals(
          (waited.payload?.data as Record<string, unknown>).outcome,
          "not_due",
        );
        const order = await seen(
          (m): m is { order: readonly string[] } => "order" in m,
          "the work the waiting request saw",
          messages.indexOf(
            messages.find((m) => "answered" in m && m.answered === "waits")!,
          ),
        );
        assertEquals(order.order.slice(-2), ["tick", "compaction"]);
      } finally {
        const closing = messages.length;
        serve.postMessage({ kind: "close" });
        await waitFor(
          () =>
            messages.slice(closing).some((m) => "closed" in m || "failed" in m),
          "serve closed",
          { timeoutMs: 60_000 },
        ).catch(() => {});
        serve.terminate();
        await closeV3Datastores();
      }
    });
  },
});
