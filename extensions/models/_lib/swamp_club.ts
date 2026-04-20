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

// ---------------------------------------------------------------------------
// Swamp Club Lifecycle API Client
// ---------------------------------------------------------------------------

import { join } from "@std/path";
import type { IssueType } from "./schemas.ts";

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

  /** Post a structured lifecycle entry. Best-effort. */
  async postLifecycleEntry(params: LifecycleEntryParams): Promise<void> {
    try {
      const url =
        `${this.baseUrl}/api/v1/lab/issues/${this.issueNumber}/lifecycle`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({
          step: params.step,
          targetStatus: params.targetStatus,
          summary: params.summary,
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
      }
    } catch (err) {
      this.log("swamp-club lifecycle post error: {error}", {
        error: String(err),
      });
    }
  }

  /** Transition the issue status. Best-effort. */
  async transitionStatus(status: string): Promise<void> {
    await this.patchIssue({ status });
  }

  /** Update the issue type. Best-effort. */
  async updateType(type: IssueType): Promise<void> {
    await this.patchIssue({ type });
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

  /** Update the issue's assignees. Best-effort (same as other PATCH helpers). */
  async updateAssignees(userIds: string[]): Promise<void> {
    await this.patchIssue({ assignees: userIds });
  }

  /** PATCH the issue with a partial set of fields. Best-effort. */
  private async patchIssue(
    patch: Record<string, unknown>,
  ): Promise<void> {
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
      }
    } catch (err) {
      this.log("swamp-club patch error: {error}", {
        error: String(err),
      });
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
      return {
        serverUrl: creds.serverUrl ?? "https://swamp.club",
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

  url = url ?? "https://swamp.club";

  if (!apiKey) {
    logger?.warning(
      "No swamp-club credentials found (set SWAMP_API_KEY or run `swamp auth login`)",
      {},
    );
    return null;
  }

  // Reachability check — verify the swamp-club URL is accessible before proceeding
  try {
    const healthUrl = `${url}/api/health`;
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
