// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { UserError } from "../../domain/errors.ts";
import {
  type ClientIdentity,
  mergeIdentityHeaders,
} from "./client_identity.ts";
import { parseRetryAfter, rateLimitError } from "./rate_limit.ts";

export type { ClientIdentity };

/** Response from BetterAuth sign-in endpoint. */
export interface SignInResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    username: string;
  };
}

/** Response from BetterAuth API key creation endpoint. */
export interface CreateApiKeyResponse {
  id: string;
  key: string;
}

/** An organization the user belongs to. */
export interface WhoamiOrganization {
  slug: string;
  name: string;
  role: string;
  personal: boolean;
}

/** Response from the /api/whoami endpoint. */
export interface WhoamiResponse {
  authenticated: boolean;
  id?: string;
  username?: string;
  email?: string;
  name?: string;
  organizations?: WhoamiOrganization[];
}

/**
 * Returns the user's collectives (organization slugs) from a whoami response.
 * Returns undefined if the server doesn't include organizations.
 */
export function getCollectives(
  whoami: WhoamiResponse,
): string[] | undefined {
  if (!whoami.organizations) return undefined;
  return whoami.organizations.map((org) => org.slug);
}

/** Response from fetching a Lab issue by number. */
export interface FetchIssueResponse {
  number: number;
  title: string;
  type: string;
  status: string;
  author: string;
  body: string;
  assignees: string[];
  commentCount: number;
}

/** Filters for the issue search endpoint. */
export interface SearchIssuesFilter {
  q?: string;
  type?: string;
  status?: string;
  source?: string;
  limit?: number;
  offset?: number;
}

/** Response from the issue search/list endpoint. */
export interface SearchIssuesResponse {
  issues: FetchIssueResponse[];
  total: number;
}

/**
 * HTTP client for swamp-club API interactions.
 * Used by auth commands to sign in, create API keys, and verify identity.
 */
export class SwampClubClient {
  constructor(
    private readonly serverUrl: string,
    private readonly identity: ClientIdentity = {},
  ) {}

  /**
   * Sign in with email/username and password.
   * Returns session token and user info.
   */
  async signIn(
    username: string,
    password: string,
  ): Promise<SignInResponse> {
    const res = await this.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: username, password }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new UserError("Invalid username/email or password.");
      }
      throw new UserError(
        `Sign-in failed (HTTP ${res.status}): ${body}`,
      );
    }

    const data = await res.json();
    return {
      token: data.token,
      user: data.user,
    };
  }

  /**
   * Create an API key for the authenticated user.
   * Requires a session token from sign-in.
   */
  async createApiKey(
    sessionToken: string,
    name: string,
  ): Promise<CreateApiKeyResponse> {
    const res = await this.fetch("/api/auth/api-key/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new UserError(
        `Failed to create API key (HTTP ${res.status}): ${body}`,
      );
    }

    const data = await res.json();
    return { id: data.id, key: data.key };
  }

  /**
   * Call /api/whoami to verify identity.
   * Authenticates using the x-api-key header.
   */
  async whoami(
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<WhoamiResponse> {
    const res = await this.fetch(
      "/api/whoami",
      { method: "GET", headers: { "x-api-key": apiKey } },
      signal,
    );

    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401) {
        return { authenticated: false };
      }
      throw new UserError(
        `Whoami request failed (HTTP ${res.status})`,
      );
    }

    return await res.json();
  }

  /**
   * Submit a bug report or feature request to the Lab.
   * Authenticates using the x-api-key header. Tags every submission with
   * `source: "swamp"` so the Lab UI can attribute it to the CLI.
   */
  async submitIssue(
    apiKey: string,
    input: {
      type: "bug" | "feature" | "security";
      title: string;
      body: string;
    },
  ): Promise<{ number: number; id: string }> {
    const res = await this.fetch("/api/v1/lab/issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        source: "swamp",
        type: input.type,
        title: input.title,
        body: input.body,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new UserError(
        `Failed to submit issue (HTTP ${res.status}): ${body}`,
      );
    }

    const data = await res.json();
    return { number: data.issue.number, id: data.issue.id };
  }

  /**
   * Post a comment ("ripple") on an existing Lab issue.
   * Authenticates using the x-api-key header.
   *
   * Surfaces server-side error shapes the Lab returns:
   *   - 401 → not logged in
   *   - 403 → comments locked or no access
   *   - 404 → issue not found / not visible
   *   - 422 → profanity check failed (response includes `flagged` array)
   */
  async submitComment(
    apiKey: string,
    issueNumber: number,
    body: string,
  ): Promise<{ id: string }> {
    const res = await this.fetch(
      `/api/v1/lab/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ body }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      // Try to surface profanity-flagged words from the 422 body so the
      // user knows what to change without paging through raw JSON.
      if (res.status === 422) {
        try {
          const parsed = JSON.parse(text);
          if (
            parsed?.error && Array.isArray(parsed.flagged) &&
            parsed.flagged.length > 0
          ) {
            throw new UserError(
              `${parsed.error}: ${parsed.flagged.join(", ")}`,
            );
          }
        } catch (err) {
          if (err instanceof UserError) throw err;
          // fall through to the generic message below
        }
      }
      throw new UserError(
        `Failed to post ripple on issue #${issueNumber} (HTTP ${res.status}): ${text}`,
      );
    }

    const data = await res.json();
    return { id: data.id };
  }

  /**
   * Update the status of an existing Lab issue (close or reopen).
   * Authenticates using the x-api-key header.
   */
  async updateIssueStatus(
    apiKey: string,
    issueNumber: number,
    status: "closed" | "open",
  ): Promise<{ status: string }> {
    const res = await this.fetch(
      `/api/v1/lab/issues/${issueNumber}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ status }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404) {
        throw new UserError(`Issue #${issueNumber} not found.`);
      }
      throw new UserError(
        `Failed to update issue #${issueNumber} status (HTTP ${res.status}): ${text}`,
      );
    }

    const data = await res.json();
    return { status: data.issue.status };
  }

  /**
   * Update the title and/or body of an existing Lab issue.
   * Authenticates using the x-api-key header.
   */
  async updateIssue(
    apiKey: string,
    issueNumber: number,
    fields: { title?: string; body?: string },
  ): Promise<{ title: string; body: string }> {
    const res = await this.fetch(
      `/api/v1/lab/issues/${issueNumber}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(fields),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404) {
        throw new UserError(`Issue #${issueNumber} not found.`);
      }
      if (res.status === 403) {
        throw new UserError(
          `You do not have permission to edit issue #${issueNumber}.`,
        );
      }
      if (res.status === 422) {
        try {
          const parsed = JSON.parse(text);
          if (
            parsed?.error && Array.isArray(parsed.flagged) &&
            parsed.flagged.length > 0
          ) {
            throw new UserError(
              `${parsed.error}: ${parsed.flagged.join(", ")}`,
            );
          }
        } catch (err) {
          if (err instanceof UserError) throw err;
        }
      }
      throw new UserError(
        `Failed to update issue #${issueNumber} (HTTP ${res.status}): ${text}`,
      );
    }

    const data = await res.json();
    return { title: data.issue.title, body: data.issue.body };
  }

  /**
   * Fetch an existing Lab issue by number.
   * When an API key is provided, authenticates using the x-api-key header.
   */
  async fetchIssue(
    apiKey: string | undefined,
    issueNumber: number,
  ): Promise<FetchIssueResponse> {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    const res = await this.fetch(`/api/v1/lab/issues/${issueNumber}`, {
      method: "GET",
      headers,
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404) {
        throw new UserError(`Issue #${issueNumber} not found.`);
      }
      throw new UserError(
        `Failed to fetch issue #${issueNumber} (HTTP ${res.status}): ${text}`,
      );
    }

    const data = await res.json();
    const issue = data.issue;
    return {
      number: issue.number,
      title: issue.title ?? "",
      type: issue.type ?? "feature",
      status: issue.status ?? "open",
      author: issue.authorUsername ?? "unknown",
      body: issue.body ?? "",
      assignees: (issue.assignees ?? [])
        .filter(
          (a: Record<string, unknown>) => typeof a.username === "string",
        )
        .map((a: Record<string, string>) => a.username),
      commentCount: (issue.comments ?? []).length,
    };
  }

  /**
   * Search or list Lab issues with optional filters.
   * When an API key is provided, authenticates using the x-api-key header.
   */
  async searchIssues(
    apiKey: string | undefined,
    filter?: SearchIssuesFilter,
  ): Promise<SearchIssuesResponse> {
    const params = new URLSearchParams();
    if (filter?.q) params.set("q", filter.q);
    if (filter?.type) params.set("type", filter.type);
    if (filter?.status) params.set("status", filter.status);
    if (filter?.source) params.set("source", filter.source);
    if (filter?.limit !== undefined) {
      params.set("limit", String(filter.limit));
    }
    if (filter?.offset !== undefined) {
      params.set("offset", String(filter.offset));
    }
    const qs = params.toString();
    const path = `/api/v1/lab/issues${qs ? `?${qs}` : ""}`;

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    const res = await this.fetch(path, { method: "GET", headers });

    if (!res.ok) {
      const text = await res.text();
      throw new UserError(
        `Failed to search issues (HTTP ${res.status}): ${text}`,
      );
    }

    const data = await res.json();
    const issues: FetchIssueResponse[] = (data.issues ?? []).map(
      // deno-lint-ignore no-explicit-any
      (issue: any) => ({
        number: issue.number,
        title: issue.title ?? "",
        type: issue.type ?? "feature",
        status: issue.status ?? "open",
        author: issue.authorUsername ?? "unknown",
        body: issue.body ?? "",
        assignees: (issue.assignees ?? [])
          .filter(
            (a: Record<string, unknown>) => typeof a.username === "string",
          )
          .map((a: Record<string, string>) => a.username),
        commentCount: (issue.comments ?? []).length,
      }),
    );

    return { issues, total: data.total ?? issues.length };
  }

  private async fetch(
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const url = `${this.serverUrl}${path}`;
    const timeoutSignal = AbortSignal.timeout(15000);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    // Merge identity headers FIRST so any caller-supplied header in
    // init.headers wins on conflict. Required so per-call x-api-key /
    // Authorization values (e.g. signIn, getCurrentUser session token,
    // whoami) override the constructor identity.
    const headers = mergeIdentityHeaders(this.identity, init.headers);
    try {
      const res = await fetch(url, { ...init, headers, signal });
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        await res.body?.cancel();
        throw rateLimitError(retryAfter);
      }
      return res;
    } catch (error) {
      if (error instanceof UserError) throw error;
      // Re-throw AbortError from caller signal without wrapping
      if (
        callerSignal?.aborted && error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new UserError(
          `Request to ${this.serverUrl} timed out. Is the server running?`,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(
        `Could not connect to ${this.serverUrl}: ${message}`,
      );
    }
  }
}
