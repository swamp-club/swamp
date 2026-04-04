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

export interface LifecycleEntryParams {
  step: string;
  targetStatus: string;
  summary: string;
  emoji: string;
  payload: Record<string, unknown>;
  body?: string;
  isVerbose?: boolean;
}

/**
 * HTTP client for posting structured lifecycle data to the swamp-club API.
 * Resolves the swamp-club issue ID lazily from the GitHub repo + issue number
 * using the /ensure endpoint. All operations are best-effort.
 */
export class SwampClubClient {
  private baseUrl: string;
  readonly #apiKey: string;
  private repo: string;
  private issueNumber: number;
  private log: (msg: string, props: Record<string, unknown>) => void;

  /** Cached swamp-club issue ID, resolved on first call. */
  private issueId: string | null = null;

  constructor(
    baseUrl: string,
    apiKey: string,
    repo: string,
    issueNumber: number,
    logger?: {
      info: (msg: string, props: Record<string, unknown>) => void;
      warning: (msg: string, props: Record<string, unknown>) => void;
    },
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#apiKey = apiKey;
    this.repo = repo;
    this.issueNumber = issueNumber;
    this.log = logger?.warning.bind(logger) ?? (() => {});
  }

  /**
   * Ensure the issue exists in swamp-club by GitHub repo + issue number.
   * Creates it if needed. Caches the issue ID for subsequent calls.
   * Must be called with the issue data (title, body, type) the first time.
   */
  async ensureIssue(params: {
    title: string;
    body: string;
    type?: string;
    githubAuthorLogin?: string;
  }): Promise<string | null> {
    if (this.issueId) return this.issueId;

    try {
      const url = `${this.baseUrl}/api/v1/lab/issues/ensure`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({
          githubRepoFullName: this.repo,
          githubIssueNumber: this.issueNumber,
          title: params.title,
          body: params.body,
          type: params.type ?? "feature",
          githubAuthorLogin: params.githubAuthorLogin,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.log("swamp-club ensure issue failed: {status} {text}", {
          status: res.status,
          text,
        });
        return null;
      }
      const data = await res.json() as {
        issue: { id: string };
        created: boolean;
      };
      const resolvedId = data.issue.id;
      // Validate UUID format to prevent path traversal
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          resolvedId,
        )
      ) {
        this.log("swamp-club returned invalid issue ID: {id}", {
          id: resolvedId,
        });
        return null;
      }
      this.issueId = resolvedId;
      return this.issueId;
    } catch (err) {
      this.log("swamp-club ensure issue error: {error}", {
        error: String(err),
      });
      return null;
    }
  }

  /** Post a structured lifecycle entry. Best-effort. Requires ensureIssue() first. */
  async postLifecycleEntry(params: LifecycleEntryParams): Promise<void> {
    if (!this.issueId) return;
    try {
      const url = `${this.baseUrl}/api/v1/lab/issues/${this.issueId}/lifecycle`;
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

  /** Transition the issue status. Best-effort. Requires ensureIssue() first. */
  async transitionStatus(status: string): Promise<void> {
    if (!this.issueId) return;
    try {
      const url = `${this.baseUrl}/api/v1/lab/issues/${this.issueId}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({ status }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.log("swamp-club status transition failed: {status} {text}", {
          status: res.status,
          text,
        });
      }
    } catch (err) {
      this.log("swamp-club status transition error: {error}", {
        error: String(err),
      });
    }
  }
}

/**
 * Load credentials from ~/.config/swamp/auth.json (or $XDG_CONFIG_HOME/swamp/auth.json).
 * Returns { serverUrl, apiKey } or null if the file doesn't exist.
 */
async function loadAuthFile(): Promise<
  { serverUrl: string; apiKey: string } | null
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
    };
    if (creds.apiKey) {
      return {
        serverUrl: creds.serverUrl ?? "https://swamp.club",
        apiKey: creds.apiKey,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Create a SwampClubClient if URL and API key are available.
 * Precedence: explicit global args > SWAMP_API_KEY env var > auth.json file.
 * The issue ID is resolved lazily — no swampClubIssueId arg needed.
 */
export async function createSwampClubClient(
  globalArgs: {
    repo: string;
    issueNumber: number;
    swampClubUrl?: string;
    swampClubApiKey?: string;
  },
  logger?: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warning: (msg: string, props: Record<string, unknown>) => void;
  },
): Promise<SwampClubClient | null> {
  // 1. Explicit args or env var
  let url = globalArgs.swampClubUrl ?? Deno.env.get("SWAMP_CLUB_URL");
  let apiKey = globalArgs.swampClubApiKey ?? Deno.env.get("SWAMP_API_KEY");

  // 2. Fall back to auth.json from `swamp auth login`
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
      "No swamp-club credentials found (set SWAMP_API_KEY or run `swamp auth login`) — lifecycle entries will be skipped",
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
        "swamp-club at {url} returned HTTP {status} — lifecycle entries will be skipped",
        { url, status: res.status },
      );
      return null;
    }
  } catch (err) {
    logger?.warning(
      "swamp-club at {url} is not reachable ({error}) — lifecycle entries will be skipped",
      { url, error: String(err) },
    );
    return null;
  }

  return new SwampClubClient(
    url,
    apiKey,
    globalArgs.repo,
    globalArgs.issueNumber,
    logger,
  );
}
