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
import { createWatchPrMethod, model } from "./issue_lifecycle.ts";
import {
  FAKE_SWAMP_CLUB_URL,
  FakeSwampClub,
} from "./_lib/fake_swamp_club_test_helper.ts";
import {
  type CommandResult,
  type GhRunner,
  GhUnavailableError,
} from "./_lib/github_pr.ts";
import { PR_COOLDOWN_MS } from "./_lib/schemas.ts";

// ---------------------------------------------------------------------------
// Harness — watch_pr wired to an in-memory swamp-club, a scripted gh, a
// fake clock, and a runModel that runs the model's own checks and methods
// against the same store, as swamp's nested invocation does.
// ---------------------------------------------------------------------------

const PR = "https://github.com/swamp-club/swamp/pull/900";
const ISSUE = 1;

type Store = Record<string, Record<string, unknown>>;

interface PrState {
  state?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  labels?: string[];
  mergedAt?: string;
  failedChecks?: string[];
}

interface Harness {
  club: FakeSwampClub;
  store: Store;
  sleeps: number[];
  nested: string[];
  warnings: string[];
  run: (args?: Record<string, unknown>) => Promise<unknown>;
}

const SUMMARY = {
  originalProblem: "The lifecycle stopped at pr_open",
  deliveredOutcome: "watch_pr closes the issue out",
  outcomeMet: true,
};

const json = (value: unknown, code = 0): CommandResult => ({
  code,
  stdout: JSON.stringify(value),
  stderr: "",
});

/** Each gh pr view call takes the next state; the last one repeats. */
function scriptedGh(states: Array<PrState | Error>): GhRunner {
  let viewIndex = -1;
  let current: PrState = {};
  return (args) => {
    if (args[1] === "view") {
      viewIndex = Math.min(viewIndex + 1, states.length - 1);
      const next = states[viewIndex];
      if (next instanceof Error) {
        return Promise.resolve({ code: 1, stdout: "", stderr: next.message });
      }
      current = next;
      return Promise.resolve(json({
        state: next.state ?? "OPEN",
        mergeable: next.mergeable ?? "MERGEABLE",
        mergeStateStatus: next.mergeStateStatus ?? "BLOCKED",
        reviewDecision: next.reviewDecision ?? "",
        labels: (next.labels ?? []).map((name) => ({ name })),
        mergedAt: next.mergedAt ?? null,
      }));
    }
    const checks = (current.failedChecks ?? []).map((name) => ({
      name,
      bucket: "fail",
    }));
    return Promise.resolve(json(checks, checks.length ? 1 : 0));
  };
}

async function withWatch(
  opts: {
    gh: GhRunner;
    /** How long before the fake clock's start link_pr ran. */
    linkedAgoMs?: number;
    setup?: (club: FakeSwampClub, store: Store) => void;
    skipChecks?: string[];
  },
  test: (h: Harness) => Promise<void>,
): Promise<void> {
  let clock = Date.now();
  const club = new FakeSwampClub();
  club.addIssue({ number: ISSUE, status: "in_progress" });
  const store: Store = {
    "state-main": { phase: "pr_open", issueNumber: ISSUE, updatedAt: "t" },
    "pullRequest-main": {
      url: PR,
      attempt: 1,
      linkedAt: new Date(
        clock - (opts.linkedAgoMs ?? PR_COOLDOWN_MS + 1000),
      ).toISOString(),
    },
  };
  opts.setup?.(club, store);

  const sleeps: number[] = [];
  const nested: string[] = [];
  const warnings: string[] = [];

  const baseContext = {
    globalArgs: {
      issueNumber: ISSUE,
      swampClubUrl: FAKE_SWAMP_CLUB_URL,
      swampClubApiKey: "fake-key",
    },
    logger: {
      info: () => {},
      warning: (msg: string, props: Record<string, unknown>) => {
        warnings.push(`${msg} ${JSON.stringify(props)}`);
      },
    },
    readResource: (name: string) => Promise.resolve(store[name] ?? null),
  };
  const encoder = new TextEncoder();

  const runModel = async (
    { method, arguments: methodArgs }: {
      definition: string;
      method: string;
      arguments?: Record<string, unknown>;
    },
  ) => {
    nested.push(method);
    const checkContext = {
      methodName: method,
      modelType: "@swamp/issue-lifecycle",
      modelId: "issue-1",
      dataRepository: {
        getContent: (_t: string, _m: string, name: string) =>
          Promise.resolve(
            store[name] ? encoder.encode(JSON.stringify(store[name])) : null,
          ),
      },
    };
    for (const [name, check] of Object.entries(model.checks)) {
      if (opts.skipChecks?.includes(name)) continue;
      const applies = (check as { appliesTo?: string[] }).appliesTo;
      if (applies && !applies.includes(method)) continue;
      const result = await check.execute(checkContext);
      if (!result.pass) {
        return {
          ok: false as const,
          error: { message: `${name}: ${result.errors?.join("; ")}` },
        };
      }
    }
    const target = model.methods[method as keyof typeof model.methods];
    // A rolled-back method leaves nothing behind, so its writes are held
    // until it succeeds.
    const pending: Store = {};
    const rollback = (target as { rollbackOnFailure?: boolean })
      .rollbackOnFailure;
    try {
      const parsed = await target.arguments.parseAsync(methodArgs ?? {});
      await (target.execute as (a: unknown, c: unknown) => Promise<unknown>)(
        parsed,
        {
          ...baseContext,
          writeResource: (_s: string, name: string, data: Store[string]) => {
            if (rollback) pending[name] = data;
            else store[name] = data;
            return Promise.resolve({ name });
          },
          readResource: (name: string) =>
            Promise.resolve(pending[name] ?? store[name] ?? null),
        },
      );
      Object.assign(store, pending);
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        error: { message: (error as Error).message },
      };
    }
  };

  const method = createWatchPrMethod({
    runGh: opts.gh,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  });

  const run = async (args: Record<string, unknown> = {}) =>
    await method.execute(
      await method.arguments.parseAsync({ ...SUMMARY, ...args }),
      {
        ...baseContext,
        writeResource: (_s: string, name: string, data: Store[string]) => {
          store[name] = data;
          return Promise.resolve({ name });
        },
        runModel,
        definition: { id: "def-1" },
      },
    );

  const restore = club.install();
  try {
    await test({ club, store, sleeps, nested, warnings, run });
  } finally {
    restore();
  }
}

const phaseOf = (store: Store) => store["state-main"].phase;
const watchOf = (store: Store) => store["prWatch-main"];

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

Deno.test("watch_pr: a merged PR walks pr_merged, notify and summarize to done", async () => {
  await withWatch({
    gh: scriptedGh([{ state: "MERGED", mergedAt: "2026-11-04T22:00:00Z" }]),
  }, async ({ club, store, nested, run }) => {
    await run();
    assertEquals(nested, ["pr_merged", "notify", "summarize"]);
    assertEquals(phaseOf(store), "done");
    assertEquals(club.issues.get(ISSUE)!.status, "shipped");
    assertEquals(store["pullRequest-main"].mergedAt, "2026-11-04T22:00:00Z");
    assertEquals(
      store["summary-main"].deliveredOutcome,
      SUMMARY.deliveredOutcome,
    );
    assertEquals(club.ripples.length, 1, "the external author is thanked");
    assertEquals(watchOf(store).outcome, "merged");
    assertEquals(watchOf(store).stepsRun, ["pr_merged", "notify", "summarize"]);
  });
});

Deno.test("watch_pr: keeps polling an open PR until it merges", async () => {
  await withWatch({
    gh: scriptedGh([
      { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
      {},
      { state: "MERGED" },
    ]),
  }, async ({ store, sleeps, run }) => {
    await run({ pollIntervalSeconds: 20 });
    assertEquals(sleeps, [20_000, 20_000]);
    assertEquals(watchOf(store).polls, 3);
    assertEquals(phaseOf(store), "done");
  });
});

Deno.test("watch_pr: passes linked outcomes through to summarize", async () => {
  await withWatch({
    gh: scriptedGh([{ state: "MERGED" }]),
    setup: (club, store) => {
      club.addIssue({ number: 2, status: "in_progress" });
      store["linkedIssues-main"] = {
        issues: [{
          issueNumber: 2,
          relationship: "related_to",
          title: "t",
          linkedAt: "t",
        }],
        updatedAt: "t",
      };
    },
  }, async ({ store, run }) => {
    const linkedOutcomes = [{
      issueNumber: 2,
      deliveredOutcome: "fixed too",
      outcomeMet: true,
    }];
    await run({ linkedOutcomes });
    assertEquals(store["summary-main"].linkedOutcomes, linkedOutcomes);
    assertEquals(phaseOf(store), "done");
  });
});

// ---------------------------------------------------------------------------
// Failure states
// ---------------------------------------------------------------------------

Deno.test("watch_pr: each blocking state records pr_failed with its reason", async () => {
  const cases: Array<[PrState, string, string]> = [
    [{ mergeable: "CONFLICTING" }, "conflict", "merge conflict"],
    [{ mergeStateStatus: "DIRTY" }, "conflict", "merge conflict"],
    [
      { failedChecks: ["Validate Attestation"] },
      "checks_failed",
      "Validate Attestation",
    ],
    [
      { reviewDecision: "CHANGES_REQUESTED" },
      "changes_requested",
      "requested changes",
    ],
    [{ state: "CLOSED" }, "closed", "closed without merging"],
  ];
  for (const [prState, outcome, reason] of cases) {
    await withWatch(
      { gh: scriptedGh([prState]) },
      async ({ club, store, nested, run }) => {
        await run();
        assertEquals(nested, ["pr_failed"], outcome);
        assertEquals(phaseOf(store), "pr_failed");
        assertEquals(watchOf(store).outcome, outcome);
        assertStringIncludes(
          String(store["pullRequest-main"].failureReason),
          reason,
        );
        assertEquals(club.issues.get(ISSUE)!.status, "in_progress");
      },
    );
  }
});

Deno.test("watch_pr: a conflict inside the cooldown waits it out, reads again, then records pr_failed", async () => {
  await withWatch({
    gh: scriptedGh([{ mergeable: "CONFLICTING" }]),
    linkedAgoMs: 60_000,
    // The real check reads the wall clock, which the fake clock cannot move.
    skipChecks: ["pr-cooldown"],
  }, async ({ store, sleeps, warnings, run }) => {
    await run();
    assertEquals(sleeps, [PR_COOLDOWN_MS - 60_000]);
    assertEquals(watchOf(store).polls, 2);
    assertStringIncludes(warnings.join("\n"), "merge conflict");
    assertEquals(phaseOf(store), "pr_failed");
  });
});

Deno.test("watch_pr: a failure that clears during the cooldown keeps the watch going", async () => {
  await withWatch({
    gh: scriptedGh([
      { failedChecks: ["Validate Attestation"] },
      {},
      { state: "MERGED" },
    ]),
    linkedAgoMs: 60_000,
    skipChecks: ["pr-cooldown"],
  }, async ({ store, nested, sleeps, run }) => {
    await run({ pollIntervalSeconds: 30 });
    assertEquals(sleeps, [PR_COOLDOWN_MS - 60_000, 30_000]);
    assertEquals(nested, ["pr_merged", "notify", "summarize"]);
    assertEquals(phaseOf(store), "done");
  });
});

// ---------------------------------------------------------------------------
// No transition
// ---------------------------------------------------------------------------

Deno.test("watch_pr: a hold label ends the watch with no transition", async () => {
  await withWatch({
    gh: scriptedGh([{ labels: ["do-not-merge"] }]),
  }, async ({ store, nested, run }) => {
    await run({ holdLabels: ["do-not-merge"] });
    assertEquals(nested, []);
    assertEquals(phaseOf(store), "pr_open");
    assertEquals(watchOf(store).outcome, "held");
  });
});

Deno.test("watch_pr: the time limit ends the watch with no transition", async () => {
  await withWatch({ gh: scriptedGh([{}]) }, async ({ store, nested, run }) => {
    await run({ pollIntervalSeconds: 60, timeoutMinutes: 5 });
    assertEquals(nested, []);
    assertEquals(phaseOf(store), "pr_open");
    assertEquals(watchOf(store).outcome, "timed_out");
    assertEquals(
      watchOf(store).polls,
      6,
      "one read at the start and one a minute until the limit",
    );
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

Deno.test("watch_pr: a failing pr_merged leaves the phase at pr_open and is recorded", async () => {
  await withWatch({
    gh: scriptedGh([{ state: "MERGED" }]),
    setup: (club) => {
      club.failWhen = (call) =>
        call.method === "PATCH"
          ? new Response("nope", { status: 500 })
          : undefined;
    },
  }, async ({ store, nested, run }) => {
    await assertRejects(() => run(), Error, "pr_merged failed");
    assertEquals(nested, ["pr_merged"]);
    assertEquals(phaseOf(store), "pr_open");
    assertEquals(watchOf(store).failedStep, "pr_merged");
    assertEquals(watchOf(store).stepsRun, []);
  });
});

Deno.test("watch_pr: a failing notify is recorded, not retried, and summarize does not run", async () => {
  await withWatch({
    gh: scriptedGh([{ state: "MERGED" }]),
    setup: (club) => {
      club.roster = null;
    },
  }, async ({ store, nested, run }) => {
    await assertRejects(
      () => run(),
      Error,
      "Do not re-run notify blindly",
    );
    assertEquals(nested, ["pr_merged", "notify"]);
    assertEquals(phaseOf(store), "notify");
    assertEquals(watchOf(store).failedStep, "notify");
    assertEquals(watchOf(store).stepsRun, ["pr_merged"]);
  });
});

Deno.test("watch_pr: rides out a gh failure but raises after several in a row", async () => {
  const blip = new Error("HTTP 502");
  await withWatch({
    gh: scriptedGh([blip, { state: "MERGED" }]),
  }, async ({ store, run }) => {
    await run();
    assertEquals(phaseOf(store), "done");
  });
  await withWatch({
    gh: scriptedGh([blip]),
  }, async ({ store, nested, run }) => {
    await assertRejects(() => run(), Error, "HTTP 502");
    assertEquals(nested, []);
    assertEquals(phaseOf(store), "pr_open");
  });
});

Deno.test("watch_pr: a missing gh fails at once instead of being retried", async () => {
  let calls = 0;
  await withWatch({
    gh: () => {
      calls++;
      throw new GhUnavailableError("watch_pr needs the GitHub CLI (gh)");
    },
  }, async ({ sleeps, run }) => {
    await assertRejects(() => run(), GhUnavailableError);
    assertEquals(calls, 1);
    assertEquals(sleeps, []);
  });
});

Deno.test("watch_pr: refuses before polling when linked outcomes do not match", async () => {
  let ghCalls = 0;
  await withWatch({
    gh: () => {
      ghCalls++;
      return Promise.resolve(json({}));
    },
    setup: (_club, store) => {
      store["linkedIssues-main"] = {
        issues: [{
          issueNumber: 2,
          relationship: "related_to",
          title: "t",
          linkedAt: "t",
        }],
        updatedAt: "t",
      };
    },
  }, async ({ run }) => {
    await assertRejects(
      () => run(),
      Error,
      "no outcome for linked issue(s) #2",
    );
    assertEquals(ghCalls, 0);
  });
});

Deno.test("watch_pr: refuses a linked URL that is not a GitHub pull request", async () => {
  await withWatch({
    gh: () => {
      throw new Error("gh must not run");
    },
    setup: (_club, store) => {
      store["pullRequest-main"].url = "--repo=evil/x";
    },
  }, async ({ run }) => {
    await assertRejects(() => run(), Error, "not a GitHub pull request URL");
  });
});

Deno.test("watch_pr: requires the summary inputs", async () => {
  const method = model.methods.watch_pr;
  await assertRejects(() => method.arguments.parseAsync({}));
  await method.arguments.parseAsync(SUMMARY);
});

Deno.test("watch_pr: the valid-transition check allows it only from pr_open", async () => {
  for (const [phase, pass] of [["pr_open", true], ["implementing", false]]) {
    const result = await model.checks["valid-transition"].execute({
      methodName: "watch_pr",
      modelType: "@swamp/issue-lifecycle",
      modelId: "issue-1",
      dataRepository: {
        getContent: () =>
          Promise.resolve(
            new TextEncoder().encode(JSON.stringify({ phase })),
          ),
      },
    });
    assertEquals(result.pass, pass, String(phase));
  }
});
