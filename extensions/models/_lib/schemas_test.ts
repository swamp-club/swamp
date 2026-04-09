// Swamp, an Automation Framework Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify it under the terms
// of the GNU Affero General Public License version 3 as published by the Free
// Software Foundation, with the Swamp Extension and Definition Exception (found in
// the "COPYING-EXCEPTION" file).
//
// Swamp is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along
// with Swamp. If not, see <https://www.gnu.org/licenses/>.

import { assertEquals } from "@std/assert";
import { Phase, PullRequestSchema, TRANSITIONS } from "./schemas.ts";

Deno.test("Phase: includes pr_open, pr_failed, releasing between implementing and done", () => {
  const phases = Phase.options;
  const implementingIdx = phases.indexOf("implementing");
  const prOpenIdx = phases.indexOf("pr_open");
  const prFailedIdx = phases.indexOf("pr_failed");
  const releasingIdx = phases.indexOf("releasing");
  const doneIdx = phases.indexOf("done");

  assertEquals(prOpenIdx, implementingIdx + 1);
  assertEquals(prFailedIdx, prOpenIdx + 1);
  assertEquals(releasingIdx, prFailedIdx + 1);
  assertEquals(doneIdx, releasingIdx + 1);
});

Deno.test("TRANSITIONS: link_pr accepts implementing, pr_open, and pr_failed", () => {
  assertEquals(TRANSITIONS.link_pr, ["implementing", "pr_open", "pr_failed"]);
});

Deno.test("TRANSITIONS: complete accepts implementing, pr_open, and releasing", () => {
  // Accepting all three keeps backwards compatibility while allowing
  // the new releasing phase to be closed out directly.
  assertEquals(TRANSITIONS.complete, ["implementing", "pr_open", "releasing"]);
});

Deno.test("TRANSITIONS: start (resume) includes pr_open, pr_failed, and releasing", () => {
  const startPhases = TRANSITIONS.start;
  assertEquals(startPhases.includes("pr_open"), true);
  assertEquals(startPhases.includes("pr_failed"), true);
  assertEquals(startPhases.includes("releasing"), true);
});

Deno.test("TRANSITIONS: link_pr is rejected from earlier lifecycle phases", () => {
  // link_pr should only be callable once implementation has begun. Calling
  // it from any earlier phase is a sequencing bug in the agent and must be
  // blocked by the valid-transition pre-flight check.
  const earlierPhases: ReadonlyArray<typeof Phase.options[number]> = [
    "created",
    "triaging",
    "classified",
    "plan_generated",
    "approved",
  ];
  for (const phase of earlierPhases) {
    assertEquals(
      TRANSITIONS.link_pr.includes(phase),
      false,
      `link_pr must not be allowed from phase '${phase}'`,
    );
  }
});

Deno.test("PullRequestSchema: accepts any non-empty URL string", () => {
  // URLs are opaque to the model — GitHub, GitLab, Gitea, Forgejo, etc.
  const samples = [
    "https://github.com/systeminit/swamp/pull/1141",
    "https://gitlab.com/group/project/-/merge_requests/42",
    "https://codeberg.org/user/repo/pulls/7",
    "https://git.internal/project/+/123",
  ];
  for (const url of samples) {
    const parsed = PullRequestSchema.parse({
      url,
      attempt: 1,
      linkedAt: "2026-04-08T15:00:00.000Z",
    });
    assertEquals(parsed.url, url);
  }
});

Deno.test("PullRequestSchema: rejects empty url string", () => {
  const result = PullRequestSchema.safeParse({
    url: "",
    attempt: 1,
    linkedAt: "2026-04-08T15:00:00.000Z",
  });
  assertEquals(result.success, false);
});

Deno.test("PullRequestSchema: requires linkedAt", () => {
  const result = PullRequestSchema.safeParse({
    url: "https://github.com/systeminit/swamp/pull/1",
  });
  assertEquals(result.success, false);
});
