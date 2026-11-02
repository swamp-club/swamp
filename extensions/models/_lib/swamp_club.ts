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

import { join } from "@std/path";
import type { IssueType } from "./schemas.ts";
import {
  type ForwardStatus,
  parsePrNumber,
  statusPath,
} from "./issue_status.ts";

export const LIFECYCLE_SUMMARY_MAX_CHARS = 2000;

/**
 * rejected: the server refused, so a retry fails the same way. unavailable: no
 * answer. noop: the server had already applied the write
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

export type IssueRelationshipType =
  | "parent_of"
  | "blocked_by"
  | "related_to"
  | "duplicate_of";

export interface FetchedRelationship {
  id: string;
  type: IssueRelationshipType;
  direction: "outgoing" | "incoming";
  otherIssueNumber: number;
}

export interface FetchedIssue {
  number: number;
  type: IssueType;
  status: string;
  title: string;
  body: string;
  author: string;
  authorId?: string;
  comments: { author: string; body: string; createdAt: string }[];
  assignees: { userId: string; username: string }[];
  githubPrUrl?: string;
  lifecyclePrUrl?: string;
  relationships: FetchedRelationship[];
}

function prUrlFromEntries(
  entries: { step?: unknown; payload?: unknown }[],
): string | undefined {
  const urlOf = (step: string) => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.step !== step) continue;
      const url = (entry.payload as { url?: unknown } | undefined)?.url;
      if (typeof url === "string" && url.length > 0) return url;
    }
    return undefined;
  };
  return urlOf("pr_merged") ?? urlOf("pr_linked");
}

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

  forIssue(issueNumber: number): SwampClubClient {
    return new SwampClubClient(this.baseUrl, this.#apiKey, issueNumber, {
      info: this.logInfo,
      warning: this.log,
    });
  }

  labUrl(): string {
    return `${this.baseUrl}/lab/${this.issueNumber}`;
  }

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
          authorId?: unknown;
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
          githubPrUrl?: unknown;
        };
        lifecycleEntries?: { step?: unknown; payload?: unknown }[];
        relationships?: {
          id?: unknown;
          type?: unknown;
          direction?: unknown;
          sourceIssueNumber?: unknown;
          targetIssueNumber?: unknown;
        }[];
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
        // A non-string id would never match the roster, so a team member
        // would read as external; fall back to the handle instead.
        authorId: typeof issue.authorId === "string"
          ? issue.authorId
          : undefined,
        comments: (issue.comments ?? []).map((c) => ({
          author: c.authorUsername ?? c.author ?? "unknown",
          body: c.body ?? "",
          createdAt: c.createdAt ?? "",
        })),
        assignees: (issue.assignees ?? []).filter(
          (a): a is { userId: string; username: string } =>
            typeof a.userId === "string" && typeof a.username === "string",
        ),
        githubPrUrl: typeof issue.githubPrUrl === "string" &&
            issue.githubPrUrl.length > 0
          ? issue.githubPrUrl
          : undefined,
        lifecyclePrUrl: prUrlFromEntries(data.lifecycleEntries ?? []),
        relationships: (data.relationships ?? []).flatMap((r) => {
          if (
            typeof r.id !== "string" || typeof r.type !== "string" ||
            typeof r.sourceIssueNumber !== "number" ||
            typeof r.targetIssueNumber !== "number"
          ) return [];
          const direction = r.direction === "incoming"
            ? "incoming" as const
            : "outgoing" as const;
          return [{
            id: r.id,
            type: r.type as IssueRelationshipType,
            direction,
            otherIssueNumber: direction === "outgoing"
              ? r.targetIssueNumber
              : r.sourceIssueNumber,
          }];
        }),
      };
    } catch (err) {
      this.log("swamp-club fetch issue error: {error}", {
        error: String(err),
      });
      return null;
    }
  }

  /**
   * reports the outcome because an entry is the durable audit record and a
   * caller must tell recorded from dropped; failure policy lives in
   * lifecycle_recorder.ts
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
   * a 422 is benign only if a re-read shows the issue already has the status,
   * not by matching error prose. The patch is never retried; a mismatch, even
   * from a concurrent editor, surfaces as a failure
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

  async walkStatusTo(target: ForwardStatus): Promise<UpstreamOutcome> {
    const issue = await this.fetchIssue() ?? await this.fetchIssue();
    if (!issue) {
      return {
        ok: false,
        reason: "unavailable",
        detail: `could not read issue #${this.issueNumber} to find its status`,
      };
    }
    for (const status of statusPath(issue.status, target)) {
      const outcome = await this.transitionStatus(status);
      if (!outcome.ok) return outcome;
    }
    return { ok: true };
  }

  /**
   * the PR is a field of its own, independent of status, so it survives the
   * shipped transition into the reporter's notification
   */
  async linkPr(url: string): Promise<UpstreamOutcome> {
    const githubPrNumber = parsePrNumber(url);
    return await this.patchIssue(
      githubPrNumber === undefined
        ? { githubPrUrl: url }
        : { githubPrUrl: url, githubPrNumber },
    );
  }

  /**
   * Relate this issue to another. swamp-club returns the existing link when
   * the same one is added again, so a re-run is a no-op.
   */
  async addRelationship(
    type: IssueRelationshipType,
    targetIssueNumber: number,
  ): Promise<UpstreamOutcome> {
    return await this.sendRelationship("POST", { type, targetIssueNumber });
  }

  async removeRelationship(relationshipId: string): Promise<UpstreamOutcome> {
    return await this.sendRelationship("DELETE", { relationshipId });
  }

  private async sendRelationship(
    method: "POST" | "DELETE",
    body: Record<string, unknown>,
  ): Promise<UpstreamOutcome> {
    try {
      const url =
        `${this.baseUrl}/api/v1/lab/issues/${this.issueNumber}/relationships`;
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.log("swamp-club relationship {method} failed: {status} {text}", {
          method,
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
      this.log("swamp-club relationship {method} error: {error}", {
        method,
        error: String(err),
      });
      return { ok: false, reason: "unavailable", detail: String(err) };
    }
  }

  /**
   * no benign case: patching a type to its current value succeeds, so a
   * rejection is always a real failure
   */
  async updateType(type: IssueType): Promise<UpstreamOutcome> {
    return await this.patchIssue({ type });
  }

  /** returns null on any error; callers treat failure as a warning, not a gate */
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

  async resolveUserId(username: string): Promise<string | null> {
    const assignees = await this.fetchEligibleAssignees();
    if (!assignees) return null;
    const match = assignees.find((a) => a.username === username);
    return match?.userId ?? null;
  }

  /**
   * the ripple is notify's deliverable, so the outcome is reported: a caller
   * must tell a posted thank-you from a dropped one
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
   * best-effort on purpose: assignment is a courtesy and must never break
   * triage; patchIssue already logs the failure
   */
  async updateAssignees(userIds: string[]): Promise<void> {
    await this.patchIssue({ assignees: userIds });
  }

  /**
   * no benign-failure classification here, since it carries status, type and
   * assignee patches; callers that know what they asked for interpret the
   * outcome
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
      // rewrite the legacy swamp.club URL to the new domain at the read site;
      // the CLI's AuthRepository persists the rewrite, this code does not own
      // the file
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

/** precedence: explicit global args, then SWAMP_API_KEY env var, then auth.json */
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
