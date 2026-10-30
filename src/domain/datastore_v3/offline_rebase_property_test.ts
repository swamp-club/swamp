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
import type { Commit } from "./commit.ts";
import { LATEST_WINDOW_MS } from "./latest_choice.ts";
import { type RebasedCommit, rebaseOfflineCommits } from "./offline_rebase.ts";
import {
  encodeMetadata,
  fixtureChanges,
  fixtureCommit,
  FixtureHistory,
  metadata,
  saveOps,
  toOps,
} from "./offline_rebase_test_helpers.ts";

const T0 = Date.parse("2026-10-30T10:00:00.000Z");
const MINUTE = 60_000;
const NAMES: readonly string[] = ["a", "b"];
const iso = (ms: number) => new Date(ms).toISOString();

const arbOnline = fc.array(
  fc.record({
    name: fc.constantFrom(...NAMES),
    minute: fc.integer({ min: -60, max: 120 }),
  }),
  { maxLength: 6 },
);

const arbOffline = fc.array(
  fc.record({
    name: fc.constantFrom(...NAMES),
    minute: fc.integer({ min: -60, max: 120 }),
    offsetMinutes: fc.integer({ min: -15, max: 15 }),
    append: fc.boolean(),
  }),
  { minLength: 1, maxLength: 5 },
);

type OnlineSpec = { name: string; minute: number }[];
type OfflineSpec = {
  name: string;
  minute: number;
  offsetMinutes: number;
  append: boolean;
}[];

/** What the oracle knows of each write, by its origin tag. */
interface Write {
  readonly observedAt: number;
}

/** Applies the online writes, each committed at its own minute. */
async function landOnline(
  history: FixtureHistory,
  online: OnlineSpec,
  writes: Map<string, Write>,
  prefix: string,
): Promise<void> {
  for (const [index, spec] of online.entries()) {
    const version = history.partition.highWater(spec.name) + 1;
    const origin = `${prefix}${index}`;
    const at = T0 + spec.minute * MINUTE;
    history.append(fixtureCommit({
      seq: history.nextSeq,
      txnId: `online-${origin}`,
      at: iso(at),
      ops: await saveOps({
        name: spec.name,
        version,
        text: origin,
        tags: { origin },
        createdAt: iso(at),
      }),
    }));
    writes.set(origin, { observedAt: at });
  }
}

/**
 * A member's offline commits, numbered from its copy's high-water marks and
 * its own queue, as the outbox numbers them.
 */
async function offlineCommits(
  member: string,
  copyHighWater: (name: string) => number,
  specs: OfflineSpec,
  writes: Map<string, Write>,
): Promise<Commit[]> {
  /** Each name's last queued version: its number, origin and createdAt. */
  const queued = new Map<
    string,
    { version: number; origin: string; createdAt: string }
  >();
  const commits: Commit[] = [];
  for (const [index, spec] of specs.entries()) {
    const origin = `${member}${index}`;
    const executedAt = T0 + spec.minute * MINUTE;
    const offset = spec.offsetMinutes * MINUTE;
    const last = queued.get(spec.name);
    let ops;
    if (spec.append && last !== undefined) {
      // An append re-records its version's metadata as it was loaded.
      const meta = {
        ...metadata(spec.name, last.version),
        tags: { type: "resource", origin: last.origin },
        createdAt: last.createdAt,
      };
      ops = await toOps(
        fixtureChanges().writeVersion({ kind: "data.append" }, {
          name: spec.name,
          version: last.version,
          metadata: meta,
          metadataBytes: encodeMetadata(meta),
          raw: new TextEncoder().encode(`${origin} appended`),
        }),
      );
    } else {
      const version = Math.max(copyHighWater(spec.name), last?.version ?? 0) +
        1;
      // The writer's own clock, uncorrected.
      queued.set(spec.name, { version, origin, createdAt: iso(executedAt) });
      ops = await saveOps({
        name: spec.name,
        version,
        text: origin,
        tags: { origin },
        createdAt: iso(executedAt),
      });
      writes.set(origin, { observedAt: executedAt + offset });
    }
    commits.push(fixtureCommit({
      seq: index + 1,
      txnId: `offline-${origin}`,
      at: iso(executedAt),
      executedAt: iso(executedAt),
      clockOffsetMs: offset,
      ops,
    }));
  }
  return commits;
}

/** The origin of the content a name's latest holds. */
function latestOrigin(
  history: FixtureHistory,
  name: string,
): string | undefined {
  const latest = history.partition.latest(name);
  if (latest === undefined) return undefined;
  return history.lookups().content(name, latest)?.metadata.tags.origin;
}

/** Lands a flush, checking bindings and partition rules on every commit. */
async function flush(
  history: FixtureHistory,
  commits: Commit[],
): Promise<RebasedCommit[]> {
  const results = await rebaseOfflineCommits(
    commits,
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  for (const result of results) {
    await history.land(result, iso(T0 + 600 * MINUTE));
  }
  return results;
}

Deno.test("rebaseOfflineCommits: never renumbers or changes a committed version, and every rebased commit lands", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbOnline,
      fc.nat(6),
      arbOffline,
      async (online, split, offline) => {
        const history = new FixtureHistory();
        const writes = new Map<string, Write>();
        const cut = Math.min(split, online.length);
        await landOnline(history, online.slice(0, cut), writes, "o");
        const copy = new Map(
          NAMES.map((n) => [n, history.partition.highWater(n)]),
        );
        await landOnline(history, online.slice(cut), writes, "p");
        const before = new Map<string, string | undefined>();
        for (const name of NAMES) {
          for (const version of history.partition.versions(name)) {
            for (const file of ["raw", "metadata.yaml"] as const) {
              const key = fixtureChanges().dataKey(name, version, file);
              before.set(key.toString(), history.partition.record(key)?.sha256);
            }
          }
        }
        const live = new Map(
          NAMES.map((n) => [n, history.partition.versions(n)]),
        );
        const commits = await offlineCommits(
          "m",
          (name) => copy.get(name) ?? 0,
          offline,
          writes,
        );
        const results = await flush(history, commits);
        for (const result of results) assert(result.kind !== "rejected");
        for (const [key, sha] of before) {
          assertEquals(
            history.partition.record(
              fixtureChanges().dataKey(
                key.split("/").at(-3) as string,
                Number(key.split("/").at(-2)),
                key.endsWith("raw") ? "raw" : "metadata.yaml",
              ),
            )?.sha256,
            sha,
          );
        }
        for (const name of NAMES) {
          for (const version of live.get(name) ?? []) {
            assert(history.partition.versions(name).includes(version));
          }
        }
        // Commits rebased together never share a version.
        for (const name of NAMES) {
          const landed = results.flatMap((r) =>
            r.kind === "rebased"
              ? r.renumbered.filter((v) => v.name === name).map((v) => v.to)
              : []
          );
          assertEquals(new Set(landed).size, landed.length);
        }
      },
    ),
    { numRuns: 150 },
  );
});

Deno.test("rebaseOfflineCommits: latest is the highest live version and holds the newest observation, within the window", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbOnline,
      arbOffline,
      async (online, offline) => {
        const history = new FixtureHistory();
        const writes = new Map<string, Write>();
        const copy = new Map(NAMES.map((n) => [n, 0]));
        await landOnline(history, online, writes, "o");
        // The oracle: process the offline saves in order.
        const current = new Map<string, number | undefined>();
        for (const name of NAMES) {
          const origin = latestOrigin(history, name);
          current.set(
            name,
            origin === undefined ? undefined : writes.get(origin)?.observedAt,
          );
        }
        const expected = new Map<string, string | undefined>(
          NAMES.map((n) => [n, latestOrigin(history, n)]),
        );
        const commits = await offlineCommits(
          "m",
          (name) => copy.get(name) ?? 0,
          offline,
          writes,
        );
        for (const [index, spec] of offline.entries()) {
          const origin = `m${index}`;
          const write = writes.get(origin);
          if (write === undefined) continue;
          const now = current.get(spec.name);
          if (now === undefined || write.observedAt - now > LATEST_WINDOW_MS) {
            current.set(spec.name, write.observedAt);
            expected.set(spec.name, origin);
          }
        }
        await flush(history, commits);
        for (const name of NAMES) {
          const versions = history.partition.versions(name);
          assertEquals(
            history.partition.latest(name),
            versions.length === 0 ? undefined : Math.max(...versions),
          );
          assertEquals(latestOrigin(history, name), expected.get(name));
        }
      },
    ),
    { numRuns: 150 },
  );
});

Deno.test("rebaseOfflineCommits: two members flushing in either order never let latest fall more than the window behind the newest observation", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbOnline,
      arbOffline,
      arbOffline,
      fc.boolean(),
      async (online, first, second, swap) => {
        const history = new FixtureHistory();
        const writes = new Map<string, Write>();
        await landOnline(history, online, writes, "o");
        const copy = new Map(
          NAMES.map((n) => [n, history.partition.highWater(n)]),
        );
        // Online writes follow version order; only offline ones are judged
        // by when they were observed, against the latest they found.
        const before = new Map(NAMES.map((n) => [n, latestOrigin(history, n)]));
        const a = await offlineCommits(
          "a",
          (n) => copy.get(n) ?? 0,
          first,
          writes,
        );
        const b = await offlineCommits(
          "b",
          (n) => copy.get(n) ?? 0,
          second,
          writes,
        );
        for (const commits of swap ? [b, a] : [a, b]) {
          await flush(history, commits);
        }
        for (const name of NAMES) {
          const candidates = [...writes.entries()]
            .filter(([origin]) =>
              origin.startsWith("o")
                ? origin === before.get(name)
                : (origin.startsWith("a") ? first : second)[
                  Number(origin.slice(1))
                ].name === name
            )
            .map(([, write]) => write.observedAt);
          if (candidates.length === 0) continue;
          const origin = latestOrigin(history, name);
          assert(origin !== undefined);
          const observed = writes.get(origin)?.observedAt;
          assert(observed !== undefined, `latest ${origin} is no known write`);
          assert(observed >= Math.max(...candidates) - LATEST_WINDOW_MS);
        }
      },
    ),
    { numRuns: 150 },
  );
});
