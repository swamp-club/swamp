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

import type { Phase } from "./schemas.ts";

// ---------------------------------------------------------------------------
// Issue Tracker Interface
// ---------------------------------------------------------------------------

/** Abstract interface for issue tracker operations. */
export interface IssueTracker {
  /** Fetch issue context (title, body, labels, comments). */
  fetchIssue(
    repo: string,
    issueNumber: number,
  ): Promise<{
    title: string;
    body: string;
    labels: string[];
    comments: { author: string; body: string; createdAt: string }[];
  }>;

  /** Post a comment on the issue. Best-effort — should not throw. */
  postComment(
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<void>;

  /** Set the lifecycle phase label, removing all other lifecycle labels. */
  setPhaseLabel(
    repo: string,
    issueNumber: number,
    phase: Phase,
  ): Promise<void>;

  /** Add labels to the issue. Best-effort. */
  addLabels(
    repo: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void>;

  /** Remove labels from the issue. Best-effort. */
  removeLabels(
    repo: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void>;

  /** Fetch PR check runs. */
  fetchPrChecks(
    repo: string,
    prNumber: number,
  ): Promise<
    {
      name: string;
      status: "passed" | "failed" | "pending";
    }[]
  >;

  /** Fetch PR reviews and their inline comments. */
  fetchPrReviews(
    repo: string,
    prNumber: number,
  ): Promise<
    {
      reviewer: string;
      state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
      body: string;
      comments: {
        path: string;
        line?: number;
        body: string;
        severity?: string;
      }[];
    }[]
  >;

  /** Check that the tracker backend is available and authenticated. */
  checkAvailability(): Promise<
    { available: true } | { available: false; error: string }
  >;
}

// ---------------------------------------------------------------------------
// GitHub Issue Tracker Implementation
// ---------------------------------------------------------------------------

const PHASE_LABELS: Record<Phase, string> = {
  created: "",
  triaging: "lifecycle/triaging",
  classified: "lifecycle/classified",
  plan_generated: "lifecycle/plan-review",
  approved: "lifecycle/approved",
  implementing: "lifecycle/implementing",
  ci_review: "lifecycle/ci-review",
  done: "lifecycle/done",
};

const ALL_LIFECYCLE_LABELS = Object.values(PHASE_LABELS).filter(Boolean);

/** Run a gh CLI command and return parsed JSON output. */
async function ghJson(args: string[]): Promise<unknown> {
  const cmd = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `gh ${args.join(" ")} failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

/** Best-effort run a gh command. Swallows errors. */
async function ghBestEffort(args: string[]): Promise<boolean> {
  try {
    const cmd = new Deno.Command("gh", {
      args,
      stdout: "null",
      stderr: "piped",
    });
    const output = await cmd.output();
    return output.success;
  } catch {
    return false;
  }
}

export class GitHubIssueTracker implements IssueTracker {
  async fetchIssue(repo: string, issueNumber: number) {
    const issue = (await ghJson([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "title,body,labels,comments",
    ])) as {
      title: string;
      body: string;
      labels: { name: string }[];
      comments: {
        author: { login: string };
        body: string;
        createdAt: string;
      }[];
    };

    return {
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((l) => l.name),
      comments: issue.comments.map((c) => ({
        author: c.author.login,
        body: c.body,
        createdAt: c.createdAt,
      })),
    };
  }

  async postComment(
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<void> {
    await ghBestEffort([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      body,
    ]);
  }

  async setPhaseLabel(
    repo: string,
    issueNumber: number,
    phase: Phase,
  ): Promise<void> {
    const targetLabel = PHASE_LABELS[phase];
    const removeLabels = ALL_LIFECYCLE_LABELS.filter((l) => l !== targetLabel);
    removeLabels.push("lifecycle/needs-info");

    await this.removeLabels(repo, issueNumber, removeLabels);
    if (targetLabel) {
      await this.addLabels(repo, issueNumber, [targetLabel]);
    }
  }

  async addLabels(
    repo: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void> {
    for (const label of labels) {
      await ghBestEffort([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--add-label",
        label,
      ]);
    }
  }

  async removeLabels(
    repo: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void> {
    for (const label of labels) {
      await ghBestEffort([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--remove-label",
        label,
      ]);
    }
  }

  async fetchPrChecks(repo: string, prNumber: number) {
    const checksData = (await ghJson([
      "pr",
      "checks",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "name,state,bucket",
    ])) as { name: string; state: string; bucket: string }[];

    return (Array.isArray(checksData) ? checksData : []).map((c) => ({
      name: c.name,
      status: c.bucket === "pass"
        ? "passed" as const
        : c.bucket === "fail"
        ? "failed" as const
        : "pending" as const,
    }));
  }

  async fetchPrReviews(repo: string, prNumber: number) {
    const reviewsRaw = (await ghJson([
      "api",
      `repos/${repo}/pulls/${prNumber}/reviews`,
      "--jq",
      ".",
    ])) as {
      user: { login: string };
      state: string;
      body: string;
    }[];

    const commentsRaw = (await ghJson([
      "api",
      `repos/${repo}/pulls/${prNumber}/comments`,
      "--jq",
      ".",
    ])) as {
      user: { login: string };
      path: string;
      line: number | null;
      body: string;
      pull_request_review_id: number;
    }[];

    const reviewMap = new Map<
      string,
      {
        state: string;
        body: string;
        comments: {
          path: string;
          line?: number;
          body: string;
          severity?: string;
        }[];
      }
    >();

    for (const review of (Array.isArray(reviewsRaw) ? reviewsRaw : [])) {
      reviewMap.set(review.user.login, {
        state: review.state,
        body: review.body,
        comments: [],
      });
    }

    for (const comment of (Array.isArray(commentsRaw) ? commentsRaw : [])) {
      const reviewer = comment.user.login;
      if (!reviewMap.has(reviewer)) {
        reviewMap.set(reviewer, {
          state: "COMMENTED",
          body: "",
          comments: [],
        });
      }

      const severityMatch = comment.body.match(
        /\*\*(?:severity|Severity)\s*:\s*(critical|high|medium|low|info)\*\*/i,
      );

      reviewMap.get(reviewer)!.comments.push({
        path: comment.path,
        line: comment.line ?? undefined,
        body: comment.body,
        severity: severityMatch ? severityMatch[1].toLowerCase() : undefined,
      });
    }

    return Array.from(reviewMap.entries()).map(([reviewer, data]) => ({
      reviewer,
      state: data.state as
        | "APPROVED"
        | "CHANGES_REQUESTED"
        | "COMMENTED"
        | "PENDING",
      body: data.body,
      comments: data.comments,
    }));
  }

  async checkAvailability(): Promise<
    { available: true } | { available: false; error: string }
  > {
    try {
      const which = new Deno.Command("which", {
        args: ["gh"],
        stdout: "null",
        stderr: "null",
      });
      const { success } = await which.output();
      if (!success) {
        return { available: false, error: "gh CLI is not installed" };
      }
      const auth = new Deno.Command("gh", {
        args: ["auth", "status"],
        stdout: "null",
        stderr: "null",
      });
      const authResult = await auth.output();
      if (!authResult.success) {
        return {
          available: false,
          error: "gh CLI is not authenticated. Run 'gh auth login'.",
        };
      }
      return { available: true };
    } catch {
      return {
        available: false,
        error: "Failed to check gh CLI availability",
      };
    }
  }
}

/** Create the default issue tracker instance. */
export function createTracker(): IssueTracker {
  return new GitHubIssueTracker();
}
