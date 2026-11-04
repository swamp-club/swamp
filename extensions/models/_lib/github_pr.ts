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

/** What GitHub reports about a pull request at one moment. */
export interface PrSnapshot {
  state: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  labels: string[];
  mergedAt?: string;
  failedChecks: string[];
}

export type PrOutcome =
  | "merged"
  | "closed"
  | "conflict"
  | "checks_failed"
  | "changes_requested"
  | "held";

export type PrVerdict =
  | { outcome: PrOutcome; reason: string }
  | { outcome: "pending" };

/**
 * Decides whether a snapshot ends the watch. Earlier rules win: a merge
 * outranks everything, and a conflict outranks review and hold states
 * because nothing else can land until it is resolved.
 */
export function classifyPrSnapshot(
  snapshot: PrSnapshot,
  holdLabels: readonly string[],
): PrVerdict {
  if (snapshot.state === "MERGED") {
    return { outcome: "merged", reason: "PR merged" };
  }
  if (snapshot.state === "CLOSED") {
    return { outcome: "closed", reason: "PR closed without merging" };
  }
  if (
    snapshot.mergeable === "CONFLICTING" ||
    snapshot.mergeStateStatus === "DIRTY"
  ) {
    return {
      outcome: "conflict",
      reason: "PR has a merge conflict with its base branch",
    };
  }
  if (snapshot.failedChecks.length > 0) {
    return {
      outcome: "checks_failed",
      reason: `Checks failed: ${snapshot.failedChecks.join(", ")}`,
    };
  }
  if (snapshot.reviewDecision === "CHANGES_REQUESTED") {
    return {
      outcome: "changes_requested",
      reason: "A reviewer requested changes",
    };
  }
  const held = snapshot.labels.filter((l) => holdLabels.includes(l));
  if (held.length > 0) {
    return {
      outcome: "held",
      reason: `PR is held by label ${held.join(", ")}`,
    };
  }
  return { outcome: "pending" };
}

const PULL_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/**
 * Refuses anything but a GitHub pull URL: the stored URL is free text, and
 * one starting with a dash would reach gh as a flag.
 */
export function assertGitHubPullUrl(url: string): void {
  if (!PULL_URL.test(url)) {
    throw new Error(
      `The linked PR URL ${url} is not a GitHub pull request URL ` +
        "(https://github.com/OWNER/REPO/pull/NUMBER), so watch_pr cannot " +
        "read its status.",
    );
  }
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GhRunner = (
  args: string[],
  signal: AbortSignal,
) => Promise<CommandResult>;

export const runGh: GhRunner = async (args, signal) => {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("gh", {
      args,
      stdout: "piped",
      stderr: "piped",
      signal,
    }).output();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        "watch_pr needs the GitHub CLI (gh) on PATH, authenticated with " +
          "gh auth login.",
      );
    }
    throw error;
  }
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
};

const NO_CHECKS = /no (required )?checks reported/i;
const FAILED_BUCKETS = new Set(["fail", "cancel"]);

/**
 * Reads the failed checks. Required checks decide when the repo defines any;
 * a repo that gates merges some other way has every check counted.
 */
async function readFailedChecks(
  url: string,
  run: GhRunner,
  signal: AbortSignal,
): Promise<string[]> {
  const required = await readChecks(url, ["--required"], run, signal);
  const checks = required ?? await readChecks(url, [], run, signal) ?? [];
  return checks
    .filter((c) => FAILED_BUCKETS.has(c.bucket))
    .map((c) => c.name);
}

// gh pr checks exits non-zero when a check failed or is still pending, so the
// exit code only means an error when stdout holds no JSON.
async function readChecks(
  url: string,
  extra: string[],
  run: GhRunner,
  signal: AbortSignal,
): Promise<{ name: string; bucket: string }[] | null> {
  const result = await run(
    ["pr", "checks", url, ...extra, "--json", "name,bucket"],
    signal,
  );
  const parsed = tryParseJson(result.stdout);
  if (Array.isArray(parsed)) {
    return parsed.map((c) => ({
      name: String(c?.name ?? ""),
      bucket: String(c?.bucket ?? ""),
    }));
  }
  if (NO_CHECKS.test(result.stderr)) return null;
  throw ghError("gh pr checks", result);
}

export async function fetchPrSnapshot(
  url: string,
  run: GhRunner,
  timeoutMs: number,
): Promise<PrSnapshot> {
  assertGitHubPullUrl(url);
  const signal = AbortSignal.timeout(timeoutMs);
  const view = await run(
    [
      "pr",
      "view",
      url,
      "--json",
      "state,mergeable,mergeStateStatus,reviewDecision,labels,mergedAt",
    ],
    signal,
  );
  const parsed = view.code === 0 ? tryParseJson(view.stdout) : undefined;
  if (!parsed || typeof parsed !== "object") {
    throw ghError("gh pr view", view);
  }
  const pr = parsed as Record<string, unknown>;
  const snapshot: PrSnapshot = {
    state: String(pr.state ?? ""),
    mergeable: String(pr.mergeable ?? ""),
    mergeStateStatus: String(pr.mergeStateStatus ?? ""),
    reviewDecision: String(pr.reviewDecision ?? ""),
    labels: Array.isArray(pr.labels)
      ? pr.labels.map((l) => String(l?.name ?? ""))
      : [],
    ...(typeof pr.mergedAt === "string" && pr.mergedAt
      ? { mergedAt: pr.mergedAt }
      : {}),
    failedChecks: [],
  };
  // Checks are moot once the PR has merged or closed.
  if (snapshot.state === "OPEN") {
    snapshot.failedChecks = await readFailedChecks(url, run, signal);
  }
  return snapshot;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function ghError(command: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() ||
    `exit code ${result.code}`;
  return new Error(`${command} failed: ${detail}`);
}
