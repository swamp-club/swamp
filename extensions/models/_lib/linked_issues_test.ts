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

import { assertEquals, assertRejects } from "@std/assert";
import {
  advanceLinked,
  linkPrOnLinked,
  type Milestone,
  milestoneEntry,
  mirrorMilestone,
  readLinkedIssues,
} from "./linked_issues.ts";
import { SwampClubClient } from "./swamp_club.ts";
import type { LinkedIssueData } from "./schemas.ts";
import {
  FAKE_SWAMP_CLUB_URL,
  FakeSwampClub,
} from "./fake_swamp_club_test_helper.ts";

const linked = (...numbers: number[]): LinkedIssueData[] =>
  numbers.map((issueNumber) => ({
    issueNumber,
    relationship: "related_to",
    title: `Issue ${issueNumber}`,
    linkedAt: "2026-09-29T00:00:00Z",
  }));

function logger() {
  const warnings: string[] = [];
  return {
    warnings,
    info: () => {},
    warning: (msg: string, props: Record<string, unknown>) => {
      warnings.push(`${msg} ${JSON.stringify(props)}`);
    },
  };
}

async function withClub(
  setup: (club: FakeSwampClub) => void,
  run: (club: FakeSwampClub, sc: SwampClubClient) => Promise<void>,
) {
  const club = new FakeSwampClub();
  club.addIssue({ number: 1 });
  setup(club);
  const restore = club.install();
  try {
    await run(club, new SwampClubClient(FAKE_SWAMP_CLUB_URL, "k", 1));
  } finally {
    restore();
  }
}

Deno.test("readLinkedIssues: is empty when the lifecycle carries none", async () => {
  assertEquals(await readLinkedIssues(undefined), []);
  assertEquals(await readLinkedIssues(() => Promise.resolve(null)), []);
});

Deno.test("advanceLinked: walks every linked issue to the target", async () => {
  await withClub((c) => {
    c.addIssue({ number: 2 });
    c.addIssue({ number: 3, status: "triaged" });
  }, async (club, sc) => {
    await advanceLinked(sc, linked(2, 3), "in_progress", logger());
    assertEquals(club.issues.get(2)!.status, "in_progress");
    assertEquals(club.issues.get(3)!.status, "in_progress");
  });
});

Deno.test("advanceLinked: raises when a linked issue cannot be moved", async () => {
  await withClub((c) => {
    c.addIssue({ number: 2 });
    c.failWhen = (call) =>
      call.method === "PATCH" ? new Response("no", { status: 500 }) : undefined;
  }, async (_club, sc) => {
    await assertRejects(
      () => advanceLinked(sc, linked(2), "triaged", logger()),
      Error,
      "linked issue #2",
    );
  });
});

Deno.test("linkPrOnLinked: records the PR on every linked issue", async () => {
  await withClub((c) => {
    c.addIssue({ number: 2 });
    c.addIssue({ number: 3 });
  }, async (club, sc) => {
    await linkPrOnLinked(sc, linked(2, 3), "https://x/pull/5", logger());
    assertEquals(club.issues.get(2)!.githubPrUrl, "https://x/pull/5");
    assertEquals(club.issues.get(3)!.githubPrNumber, 5);
  });
});

Deno.test("mirrorMilestone: warns instead of raising when a post is refused", async () => {
  await withClub((c) => {
    c.addIssue({ number: 2 });
    c.addIssue({ number: 3 });
    c.failWhen = (call) =>
      call.path.endsWith("/2/lifecycle")
        ? new Response("refused", { status: 400 })
        : undefined;
  }, async (club, sc) => {
    const log = logger();
    await mirrorMilestone(
      sc,
      linked(2, 3),
      1,
      { step: "implementation_started" },
      log,
    );
    assertEquals(club.stepsOn(3), ["implementation_started"]);
    assertEquals(log.warnings.length, 1);
  });
});

Deno.test("milestoneEntry: names the primary and carries only structured fields", () => {
  const milestones: Milestone[] = [
    { step: "implementation_started" },
    { step: "verification_passed", commit: "abc" },
    { step: "attestation_posted", attestationId: "att", commit: "abc" },
    { step: "pr_linked", url: "https://x/pull/1", attempt: 1 },
    { step: "pr_merged", url: "https://x/pull/1", attempt: 1 },
    { step: "pr_failed", url: "https://x/pull/1", attempt: 2 },
    { step: "shipped", releaseUrl: "https://x/releases/1" },
    { step: "shipped" },
    { step: "complete" },
  ];
  const allowed = new Set([
    "primaryIssueNumber",
    "commit",
    "attestationId",
    "url",
    "attempt",
    "releaseUrl",
  ]);
  for (const milestone of milestones) {
    const entry = milestoneEntry(milestone, 42);
    assertEquals(entry.step, milestone.step);
    assertEquals(entry.summary.includes("via #42"), true, entry.summary);
    assertEquals(entry.payload.primaryIssueNumber, 42);
    for (const key of Object.keys(entry.payload)) {
      assertEquals(allowed.has(key), true, `${milestone.step}: ${key}`);
    }
  }
});
