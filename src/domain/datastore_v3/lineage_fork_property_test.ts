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

// A model of checkouts that spell one S3 endpoint two ways, some on a swamp
// before swamp-club#3801 (which sees only its own spelling's lineages) and
// some on this one (which sees every spelling and records `follows`). Each
// writes in turn: it restores the current lineage it can see, begins a
// lineage with one new commit, and confirms it, or crashes first. After
// each confirmation by this swamp, collection removes every lineage below
// the current one that `lineagesKeptForFork` does not keep, recording the
// ones it keeps. No commit of a confirmed lineage may then be missing from
// every remaining lineage.

import { assert } from "@std/assert";
import fc from "fast-check";
import {
  lineagesKeptForFork,
  type LineageStarted,
} from "./published_lineage.ts";
import { ReplicaRoot } from "./replica_root.ts";

const SPELLINGS = ["s3::bucket:prefix", "s3:http://proxy:1:bucket:prefix"];

interface ModelLineage {
  readonly started: LineageStarted;
  readonly commits: ReadonlySet<number>;
  readonly confirmed: boolean;
}

const arbStep = fc.record({
  spelling: fc.constantFrom(0, 1),
  upgraded: fc.boolean(),
  confirms: fc.boolean(),
});

Deno.test("lineagesKeptForFork: whatever older and upgraded swamps write under two spellings, collection never loses a confirmed lineage's commit (swamp-club#3801)", () => {
  fc.assert(
    fc.property(fc.array(arbStep, { minLength: 1, maxLength: 12 }), (steps) => {
      const lineages = new Map<number, ModelLineage>();
      const acknowledged = new Set<number>();
      // The kept records collection leaves in the control plane.
      const marked = new Set<number>();
      let fence = 0;
      for (const step of steps) {
        fence++;
        const spelling = SPELLINGS[step.spelling];
        const sees = (l: ModelLineage) =>
          step.upgraded
            ? ReplicaRoot.s3(
              step.spelling === 0 ? undefined : "http://proxy:1",
              "bucket",
              "prefix",
            ).matches(l.started.replicaRoot)
            : l.started.replicaRoot === spelling;
        let current: ModelLineage | undefined;
        for (const l of lineages.values()) {
          if (
            l.confirmed && sees(l) &&
            (current === undefined || l.started.fence > current.started.fence)
          ) {
            current = l;
          }
        }
        const commits = new Set([...(current?.commits ?? []), fence * 1000]);
        const started: LineageStarted = {
          fence,
          holder: "h",
          replicaRoot: spelling,
          startedAt: "t",
          ...(step.upgraded
            ? {
              chained: true as const,
              ...(current !== undefined
                ? { follows: current.started.fence }
                : {}),
            }
            : {}),
        };
        lineages.set(fence, { started, commits, confirmed: step.confirms });
        if (!step.confirms) continue;
        for (const commit of commits) acknowledged.add(commit);
        if (!step.upgraded) continue;
        // This swamp's collection at its first confirmation.
        const starts = new Map(
          [...lineages.values()].map((l) => [l.started.fence, l.started]),
        );
        const complete = new Set(
          [...lineages.values()].filter((l) => l.confirmed).map((l) =>
            l.started.fence
          ),
        );
        const kept = lineagesKeptForFork(starts, fence, { complete, marked });
        for (const fence of kept) marked.add(fence);
        for (const below of [...lineages.keys()]) {
          if (below < fence && !kept.has(below)) lineages.delete(below);
        }
      }
      const remaining = new Set(
        [...lineages.values()].flatMap((l) => [...l.commits]),
      );
      for (const commit of acknowledged) {
        assert(remaining.has(commit), `commit ${commit} was lost`);
      }
    }),
    { numRuns: 2000 },
  );
});
