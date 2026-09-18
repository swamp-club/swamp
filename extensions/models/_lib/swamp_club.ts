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

// ---------------------------------------------------------------------------
// Swamp Club Lifecycle API Client
// ---------------------------------------------------------------------------

import { join } from "@std/path";
import type { IssueType } from "./schemas.ts";

export const LIFECYCLE_SUMMARY_MAX_CHARS = 2000;

/**
 * Result of an upstream write the caller must be able to inspect.
 *
 * `rejected` means the server answered and refused — deterministic, so a
 * retry of the same payload fails the same way. `unavailable` means the
 * request never produced an answer. `noop` marks a write the server had
 * already applied.
 */
export type UpstreamOutcome =
  | { ok: true; noop?: boolean }
  | { ok: false; reason: "rejected"; status: number; body: string }
  | { ok: false; reason: "unavailable"; detail: string };

export interface LifecycleEntryParams {
  step: string;
  targetStatus: string;
  summary: string;
  emoji: string;
  payload: Record<string, unknown>;
  body?: string;
  isVerbose?: boolean;
}

export interface EligibleAssignee {
  userId: string;
  username: string;
}

export interface FetchedIssue {
  number: number;
  type: IssueType;
  status: string;
  title: string;
  body: string;
  author: string;
  comments: { author: string; body: string; createdAt: string }[];
  assignees: { userId: string; username: string }[];
}

/**
 * HTTP client for the swamp-club lab issues API. Operates directly on a
 * sequential lab issue number — the issue must already exist in swamp-club.
 */
export class SwampClubClient {
  private baseUrl: string;
  readonly #apiKey: string;
  private issueNumber: number;
  private log: (msg: string, props: Record<string, unknown>) => void;
  private logInfo: (msg: string, props: Record<string, unknown>) => void;

  constructor(
    baseUrl: string,
    apiKey: string,
    issueNumber: number,
    logger?: {
      info: (msg: string, props: Record<string, unknown>) => void;
      warning: (msg: string, props: Record<string, unknown>) => void;
    },
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#apiKey = apiKey;
    this.issueNumber = issueNumber;
    this.log = logger?.warning.bind(logger) ?? (() => {});
    this.logInfo = logger?.info.bind(logger) ?? (() => {});
  }

  /** Build the public lab URL for this issue. */
  labUrl(): string {
    return `${this.baseUrl}/lab/${this.issueNumber}`;
  }

  /**
   * Fetch the issue from swamp-club. Returns null if the issue does not
   * exist or the request fails.
   */
  async fetchIssue(): Promise<FetchedIssue | null> {
    try {
      const url = `${this.baseUrl}/api/v1/lab/issues/${this.issueNumber}`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.#apiKey}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.log("swamp-club fetch issue failed: {status} {text}", {
          status: res.status,
          text,
        });
        return null;
      }
      const data = await res.json() as {
        issue?: {
          number?: number;
          type?: IssueType;
          status?: string;
          title?: string;
          body?: string;
          authorUsername?: string;
          comments?: {
            authorUsername?: string;
            author?: string;
            body?: string;
            createdAt?: string;
          }[];
          assignees?: {
            userId?: string;
            username?: string;
          }[];
        };
      };
      const issue = data?.issue;
      if (!issue || typeof issue.number !== "number") return null;
      return {
        number: issue.number,
        type: (issue.type ?? "feature") as IssueType,
        status: issue.status ?? "open",
        title: issue.title ?? "",
        body: issue.body ?? "",
        author: issue.authorUsername ?? "unknown",
        comments: (issue.comments ?? []).map((c) => ({
          author: c.authorUsername ?? c.author ?? "unknown",
          body: c.body ?? "",
          createdAt: c.createdAt ?? "",
        })),
        assignees: (issue.assignees ?? []).filter(
          (a): a is { userId: string; username: string } =>
            typeof a.userId === "string" && typeof a.username === "string",
        ),
      };
    } catch (err) {
      this.log("swamp-club fetch issue error: {error}", {
        error: String(err),
      });
      return null;
    }
  }

  /**
   * Post a structured lifecycle entry.
   *
   * Reports the outcome rather than swallowing it: a lifecycle entry is the
   * durable audit record of a step, so a caller must be able to tell a
   * recorded entry from a dropped one. The failure policy lives in
   * `lifecycle_recorder.ts`, not here.
   */
  async postLifecycleEntry(
    params: LifecycleEntryParams,
  ): Promise<UpstreamOutcome> {
    try {
      const url =
        `${this.baseUrl}/api/v1/lab/issues/${this.issueNumber}/lifecycle`;
      let summary = params.summary;
      if (summary.length > LIFECYCLE_SUMMARY_MAX_CHARS) {
        summary = summary.slice(0, LIFECYCLE_SUMMARY_MAX_CHARS - 3) + "...";
      }
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({
          step: params.step,
          targetStatus: params.targetStatus,
          summary,
          emoji: params.emoji,
          payload: params.payload,
          body: params.body,
          isVerbose: params.isVerbose ?? false,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.log("swamp-club lifecycle post failed: {status} {text}", {
          status: res.status,
          text,
        });
        return {
          ok: false,
          reason: "rejected",
          status: res.status,
          body: text,
        };
      }
      return { ok: true };
    } catch (err) {
      this.log("swamp-club lifecycle post error: {error}", {
        error: String(err),
      });
      return { ok: false, reason: "unavailable", detail: String(err) };
    }
  }

  async postAttestation(
    attestation: Record<string, unknown>,
  ): Promise<{ id: string; postedBy: string; postedAt: string }> {
    const url = `${this.baseUrl}/api/v1/admin/attestations`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(attestation),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Attestation POST failed: HTTP ${res.status} — ${text}`,
      );
    }
    return await res.json() as {
      id: string;
      postedBy: string;
      postedAt: string;
    };
  }

  /**
   * Transition the issue status.
   *
   * A 422 means the lab aggregate refused the transition, which is benign
   * exactly when the issue already carries the status we asked for — the
   * ordinary shape of a re-run. That is confirmed by re-reading the issue and
   * comparing the status field, not by matching the server's error prose,
   * which swamp-club is free to reword.
   *
   * One read, never a retry loop. The read itself is retried once because it
   * is a read and a flaky GET would otherwise strand every re-run; the patch
   * is never retried. A status that does not match — including one moved by a
   * concurrent editor — is a real failure and surfaces, because a benign
   * no-op misreported as a failure still re-runs clean, while a real failure
   * misread as benign is the defect this client exists to avoid.
   */
  async transitionStatus(status: string): Promise<UpstreamOutcome> {
    const outcome = await this.patchIssue({ status });
    if (outcome.ok || outcome.reason !== "rejected" || outcome.status !== 422) {
      return outcome;
    }

    const issue = await this.fetchIssue() ?? await this.fetchIssue();
    if (issue?.status === status) {
      this.logInfo(
        "swamp-club issue is already {status} — transition was a no-op",
        { status },
      );
      return { ok: true, noop: true };
    }
    return outcome;
  }

  /**
   * Update the issue type. No benign case: patching a type to its current
   * value already succeeds, so a rejection here is always a real failure.
   */
  async updateType(type: IssueType): Promise<UpstreamOutcome> {
    return await this.patchIssue({ type });
  }

  /**
   * Fetch the list of eligible assignees. Returns null on any error
   * (401/403/network) — callers should treat failure as a warning, not a gate.
   */
  async fetchEligibleAssignees(): Promise<EligibleAssignee[] | null> {
    try {
      const url = `${this.baseUrl}/api/v1/lab/assignees`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.#apiKey}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.log("swamp-club fetch assignees failed: {status} {text}", {
          status: res.status,
          text,
        });
        return null;
      }
      const data = await res.json() as {
        assignees?: { userId?: string; username?: string }[];
      };
      return (data.assignees ?? []).filter(
        (a): a is EligibleAssignee =>
          typeof a.userId === "string" && typeof a.username === "string",
      );
    } catch (err) {
      this.log("swamp-club fetch assignees error: {error}", {
        error: String(err),
      });
      return null;
    }
  }

  /**
   * Resolve a username to a userId via the eligible-assignees endpoint.
   * Returns null if the lookup fails or the username is not found.
   */
  async resolveUserId(username: string): Promise<string | null> {
    const assignees = await this.fetchEligibleAssignees();
    if (!assignees) return null;
    const match = assignees.find((a) => a.username === username);
    return match?.userId ?? null;
  }

  /**
   * Post a comment (ripple) on the issue.
   *
   * Reports the outcome: for `notify` the ripple is the deliverable, not a
   * courtesy, so a caller must be able to tell a posted thank-you from a
   * dropped one.
   */
  async submitComment(body: string): Promise<UpstreamOutcome> {
    try {
      const url =
        `${this.baseUrl}/api/v1/lab/issues/${this.issueNumber}/comments`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.log("swamp-club submit comment failed: {status} {text}", {
          status: res.status,
          text,
        });
        return {
          ok: false,
          reason: "rejected",
          status: res.status,
          body: text,
        };
      }
      await res.body?.cancel();
      return { ok: true };
    } catch (err) {
      this.log("swamp-club submit comment error: {error}", {
        error: String(err),
      });
      return { ok: false, reason: "unavailable", detail: String(err) };
    }
  }

  /**
   * Update the issue's assignees. Deliberately best-effort: assignment is a
   * courtesy action, not an audit record, and must never break the triage
   * flow. `patchIssue` already logs the failure.
   */
  async updateAssignees(userIds: string[]): Promise<void> {
    await this.patchIssue({ assignees: userIds });
  }

  /**
   * PATCH the issue with a partial set of fields.
   *
   * Deliberately free of any benign-failure classification: this helper
   * carries status, type and assignees patches alike, so it cannot reason
   * about a target status it may not have been given. Callers that know what
   * they asked for interpret the outcome.
   */
  private async patchIssue(
    patch: Record<string, unknown>,
  ): Promise<UpstreamOutcome> {
    try {
      const url = `${this.baseUrl}/api/v1/lab/issues/${this.issueNumber}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.log("swamp-club patch failed: {status} {text}", {
          status: res.status,
          text,
        });
        return {
          ok: false,
          reason: "rejected",
          status: res.status,
          body: text,
        };
      }
      return { ok: true };
    } catch (err) {
      this.log("swamp-club patch error: {error}", {
        error: String(err),
      });
      return { ok: false, reason: "unavailable", detail: String(err) };
    }
  }
}

/**
 * Load credentials from ~/.config/swamp/auth.json (or $XDG_CONFIG_HOME/swamp/auth.json).
 * Returns { serverUrl, apiKey, username? } or null if the file doesn't exist.
 * Username is optional — older auth.json files and env-var auth may not have it.
 */
export async function loadAuthFile(): Promise<
  { serverUrl: string; apiKey: string; username?: string } | null
> {
  try {
    const xdg = Deno.env.get("XDG_CONFIG_HOME");
    const home = Deno.env.get("HOME");
    let configDir: string;
    if (xdg) {
      configDir = join(xdg, "swamp");
    } else if (home) {
      configDir = join(home, ".config", "swamp");
    } else {
      return null;
    }
    const content = await Deno.readTextFile(join(configDir, "auth.json"));
    const creds = JSON.parse(content) as {
      serverUrl?: string;
      apiKey?: string;
      username?: string;
    };
    if (creds.apiKey) {
      // Read-only domain migration: rewrite the legacy swamp.club URL to
      // the new domain so callers transparently hit the right host. The
      // CLI's AuthRepository persists the rewrite; here we don't own the
      // file, so we just translate at the read site.
      const serverUrl = creds.serverUrl === "https://swamp.club"
        ? "https://swamp-club.com"
        : creds.serverUrl ?? "https://swamp-club.com";
      return {
        serverUrl,
        apiKey: creds.apiKey,
        username: creds.username || undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Create a SwampClubClient if a URL and API key are available.
 * Precedence: explicit global args > SWAMP_API_KEY env var > auth.json file.
 */
export async function createSwampClubClient(
  globalArgs: {
    issueNumber: number;
    swampClubUrl?: string;
    swampClubApiKey?: string;
  },
  logger?: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warning: (msg: string, props: Record<string, unknown>) => void;
  },
): Promise<SwampClubClient | null> {
  let url = globalArgs.swampClubUrl ?? Deno.env.get("SWAMP_CLUB_URL");
  let apiKey = globalArgs.swampClubApiKey ?? Deno.env.get("SWAMP_API_KEY");

  if (!apiKey) {
    const fileCreds = await loadAuthFile();
    if (fileCreds) {
      apiKey = fileCreds.apiKey;
      url = url ?? fileCreds.serverUrl;
    }
  }

  url = url ?? "https://swamp-club.com";

  if (!apiKey) {
    logger?.warning(
      "No swamp-club credentials found (set SWAMP_API_KEY or run `swamp auth login`)",
      {},
    );
    return null;
  }

  // Reachability check — verify the swamp-club URL is accessible before proceeding
  try {
    const healthUrl = `${url}/healthz`;
    const res = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    await res.body?.cancel();
    if (!res.ok) {
      logger?.warning(
        "swamp-club at {url} returned HTTP {status}",
        { url, status: res.status },
      );
      return null;
    }
  } catch (err) {
    logger?.warning(
      "swamp-club at {url} is not reachable ({error})",
      { url, error: String(err) },
    );
    return null;
  }

  return new SwampClubClient(
    url,
    apiKey,
    globalArgs.issueNumber,
    logger,
  );
}
