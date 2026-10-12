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

// Architectural fitness test: the CI auto-merge gate fails closed.
//
// swamp-club#3048: the gate used to ask only whether anything had failed. A
// runner outage that cancelled change detection left every review `skipped`,
// and a review cancelled on its own is `cancelled` without cancelling the run,
// so neither stopped the merge and a core-source PR could merge unreviewed.
//
// The gate now requires `success` from every prerequisite, and accepts a
// skipped review only when change detection succeeded and said the review was
// not required. These rules pin that shape so it cannot be quietly reverted.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parse } from "@std/yaml";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const CI_WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");

const REVIEWS = [
  "claude-adversarial-review",
  "claude-ci-security-review",
  "claude-review-integrity",
];

interface Job {
  needs?: string | string[];
  if?: string;
  steps?: { name?: string; run?: string }[];
}

async function loadJobs(): Promise<Record<string, Job>> {
  const doc = parse(await Deno.readTextFile(CI_WORKFLOW)) as {
    jobs: Record<string, Job>;
  };
  return doc.jobs;
}

/** Whitespace-free, so clause checks don't depend on line wrapping. */
function squash(expression: string): string {
  return expression.replace(/\s+/g, "");
}

async function autoMerge(): Promise<{ job: Job; condition: string }> {
  const jobs = await loadJobs();
  const job = jobs["auto-merge"];
  if (!job?.if) {
    throw new Error(
      "No auto-merge job with an if condition in .github/workflows/ci.yml — " +
        "it was renamed, which would make these rules a vacuous pass.",
    );
  }
  return { job, condition: squash(job.if) };
}

function needsOf(job: Job): string[] {
  return job.needs === undefined
    ? []
    : Array.isArray(job.needs)
    ? job.needs
    : [job.needs];
}

Deno.test("ci merge gate: auto-merge needs change detection, the attestation and every review", async () => {
  const { job } = await autoMerge();
  const needs = needsOf(job);

  const missing = ["changes", "validate-attestation", ...REVIEWS].filter(
    (name) => !needs.includes(name),
  );
  assertEquals(
    missing,
    [],
    "auto-merge does not need these jobs, so it can merge without knowing " +
      "whether they ran.",
  );
});

Deno.test("ci merge gate: every needed job must succeed", async () => {
  const { job, condition } = await autoMerge();

  const unchecked = needsOf(job).filter((name) =>
    !condition.includes(`needs.${name}.result=='success'`)
  );
  assertEquals(
    unchecked,
    [],
    "auto-merge does not require success from these jobs, so a cancelled or " +
      "skipped run of them lets the merge through.",
  );
});

Deno.test("ci merge gate: a review may be skipped only when change detection did not require it", async () => {
  const jobs = await loadJobs();
  const { condition } = await autoMerge();

  for (const review of REVIEWS) {
    // Pair each review with the output its own job-level `if` runs on, so the
    // gate and the review cannot drift onto different outputs.
    const output = jobs[review]?.if?.match(
      /needs\.changes\.outputs\.(\w+)\s*==\s*'true'/,
    )?.[1];
    if (!output) {
      throw new Error(
        `${review} is no longer gated on a changes output — update this rule.`,
      );
    }

    assertStringIncludes(
      condition,
      squash(
        `needs.${review}.result == 'success' ||
         (needs.${review}.result == 'skipped' &&
          needs.changes.outputs.${output} != 'true')`,
      ),
      `auto-merge must accept a skipped ${review} only when ` +
        `needs.changes.outputs.${output} says it was not required.`,
    );
  }
});

Deno.test("ci merge gate: a cancelled run never merges", async () => {
  const { condition } = await autoMerge();

  // Without a status function GitHub adds an implicit success(), which skips
  // the job whenever a needed job was skipped, so the result checks never
  // run. always() would keep evaluating after the run itself was cancelled.
  assertStringIncludes(
    condition,
    "!cancelled()",
    "auto-merge must keep !cancelled() as its status function.",
  );
  assertEquals(
    condition.includes("always()"),
    false,
    "auto-merge must not use always(): it would merge in a cancelled run.",
  );
});

Deno.test("ci merge gate: the merge is pinned to the commit the run checked", async () => {
  const { job } = await autoMerge();

  const merge = job.steps?.find((step) => step.run?.includes("gh pr merge"))
    ?.run;
  if (!merge) {
    throw new Error("No gh pr merge step in the auto-merge job.");
  }
  assertStringIncludes(
    merge,
    "--match-head-commit",
    "gh pr merge without --match-head-commit merges whatever the head is " +
      "now, including a newer push whose review has not finished.",
  );
});
