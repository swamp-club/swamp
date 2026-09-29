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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { buildNotifyMessage, model } from "./issue_lifecycle.ts";
import {
  FAKE_SWAMP_CLUB_URL,
  FakeSwampClub,
} from "./_lib/fake_swamp_club_test_helper.ts";
import type { LinkedIssueData } from "./_lib/schemas.ts";

// ---------------------------------------------------------------------------
// Harness — a lifecycle context wired to an in-memory swamp-club
// ---------------------------------------------------------------------------

const PR = "https://github.com/swamp-club/swamp/pull/501";

interface Harness {
  club: FakeSwampClub;
  // The method contexts differ only in which optional members they read.
  context: Parameters<typeof model.methods.link_issue.execute>[1];
  store: Record<string, Record<string, unknown>>;
  warnings: string[];
}

async function withLifecycle(
  issueNumber: number,
  setup: (club: FakeSwampClub, store: Harness["store"]) => void,
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const club = new FakeSwampClub();
  const store: Harness["store"] = {};
  const warnings: string[] = [];
  setup(club, store);
  const context = {
    globalArgs: {
      issueNumber,
      swampClubUrl: FAKE_SWAMP_CLUB_URL,
      swampClubApiKey: "fake-key",
    },
    logger: {
      info: () => {},
      warning: (msg: string, props: Record<string, unknown>) => {
        warnings.push(`${msg} ${JSON.stringify(props)}`);
      },
    },
    writeResource: (
      _spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) => {
      store[instance] = data;
      return Promise.resolve({ name: instance });
    },
    readResource: (instance: string) =>
      Promise.resolve(store[instance] ?? null),
  };
  const restore = club.install();
  try {
    await run({ club, context, store, warnings });
  } finally {
    restore();
  }
}

const phase = (store: Harness["store"], p: string) => {
  store["state-main"] = { phase: p, issueNumber: 1, updatedAt: "t" };
};

const carrying = (
  store: Harness["store"],
  ...issues: Partial<LinkedIssueData>[]
) => {
  store["linkedIssues-main"] = {
    issues: issues.map((i) => ({
      relationship: "related_to",
      title: "t",
      linkedAt: "t",
      ...i,
    })),
    updatedAt: "t",
  };
};

const linkedNumbers = (store: Harness["store"]) =>
  ((store["linkedIssues-main"]?.issues ?? []) as LinkedIssueData[])
    .map((i) => i.issueNumber);

// ---------------------------------------------------------------------------
// link_issue
// ---------------------------------------------------------------------------

Deno.test("link_issue: links a sibling and catches it up to the primary's status", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, status: "in_progress" });
    club.addIssue({ number: 2 });
    phase(store, "implementing");
  }, async ({ club, context, store }) => {
    await model.methods.link_issue.execute(
      { issueNumber: 2, relationship: "related_to" },
      context,
    );
    assertEquals(
      club.relationships.map((
        r,
      ) => [r.type, r.sourceIssueNumber, r.targetIssueNumber]),
      [["related_to", 1, 2]],
    );
    assertEquals(club.issues.get(2)!.status, "in_progress");
    assertEquals(linkedNumbers(store), [2]);
    assertEquals(club.stepsOn(1), ["issue_linked"]);
    assertEquals(club.stepsOn(2), ["linked"]);
  });
});

Deno.test("link_issue: a duplicate points from the linked issue to the primary", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1 });
    club.addIssue({ number: 2 });
    phase(store, "triaging");
  }, async ({ club, context }) => {
    await model.methods.link_issue.execute(
      { issueNumber: 2, relationship: "duplicate_of" },
      context,
    );
    assertEquals(
      club.relationships.map((
        r,
      ) => [r.type, r.sourceIssueNumber, r.targetIssueNumber]),
      [["duplicate_of", 2, 1]],
    );
    assertEquals(club.issues.get(2)!.status, "open");
  });
});

Deno.test("link_issue: copies an already-linked PR onto the new issue", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, status: "in_progress" });
    club.addIssue({ number: 2 });
    phase(store, "pr_open");
    store["pullRequest-main"] = { url: PR, attempt: 1, linkedAt: "t" };
  }, async ({ club, context }) => {
    await model.methods.link_issue.execute(
      { issueNumber: 2, relationship: "related_to" },
      context,
    );
    assertEquals(club.issues.get(2)!.githubPrUrl, PR);
    assertEquals(club.issues.get(2)!.githubPrNumber, 501);
  });
});

Deno.test("link_issue: linking the same issue again changes nothing upstream", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, status: "triaged" });
    club.addIssue({ number: 2 });
    phase(store, "classified");
  }, async ({ club, context, store }) => {
    const args = { issueNumber: 2, relationship: "related_to" as const };
    await model.methods.link_issue.execute(args, context);
    await model.methods.link_issue.execute(args, context);
    assertEquals(linkedNumbers(store), [2]);
    assertEquals(club.relationships.length, 1);
    assertEquals(club.issues.get(2)!.status, "triaged");
  });
});

Deno.test("link_issue: reopens a closed issue and walks it forward", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, status: "triaged" });
    club.addIssue({ number: 2, status: "closed" });
    phase(store, "plan_generated");
  }, async ({ club, context }) => {
    await model.methods.link_issue.execute(
      { issueNumber: 2, relationship: "related_to" },
      context,
    );
    assertEquals(club.issues.get(2)!.status, "triaged");
    assertStringIncludes(club.entriesOn(2)[0].summary, "reopened");
  });
});

Deno.test("link_issue: refuses the primary itself, a shipped issue, and a security pairing", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1 });
    club.addIssue({ number: 2, status: "shipped" });
    club.addIssue({ number: 3, type: "security" });
    phase(store, "triaging");
  }, async ({ club, context, store }) => {
    const link = (issueNumber: number) =>
      model.methods.link_issue.execute(
        { issueNumber, relationship: "related_to" },
        context,
      );
    await assertRejects(() => link(1), Error, "cannot be linked to itself");
    await assertRejects(() => link(2), Error, "already shipped");
    await assertRejects(() => link(3), Error, "security issue");
    assertEquals(club.relationships, []);
    assertEquals(store["linkedIssues-main"], undefined);
  });
});

Deno.test("link_issue: warns when the issue is already tied to another unshipped issue", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1 });
    club.addIssue({ number: 2 });
    club.addIssue({ number: 9, status: "in_progress" });
    club.relationships.push({
      id: "r",
      type: "related_to",
      sourceIssueNumber: 9,
      targetIssueNumber: 2,
    });
    phase(store, "triaging");
  }, async ({ context, warnings }) => {
    await model.methods.link_issue.execute(
      { issueNumber: 2, relationship: "related_to" },
      context,
    );
    assertEquals(warnings.some((w) => w.includes("another")), true);
  });
});

// ---------------------------------------------------------------------------
// Linked issues move with the primary
// ---------------------------------------------------------------------------

Deno.test("triage: moves linked issues to triaged with the primary", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1 });
    club.addIssue({ number: 2 });
    carrying(store, { issueNumber: 2 });
  }, async ({ club, context }) => {
    await model.methods.triage.execute(
      { type: "feature", confidence: "high", reasoning: "r" },
      context,
    );
    assertEquals(club.issues.get(2)!.status, "triaged");
    assertEquals(club.stepsOn(2), []);
  });
});

Deno.test("approve: moves linked issues to in_progress with the primary", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, status: "triaged" });
    club.addIssue({ number: 2, status: "triaged" });
    carrying(store, { issueNumber: 2 });
    store["plan-main"] = { version: 1, summary: "s", steps: [] };
  }, async ({ club, context }) => {
    await model.methods.approve.execute({}, context);
    assertEquals(club.issues.get(2)!.status, "in_progress");
  });
});

Deno.test("link_pr: records the PR on the primary and every linked issue", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, status: "in_progress" });
    club.addIssue({ number: 2, status: "in_progress" });
    carrying(store, { issueNumber: 2 });
  }, async ({ club, context }) => {
    await model.methods.link_pr.execute({ url: PR }, context);
    assertEquals(club.issues.get(1)!.githubPrUrl, PR);
    assertEquals(club.issues.get(2)!.githubPrUrl, PR);
    assertEquals(club.stepsOn(2), ["pr_linked"]);
    assertStringIncludes(club.entriesOn(2)[0].summary, "via #1");
  });
});

Deno.test("link_pr: a failed PR link on a linked issue fails before the entry posts", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, status: "in_progress" });
    club.addIssue({ number: 2, status: "in_progress" });
    carrying(store, { issueNumber: 2 });
    club.failWhen = (call) =>
      call.method === "PATCH" && call.path.endsWith("/2")
        ? new Response("no", { status: 500 })
        : undefined;
  }, async ({ club, context }) => {
    await assertRejects(
      () => model.methods.link_pr.execute({ url: PR }, context),
      Error,
      "linked issue #2",
    );
    assertEquals(club.stepsOn(1), []);
  });
});

Deno.test("ship: ships linked issues and keeps the primary's PATCH unchanged", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, status: "in_progress", githubPrUrl: PR });
    club.addIssue({ number: 2, status: "in_progress", githubPrUrl: PR });
    carrying(store, { issueNumber: 2 });
  }, async ({ club, context }) => {
    await model.methods.ship.execute(
      { releaseUrl: "https://x/r/1", releaseNotes: "private notes" },
      context,
    );
    const primaryPatch = club.calls.filter((c) =>
      c.method === "PATCH" && c.path.endsWith("/issues/1")
    );
    assertEquals(primaryPatch.map((c) => c.body), [{ status: "shipped" }]);
    assertEquals(club.issues.get(2)!.status, "shipped");
    assertEquals(club.issues.get(2)!.githubPrUrl, PR);
    assertEquals(club.stepsOn(2), ["shipped"]);
    assertEquals(
      JSON.stringify(club.entriesOn(2)).includes("private notes"),
      false,
    );
  });
});

Deno.test("complete: ships linked issues and keeps the primary's PATCH unchanged", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, status: "in_progress" });
    club.addIssue({ number: 2, status: "triaged" });
    carrying(store, { issueNumber: 2 });
  }, async ({ club, context }) => {
    await model.methods.complete.execute({}, context);
    const primaryPatch = club.calls.filter((c) =>
      c.method === "PATCH" && c.path.endsWith("/issues/1")
    );
    assertEquals(primaryPatch.map((c) => c.body), [{ status: "shipped" }]);
    assertEquals(club.issues.get(2)!.status, "shipped");
  });
});

Deno.test("verification: only the passing result reaches linked issues", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, status: "in_progress" });
    club.addIssue({ number: 2, status: "in_progress" });
    carrying(store, { issueNumber: 2 });
  }, async ({ club, context }) => {
    await model.methods.verify.execute({ commit: "abc", branch: "b" }, context);
    await model.methods.verification_failed.execute({
      workflowRunId: "w",
      commit: "abc",
      branch: "b",
      failureReason: "secret detail",
    }, context);
    await model.methods.verification_passed.execute({
      workflowRunId: "w",
      commit: "def",
      branch: "b",
      steps: [],
    }, context);
    assertEquals(club.stepsOn(2), ["verification_passed"]);
  });
});

Deno.test("pr_failed: the linked issue hears the PR failed but not why", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, status: "in_progress" });
    club.addIssue({ number: 2, status: "in_progress" });
    carrying(store, { issueNumber: 2 });
    store["pullRequest-main"] = { url: PR, attempt: 1, linkedAt: "t" };
  }, async ({ club, context }) => {
    await model.methods.pr_failed.execute(
      { reason: "internal-only failure detail" },
      context,
    );
    assertEquals(club.stepsOn(2), ["pr_failed"]);
    assertEquals(
      JSON.stringify(club.entriesOn(2)).includes("internal-only"),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// notify and summarize
// ---------------------------------------------------------------------------

Deno.test("notify: thanks an external linked author and skips a team member", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, authorUsername: "lead", authorId: "u-lead" });
    club.addIssue({ number: 2 });
    club.addIssue({ number: 3 });
    club.roster = [{ userId: "u-lead", username: "lead" }, {
      userId: "u-team",
      username: "teammate",
    }];
    carrying(
      store,
      { issueNumber: 2, author: "outsider", authorId: "u-out" },
      { issueNumber: 3, author: "teammate", authorId: "u-team" },
    );
    store["plan-main"] = { summary: "restricted plan summary" };
  }, async ({ club, context }) => {
    await model.methods.notify.execute({}, context);
    assertEquals(club.ripples.map((r) => r.issue), [2]);
    assertStringIncludes(club.ripples[0].body, "@outsider");
    assertEquals(club.stepsOn(2), ["contributor_notified"]);
    assertEquals(club.stepsOn(3), []);
    assertEquals(club.ripples[0].body.includes("restricted plan"), false);
  });
});

Deno.test("summarize: requires exactly one outcome per linked issue", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1 });
    carrying(store, { issueNumber: 2 }, { issueNumber: 3 });
  }, async ({ context }) => {
    const base = {
      originalProblem: "p",
      deliveredOutcome: "d",
      outcomeMet: true,
    };
    const outcome = (issueNumber: number) => ({
      issueNumber,
      deliveredOutcome: "d",
      outcomeMet: true,
    });
    await assertRejects(
      () => model.methods.summarize.execute(base, context),
      Error,
      "#2, #3",
    );
    await assertRejects(
      () =>
        model.methods.summarize.execute({
          ...base,
          linkedOutcomes: [outcome(2), outcome(3), outcome(4)],
        }, context),
      Error,
      "#4",
    );
    await assertRejects(
      () =>
        model.methods.summarize.execute({
          ...base,
          linkedOutcomes: [outcome(2), outcome(2), outcome(3)],
        }, context),
      Error,
      "more than one",
    );
  });
});

Deno.test("summarize: records each linked issue's outcome on that issue", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1 });
    club.addIssue({ number: 2 });
    carrying(store, { issueNumber: 2 });
  }, async ({ club, context, store }) => {
    await model.methods.summarize.execute({
      originalProblem: "p",
      deliveredOutcome: "d",
      outcomeMet: true,
      linkedOutcomes: [{
        issueNumber: 2,
        deliveredOutcome: "fixed too",
        outcomeMet: false,
      }],
    }, context);
    assertEquals(club.stepsOn(2), ["session_summarized"]);
    assertStringIncludes(club.entriesOn(2)[0].summary, "NOT met: fixed too");
    assertEquals(
      (store["summary-main"].linkedOutcomes as unknown[]).length,
      1,
    );
  });
});

Deno.test("summarize: needs no linkedOutcomes when nothing is linked", async () => {
  await withLifecycle(1, (club) => {
    club.addIssue({ number: 1 });
  }, async ({ context, store }) => {
    await model.methods.summarize.execute({
      originalProblem: "p",
      deliveredOutcome: "d",
      outcomeMet: true,
    }, context);
    assertEquals(store["state-main"].phase, "done");
    assertEquals("linkedOutcomes" in store["summary-main"], false);
  });
});

// ---------------------------------------------------------------------------
// unlink_issue
// ---------------------------------------------------------------------------

Deno.test("unlink_issue: drops the issue and its relationship and leaves its status", async () => {
  await withLifecycle(1, (club, store) => {
    club.addIssue({ number: 1, status: "in_progress" });
    club.addIssue({ number: 2, status: "in_progress" });
    club.addIssue({ number: 3, status: "in_progress" });
    club.relationships.push({
      id: "r1",
      type: "related_to",
      sourceIssueNumber: 1,
      targetIssueNumber: 2,
    });
    carrying(store, { issueNumber: 2 }, { issueNumber: 3 });
    phase(store, "implementing");
  }, async ({ club, context, store }) => {
    await model.methods.unlink_issue.execute(
      { issueNumber: 2, reason: "not actually fixed by this" },
      context,
    );
    assertEquals(linkedNumbers(store), [3]);
    assertEquals(club.relationships, []);
    assertEquals(club.issues.get(2)!.status, "in_progress");
    assertEquals(club.stepsOn(1), ["issue_unlinked"]);
    assertEquals(club.stepsOn(2), ["unlinked"]);
  });
});

Deno.test("unlink_issue: refuses an issue that is not linked", async () => {
  await withLifecycle(1, (club) => {
    club.addIssue({ number: 1 });
  }, async ({ context }) => {
    await assertRejects(
      () =>
        model.methods.unlink_issue.execute(
          { issueNumber: 2, reason: "r" },
          context,
        ),
      Error,
      "not linked",
    );
  });
});

// ---------------------------------------------------------------------------
// mark_duplicate
// ---------------------------------------------------------------------------

Deno.test("mark_duplicate: ships the duplicate with the PR from the canonical's entries", async () => {
  await withLifecycle(5, (club) => {
    club.addIssue({ number: 5 });
    club.addIssue({
      number: 9,
      status: "shipped",
      title: "Secret canonical title",
    });
    club.addEntry(9, "pr_merged", { url: PR });
  }, async ({ club, context, store }) => {
    await model.methods.mark_duplicate.execute(
      { of: 9, reason: "same crash" },
      context,
    );
    const m = club.issues.get(5)!;
    assertEquals(m.status, "shipped");
    assertEquals(m.githubPrUrl, PR);
    assertEquals(
      club.relationships.map((
        r,
      ) => [r.type, r.sourceIssueNumber, r.targetIssueNumber]),
      [["duplicate_of", 5, 9]],
    );
    assertEquals(store["state-main"].phase, "notify");
    assertEquals(store["duplicate-main"].canonicalPrUrl, PR);
    assertEquals(club.stepsOn(5), ["duplicate_shipped"]);
    assertEquals(JSON.stringify(club.entriesOn(5)).includes("Secret"), false);
    assertEquals(club.stepsOn(9), ["pr_merged"]);

    // The PR is on the issue before it ships, so swamp-club's shipped
    // notification carries it.
    const patches = club.calls.filter((c) => c.method === "PATCH");
    const prAt = patches.findIndex((c) => "githubPrUrl" in (c.body ?? {}));
    const shipAt = patches.findIndex((c) => c.body?.status === "shipped");
    assertEquals(prAt < shipAt, true);
  });
});

Deno.test("mark_duplicate: prefers the PR recorded on the canonical issue over the argument", async () => {
  await withLifecycle(5, (club) => {
    club.addIssue({ number: 5 });
    club.addIssue({ number: 9, status: "shipped", githubPrUrl: PR });
  }, async ({ club, context, warnings }) => {
    await model.methods.mark_duplicate.execute(
      { of: 9, reason: "r", prUrl: "https://github.com/o/r/pull/1" },
      context,
    );
    assertEquals(club.issues.get(5)!.githubPrUrl, PR);
    assertEquals(warnings.some((w) => w.includes("not used")), true);
  });
});

Deno.test("mark_duplicate: uses the prUrl argument when swamp-club has none", async () => {
  await withLifecycle(5, (club) => {
    club.addIssue({ number: 5 });
    club.addIssue({ number: 9, status: "shipped" });
  }, async ({ club, context }) => {
    await model.methods.mark_duplicate.execute(
      { of: 9, reason: "r", prUrl: PR },
      context,
    );
    assertEquals(club.issues.get(5)!.githubPrUrl, PR);
  });
});

Deno.test("mark_duplicate: ships without a PR, and says so, when none can be found", async () => {
  await withLifecycle(5, (club) => {
    club.addIssue({ number: 5 });
    club.addIssue({ number: 9, status: "shipped" });
  }, async ({ club, context, warnings }) => {
    await model.methods.mark_duplicate.execute({ of: 9, reason: "r" }, context);
    assertEquals(club.issues.get(5)!.status, "shipped");
    assertEquals(club.issues.get(5)!.githubPrUrl, undefined);
    assertStringIncludes(club.entriesOn(5)[0].summary, "no PR was found");
    assertEquals(warnings.some((w) => w.includes("No PR was found")), true);
  });
});

Deno.test("mark_duplicate: reopens a closed duplicate and ships it", async () => {
  await withLifecycle(5, (club) => {
    club.addIssue({ number: 5, status: "closed" });
    club.addIssue({ number: 9, status: "shipped", githubPrUrl: PR });
  }, async ({ club, context }) => {
    await model.methods.mark_duplicate.execute({ of: 9, reason: "r" }, context);
    assertEquals(club.issues.get(5)!.status, "shipped");
    assertStringIncludes(club.entriesOn(5)[0].summary, "reopened");
  });
});

Deno.test("mark_duplicate: sends an in-flight canonical to link_issue and writes nothing", async () => {
  await withLifecycle(5, (club) => {
    club.addIssue({ number: 5 });
    club.addIssue({ number: 9, status: "in_progress" });
  }, async ({ club, context, store }) => {
    await assertRejects(
      () =>
        model.methods.mark_duplicate.execute({ of: 9, reason: "r" }, context),
      Error,
      "link_issue issue-9 --input issueNumber=5 --input relationship=duplicate_of",
    );
    assertEquals(club.calls.some((c) => c.method !== "GET"), false);
    assertEquals(store["state-main"], undefined);
  });
});

Deno.test("mark_duplicate: refuses a canonical issue that was closed without shipping", async () => {
  await withLifecycle(5, (club) => {
    club.addIssue({ number: 5 });
    club.addIssue({ number: 9, status: "closed" });
  }, async ({ context }) => {
    await assertRejects(
      () =>
        model.methods.mark_duplicate.execute({ of: 9, reason: "r" }, context),
      Error,
      "closed without shipping",
    );
  });
});

Deno.test("mark_duplicate: surfaces swamp-club's refusal of a duplicate chain", async () => {
  await withLifecycle(5, (club) => {
    club.addIssue({ number: 5 });
    club.addIssue({ number: 9, status: "shipped" });
    club.addIssue({ number: 7, status: "shipped" });
    club.relationships.push({
      id: "r",
      type: "duplicate_of",
      sourceIssueNumber: 9,
      targetIssueNumber: 7,
    });
  }, async ({ club, context }) => {
    await assertRejects(
      () =>
        model.methods.mark_duplicate.execute({ of: 9, reason: "r" }, context),
      Error,
      "#7",
    );
    assertEquals(club.issues.get(5)!.status, "open");
  });
});

Deno.test("mark_duplicate: the prUrl argument must be an http(s) URL", () => {
  const args = model.methods.mark_duplicate.arguments;
  assertEquals(
    args.safeParse({ of: 9, reason: "r", prUrl: "javascript:alert(1)" })
      .success,
    false,
  );
  assertEquals(
    args.safeParse({ of: 9, reason: "r", prUrl: PR }).success,
    true,
  );
});

Deno.test("buildNotifyMessage: thanks a duplicate's reporter with the canonical issue and PR", () => {
  const message = buildNotifyMessage("reporter", null, null, {
    canonicalIssueNumber: 9,
    canonicalTitle: "Secret canonical title",
    canonicalPrUrl: PR,
    reason: "r",
    markedAt: "t",
  });
  assertStringIncludes(message, "@reporter");
  assertStringIncludes(message, "#9");
  assertStringIncludes(message, PR);
  assertEquals(message.includes("Secret"), false);
});
