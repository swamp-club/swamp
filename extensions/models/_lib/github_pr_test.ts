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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertGitHubPullUrl,
  classifyPrSnapshot,
  type CommandResult,
  fetchPrSnapshot,
  type GhRunner,
  type PrSnapshot,
} from "./github_pr.ts";

const URL = "https://github.com/swamp-club/swamp/pull/7";

const open: PrSnapshot = {
  state: "OPEN",
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "",
  labels: [],
  failedChecks: [],
};

const ok = (stdout: unknown, code = 0): CommandResult => ({
  code,
  stdout: JSON.stringify(stdout),
  stderr: "",
});

/** Answers gh by its subcommand and records every call. */
function fakeGh(answers: {
  view: CommandResult;
  required?: CommandResult;
  all?: CommandResult;
}): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = (args) => {
    calls.push(args);
    if (args[1] === "view") return Promise.resolve(answers.view);
    const answer = args.includes("--required") ? answers.required : answers.all;
    if (!answer) throw new Error(`unexpected gh call ${args.join(" ")}`);
    return Promise.resolve(answer);
  };
  return { run, calls };
}

Deno.test("classifyPrSnapshot: a mergeable open PR with no failures is pending", () => {
  assertEquals(classifyPrSnapshot(open, ["hold"]).outcome, "pending");
});

Deno.test("classifyPrSnapshot: UNKNOWN mergeability is pending, not a conflict", () => {
  assertEquals(
    classifyPrSnapshot(
      { ...open, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
      ["hold"],
    ).outcome,
    "pending",
  );
});

Deno.test("classifyPrSnapshot: maps each GitHub state to its outcome", () => {
  const cases: Array<[Partial<PrSnapshot>, string]> = [
    [{ state: "MERGED" }, "merged"],
    [{ state: "CLOSED" }, "closed"],
    [{ mergeable: "CONFLICTING" }, "conflict"],
    [{ mergeStateStatus: "DIRTY" }, "conflict"],
    [{ failedChecks: ["Validate Attestation"] }, "checks_failed"],
    [{ reviewDecision: "CHANGES_REQUESTED" }, "changes_requested"],
    [{ labels: ["hold"] }, "held"],
  ];
  for (const [change, outcome] of cases) {
    assertEquals(
      classifyPrSnapshot({ ...open, ...change }, ["hold"]).outcome,
      outcome,
      JSON.stringify(change),
    );
  }
});

Deno.test("classifyPrSnapshot: names the failed checks and the hold label in the reason", () => {
  const failed = classifyPrSnapshot(
    { ...open, failedChecks: ["lint", "test"] },
    ["hold"],
  );
  assertEquals(failed, {
    outcome: "checks_failed",
    reason: "Checks failed: lint, test",
  });
  const held = classifyPrSnapshot(
    { ...open, labels: ["wip", "do-not-merge"] },
    [
      "do-not-merge",
    ],
  );
  assertEquals(held, {
    outcome: "held",
    reason: "PR is held by label do-not-merge",
  });
});

Deno.test("assertGitHubPullUrl: refuses anything but a GitHub pull URL", () => {
  assertGitHubPullUrl(URL);
  for (
    const bad of [
      "--repo=evil/x",
      "https://gitlab.com/a/b/-/merge_requests/1",
      "https://github.com/a/b/issues/1",
      "http://github.com/a/b/pull/1",
      "https://github.com/a/b/pull/1 --web",
    ]
  ) {
    assertThrows(() => assertGitHubPullUrl(bad), Error, "not a GitHub");
  }
});

Deno.test("fetchPrSnapshot: reads the PR and its failed required checks", async () => {
  const { run, calls } = fakeGh({
    view: ok({
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
      labels: [{ name: "hold" }],
      mergedAt: null,
    }),
    // gh pr checks exits 1 when a check failed but still prints the JSON.
    required: ok([
      { name: "test", bucket: "fail" },
      { name: "lint", bucket: "pass" },
      { name: "deploy", bucket: "cancel" },
    ], 1),
  });
  const snapshot = await fetchPrSnapshot(URL, run, 1000);
  assertEquals(snapshot, {
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    labels: ["hold"],
    failedChecks: ["test", "deploy"],
  });
  assertEquals(calls.length, 2);
});

Deno.test("fetchPrSnapshot: counts every check when the repo has no required ones", async () => {
  const { run, calls } = fakeGh({
    view: ok({ state: "OPEN", mergeable: "MERGEABLE", labels: [] }),
    required: {
      code: 1,
      stdout: "",
      stderr: "no required checks reported on the 'feature' branch\n",
    },
    // Exit 8 means checks are still pending.
    all: ok([
      { name: "Validate Attestation", bucket: "fail" },
      { name: "Adversarial Code Review", bucket: "pending" },
      { name: "CI Security Review", bucket: "skipping" },
    ], 8),
  });
  const snapshot = await fetchPrSnapshot(URL, run, 1000);
  assertEquals(snapshot.failedChecks, ["Validate Attestation"]);
  assertEquals(calls.length, 3);
});

Deno.test("fetchPrSnapshot: a PR with no checks at all has none failed", async () => {
  const noChecks = {
    code: 1,
    stdout: "",
    stderr: "no checks reported on the 'feature' branch\n",
  };
  const { run } = fakeGh({
    view: ok({ state: "OPEN", mergeable: "MERGEABLE", labels: [] }),
    required: noChecks,
    all: noChecks,
  });
  assertEquals((await fetchPrSnapshot(URL, run, 1000)).failedChecks, []);
});

Deno.test("fetchPrSnapshot: skips the checks once the PR has merged", async () => {
  const { run, calls } = fakeGh({
    view: ok({
      state: "MERGED",
      mergeable: "UNKNOWN",
      labels: [],
      mergedAt: "2026-11-04T22:03:56Z",
    }),
  });
  const snapshot = await fetchPrSnapshot(URL, run, 1000);
  assertEquals(snapshot.mergedAt, "2026-11-04T22:03:56Z");
  assertEquals(calls.length, 1);
});

Deno.test("fetchPrSnapshot: raises when gh pr view fails or prints no JSON", async () => {
  const auth = fakeGh({
    view: {
      code: 4,
      stdout: "",
      stderr: "To get started with GitHub CLI, please run:  gh auth login",
    },
  });
  await assertRejects(
    () => fetchPrSnapshot(URL, auth.run, 1000),
    Error,
    "gh pr view failed: To get started",
  );
  const garbage = fakeGh({ view: { code: 0, stdout: "<html>", stderr: "" } });
  await assertRejects(
    () => fetchPrSnapshot(URL, garbage.run, 1000),
    Error,
    "gh pr view failed",
  );
});

Deno.test("fetchPrSnapshot: raises when gh pr checks fails for another reason", async () => {
  const { run } = fakeGh({
    view: ok({ state: "OPEN", mergeable: "MERGEABLE", labels: [] }),
    required: { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" },
  });
  await assertRejects(
    () => fetchPrSnapshot(URL, run, 1000),
    Error,
    "gh pr checks failed: HTTP 502",
  );
});

Deno.test("fetchPrSnapshot: refuses a non-GitHub URL before running gh", async () => {
  const { run, calls } = fakeGh({ view: ok({}) });
  await assertRejects(
    () => fetchPrSnapshot("--help", run, 1000),
    Error,
    "not a GitHub",
  );
  assertEquals(calls.length, 0);
});
