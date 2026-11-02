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

import { UserError } from "../../domain/errors.ts";
import {
  type ClientIdentity,
  mergeIdentityHeaders,
} from "./client_identity.ts";
import type { Fetcher } from "./recording_fetcher.ts";
import {
  DEFAULT_ISSUE_FILING_SOURCE,
  type IssueFilingSource,
} from "../../domain/issues/issue_source.ts";
import {
  fetchWithRateLimitRetry,
  hasCredential,
  parseRetryAfter,
  rateLimitError,
  readRateLimit,
  type Sleep,
} from "./rate_limit.ts";
import type { GenesisPass } from "../../domain/quest/genesis_pass.ts";
import {
  type AccountNoticesResult,
  MAX_ACCOUNT_NOTICES_BODY_BYTES,
  NOTICES_REQUIRE_USER,
  parseAccountNotices,
  parseAccountNoticesErrorCode,
} from "./account_notice_schemas.ts";
import type { IdentityCheckOutcome } from "../../domain/auth/auth_gate_policy.ts";
import { sanitizeFieldText } from "../../domain/vaults/vault_config_fields.ts";
import {
  INBOX_REQUIRES_USER,
  type InboxListOptions,
  type InboxMessage,
  type InboxMessagePage,
  type InboxSummaryResult,
  parseInboxErrorCode,
  parseInboxMessage,
  parseInboxMessagePage,
  parseInboxReadIds,
  parseInboxSummary,
} from "./inbox_schemas.ts";

export type { ClientIdentity };

const NO_INBOX_MESSAGE = "This Swamp Club server has no inbox.";
const INBOX_REQUIRES_USER_MESSAGE =
  "The inbox needs a personal API key; collective keys have no inbox.";
const MARK_READ_BATCH_SIZE = 100;

/**
 * The parsed JSON body, or undefined when it is not JSON. A body that could
 * not be read (an abort, a timeout, a dropped connection) still throws: it
 * says nothing about the body's shape.
 */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const TOO_LARGE: unique symbol = Symbol("too large");

// stops once over the cap: an untrusted server can't make it hold a large body
async function readCappedJson(
  res: Response,
  maxBytes: number,
): Promise<unknown | typeof TOO_LARGE> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    return TOO_LARGE;
  }
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export interface IdentityCheckResult {
  readonly outcome: IdentityCheckOutcome;
  readonly response?: WhoamiResponse;
}

async function isWhoamiRejection(res: Response): Promise<boolean> {
  try {
    const body = await res.json();
    return typeof body === "object" && body !== null &&
      body.authenticated === false;
  } catch {
    return false;
  }
}

export interface CollectiveTokenMetadata {
  id: string;
  name: string;
  keyPrefix: string;
  fingerprint?: string;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  scopes: string[];
}

export interface CreateCollectiveTokenResponse {
  token: CollectiveTokenMetadata;
  key: string;
  /**
   * signed proof for key, set as SWAMP_SIGNIN_TOKEN so CI passes the auth gate
   * while swamp-club is unreachable; absent from older servers or when signing
   * failed
   */
  signinToken?: string;
}

export interface ListCollectiveTokensResponse {
  tokens: CollectiveTokenMetadata[];
}

export type RevokePresentingApiKeyResult =
  | { kind: "revoked"; id: string }
  | { kind: "already_invalid" }
  | { kind: "not_personal_key" }
  | { kind: "unsupported" };

const MAX_ERROR_BODY_CHARS = 200;

export interface SignInResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    username: string;
  };
}

export interface CreateApiKeyResponse {
  id: string;
  key: string;
}

/**
 * server-computed and elapsed-based, so timezone-independent; render
 * daysRemaining as given, since recomputing from endsAt locally reintroduces
 * the zone bug
 */
export interface WhoamiTrial {
  state: "none" | "active" | "expired";
  startedAt: string | null;
  endsAt: string | null;
  trigger?: string | null;
  dayNumber?: number;
  daysRemaining: number;
  totalDays?: number;
}

/**
 * membership only, no billing: push and pull authorize namespace ownership from
 * this list, so entitlement travels in collectiveEntitlements instead
 */
export interface WhoamiOrganization {
  slug: string;
  name: string;
  role: string;
  personal: boolean;
}

/**
 * all fields but slug are optional: a self-hosted or older swamp-club sends no
 * entitlement, and whoami must not error then
 */
export interface WhoamiCollectiveEntitlementResponse {
  slug: string;
  plan?: string;
  planName?: string;
  /** Owner/admin only — the server omits it for plain members. */
  subscriptionStatus?: string | null;
  trial?: WhoamiTrial | null;
  /**
   * The registry's verdict on private extensions for the collective
   * (`allowed`, `trial-ended` or `paywalled` today). Kept as a string so a
   * value added later reaches the caller instead of failing the parse.
   */
  privateExtensions?: string;
}

/**
 * its own field, like entitlements: it feeds only the local quality rubric,
 * never publish authorization
 */
export interface WhoamiCollectiveSourceHostingResponse {
  slug: string;
  privateSourceHosting: boolean;
  /** A first publish in this namespace is private whatever the manifest says. */
  privateNamespace: boolean;
}

export interface WhoamiResponse {
  authenticated: boolean;
  id?: string;
  username?: string;
  email?: string;
  name?: string;
  plan?: string;
  organizations?: WhoamiOrganization[];
  collectiveEntitlements?: WhoamiCollectiveEntitlementResponse[];
  collectiveSourceHosting?: WhoamiCollectiveSourceHostingResponse[];
  collectiveToken?: boolean;
  collectiveId?: string;
  collectiveSlug?: string;
  scopes?: string[];
  verificationProof?: string;
  verificationSignature?: string;
  publicKeys?: Array<{ kid: string; key: string }>;
}

/**
 * slugs only, undefined when the server sends no organizations; push and pull
 * authorize namespace ownership from this list
 */
export function getCollectives(
  whoami: WhoamiResponse,
): string[] | undefined {
  if (!whoami.organizations) return undefined;
  return whoami.organizations.map((org) => org.slug);
}

export interface IssueCommentRecord {
  author: string;
  body: string;
  createdAt: string;
}

export interface FetchIssueResponse {
  number: number;
  title: string;
  type: string;
  status: string;
  author: string;
  body: string;
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  comments: IssueCommentRecord[];
}

/**
 * the code is stable and never expires; use url verbatim, since the server
 * builds it from its canonical origin and rebuilding it from code would guess
 * the host
 */
export interface FetchRecruitLinkResponse {
  code: string;
  url: string;
}

export interface SearchIssuesFilter {
  q?: string;
  type?: string;
  status?: string;
  source?: string;
  limit?: number;
  offset?: number;
}

export interface SearchIssuesResponse {
  issues: FetchIssueResponse[];
  total: number;
}

export class SwampClubClient {
  constructor(
    private readonly serverUrl: string,
    private readonly identity: ClientIdentity = {},
    private readonly options: { sleep?: Sleep; fetch?: Fetcher } = {},
  ) {}

  async signIn(
    credential: string,
    password: string,
  ): Promise<SignInResponse> {
    const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(credential);
    const endpoint = isEmail
      ? "/api/auth/sign-in/email"
      : "/api/auth/sign-in/username";
    const body = isEmail
      ? { email: credential, password }
      : { username: credential, password };

    const res = await this.fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
   * classifies instead of throwing: timeouts, refused connections and 429 are
   * outcomes, so the gate can tell swamp-club saying no from failing, from a
   * client-provoked refusal, from no answer
   */
  async verifyIdentity(
    apiKey: string,
    signal: AbortSignal,
  ): Promise<IdentityCheckResult> {
    const headers = mergeIdentityHeaders(this.identity, {
      "x-api-key": apiKey,
    });
    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}/api/whoami`, {
        method: "GET",
        headers,
        signal,
      });
    } catch (error) {
      const reason = error instanceof DOMException &&
          (error.name === "TimeoutError" || error.name === "AbortError")
        ? "timeout"
        : "connection failed";
      return { outcome: { kind: "unreachable", reason } };
    }

    const status = res.status;
    // The signal also bounds reading the body. A body cut off by it is a
    // slow link, not a refusal.
    const refusedUnlessTimedOut = (): IdentityCheckResult =>
      signal.aborted
        ? { outcome: { kind: "unreachable", reason: "timeout" } }
        : { outcome: { kind: "refused", status } };
    if (status === 401) {
      // swamp-club's whoami answers an unknown key with exactly
      // `{ "authenticated": false }`. A gateway can send its own 401 (or
      // strip x-api-key) while the key is fine, so only that body counts.
      return await isWhoamiRejection(res)
        ? { outcome: { kind: "rejected", status } }
        : refusedUnlessTimedOut();
    }
    if (status === 403) {
      // whoami never answers 403, so it comes from a gateway whose own error
      // body must not count as rejection and delete a good proof; refused still
      // blocks without a proof
      await res.body?.cancel();
      return refusedUnlessTimedOut();
    }
    if (status === 429) {
      const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
      await res.body?.cancel();
      return { outcome: { kind: "refused", status, retryAfterSeconds } };
    }
    if (status >= 500) {
      await res.body?.cancel();
      return { outcome: { kind: "server_error", status } };
    }
    if (!res.ok) {
      // Anything else (a 404 from a misrouted proxy, say) is not swamp-club
      // judging the key.
      await res.body?.cancel();
      return { outcome: { kind: "refused", status } };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // A 200 that is not JSON is a captive portal or a broken proxy, not a
      // verification.
      return refusedUnlessTimedOut();
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { outcome: { kind: "refused", status } };
    }
    const response = body as WhoamiResponse;
    // only swamp-club's own authenticated true or false counts; any other
    // object, such as a proxy's 200 {}, says nothing about the key and must
    // never delete a good proof
    if (response.authenticated === false) {
      return { outcome: { kind: "rejected", status } };
    }
    if (response.authenticated !== true) {
      return { outcome: { kind: "refused", status } };
    }
    const freshProof = Boolean(
      response.verificationProof && response.verificationSignature &&
        response.publicKeys,
    );
    return { outcome: { kind: "verified", freshProof }, response };
  }

  async submitIssue(
    apiKey: string,
    input: {
      type: "bug" | "feature" | "security";
      title: string;
      body: string;
      source?: IssueFilingSource;
    },
    signal?: AbortSignal,
  ): Promise<{ number: number; id: string }> {
    const maxAttempts = 3;
    const backoffMs = [2_000, 4_000];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await this.fetch(
          "/api/v1/lab/issues",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
            },
            body: JSON.stringify({
              source: input.source ?? DEFAULT_ISSUE_FILING_SOURCE,
              type: input.type,
              title: input.title,
              body: input.body,
            }),
          },
          signal,
          60_000,
        );

        if (!res.ok) {
          const body = await res.text();
          throw new UserError(
            `Failed to submit issue (HTTP ${res.status}): ${body}`,
          );
        }

        const data = await res.json();
        return { number: data.issue.number, id: data.issue.id };
      } catch (error) {
        const isTimeout = error instanceof UserError &&
          error.code === "timeout";
        const isLastAttempt = attempt === maxAttempts - 1;
        if (!isTimeout || isLastAttempt) throw error;

        const delay = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1];
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          const timer = setTimeout(resolve, delay);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
      }
    }

    throw new Error("unreachable");
  }

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
    if (typeof data.id !== "string" || data.id.length === 0) {
      throw new UserError(
        `Server accepted the ripple on issue #${issueNumber} but did not return a comment ID. The ripple may not have been saved.`,
      );
    }
    return { id: data.id };
  }

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

  async updateIssue(
    apiKey: string,
    issueNumber: number,
    fields: { title?: string; body?: string; type?: string },
  ): Promise<{ title: string; body: string; type: string }> {
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
    return {
      title: data.issue.title,
      body: data.issue.body,
      type: data.issue.type,
    };
  }

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
    const rawComments: Record<string, unknown>[] = data.comments ?? [];
    return {
      number: issue.number,
      title: issue.title ?? "",
      type: issue.type ?? "feature",
      status: issue.status ?? "open",
      author: issue.authorUsername ?? "unknown",
      createdAt: issue.createdAt ?? "",
      updatedAt: issue.updatedAt ?? "",
      body: issue.body ?? "",
      assignees: (issue.assignees ?? [])
        .filter(
          (a: Record<string, unknown>) => typeof a.username === "string",
        )
        .map((a: Record<string, string>) => a.username),
      commentCount: rawComments.length,
      comments: rawComments.map((c: Record<string, unknown>) => ({
        author: (c.authorUsername as string | undefined) ??
          (c.author as string | undefined) ?? "unknown",
        body: (c.body as string | undefined) ?? "",
        createdAt: (c.createdAt as string | undefined) ?? "",
      })),
    };
  }

  /**
   * identity-scoped with no anonymous form, so callers check credentials first
   * and the 401 branch is a backstop; lifts the server's error string behind a
   * status prefix rather than dumping a JSON envelope
   */
  async fetchRecruitLink(
    apiKey: string | undefined,
  ): Promise<FetchRecruitLinkResponse> {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    const res = await this.fetch("/api/v1/recruit-link", {
      method: "POST",
      headers,
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        throw new UserError(
          'Not logged in. Run "swamp auth login", or set SWAMP_API_KEY, to get your recruit link.',
        );
      }
      let message = text;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.error === "string") {
          message = parsed.error;
        }
      } catch {
        // Not JSON — fall back to the raw body.
      }
      throw new UserError(
        `Could not get your recruit link (HTTP ${res.status}): ${message}`,
      );
    }

    const data = await res.json();
    return { code: data.code, url: data.url };
  }

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
        createdAt: issue.createdAt ?? "",
        updatedAt: issue.updatedAt ?? "",
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

  /**
   * public read keyed by username, no x-api-key; canClaim is true only for the
   * owner's web session, so the CLI renders read-only
   */
  async fetchGenesisPass(
    username: string,
    signal?: AbortSignal,
  ): Promise<GenesisPass> {
    const res = await this.fetch(
      `/api/u/${encodeURIComponent(username)}/genesis`,
      { method: "GET", headers: {} },
      signal,
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404) {
        throw new UserError(`No quest pass found for ${username}.`);
      }
      throw new UserError(
        `Failed to fetch quest pass (HTTP ${res.status}): ${text}`,
      );
    }

    return await res.json();
  }

  /**
   * unauthenticated pass keyed by the device's Swamp-Distinct-Id; every reward
   * reads unclaimed until the id is bound to an account
   */
  async fetchGhostGenesisPass(
    signal?: AbortSignal,
  ): Promise<GenesisPass> {
    const res = await this.fetch(
      "/api/quest/genesis/ghost",
      { method: "GET", headers: {} },
      signal,
    );

    if (!res.ok) {
      const text = await res.text();
      throw new UserError(
        `Failed to fetch ghost quest pass (HTTP ${res.status}): ${text}`,
      );
    }

    return await res.json();
  }

  /**
   * Create a scoped API token for a collective.
   * Requires a personal API key — collective tokens cannot create other tokens.
   */
  async createCollectiveToken(
    apiKey: string,
    collectiveSlug: string,
    input: { name: string; scopes: string[] },
    signal?: AbortSignal,
  ): Promise<CreateCollectiveTokenResponse> {
    const res = await this.fetch(
      `/api/v1/collectives/${encodeURIComponent(collectiveSlug)}/api-tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ name: input.name, scopes: input.scopes }),
      },
      signal,
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        throw new UserError(
          "Not authenticated. Sign in with `swamp auth login`.",
        );
      }
      if (res.status === 403) {
        throw new UserError(
          `You do not have permission to create tokens for collective "${collectiveSlug}". Only owners and admins can manage collective API tokens.`,
        );
      }
      if (res.status === 404) {
        throw new UserError(
          `Collective "${collectiveSlug}" not found.`,
        );
      }
      if (res.status === 422) {
        let message = text;
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed?.error === "string") {
            message = parsed.error;
          }
        } catch {
          // use raw text
        }
        throw new UserError(`Invalid token request: ${message}`);
      }
      throw new UserError(
        `Failed to create collective token (HTTP ${res.status}): ${text}`,
      );
    }

    return await res.json();
  }

  async listCollectiveTokens(
    apiKey: string,
    collectiveSlug: string,
    signal?: AbortSignal,
  ): Promise<ListCollectiveTokensResponse> {
    const res = await this.fetch(
      `/api/v1/collectives/${encodeURIComponent(collectiveSlug)}/api-tokens`,
      {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
        },
      },
      signal,
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        throw new UserError(
          "Not authenticated. Sign in with `swamp auth login`.",
        );
      }
      if (res.status === 403) {
        throw new UserError(
          `You do not have permission to list tokens for collective "${collectiveSlug}". Only owners and admins can manage collective API tokens.`,
        );
      }
      if (res.status === 404) {
        throw new UserError(
          `Collective "${collectiveSlug}" not found.`,
        );
      }
      throw new UserError(
        `Failed to list collective tokens (HTTP ${res.status}): ${text}`,
      );
    }

    return await res.json();
  }

  /**
   * swamp-club answers a successful DELETE with {ok:true} and no metadata, so a
   * 2xx counts as revoked only when its body confirms it; any other answer
   * throws UserError
   */
  async revokeCollectiveToken(
    apiKey: string,
    collectiveSlug: string,
    tokenId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.fetch(
      `/api/v1/collectives/${encodeURIComponent(collectiveSlug)}/api-tokens/${
        encodeURIComponent(tokenId)
      }`,
      {
        method: "DELETE",
        headers: {
          "x-api-key": apiKey,
        },
      },
      signal,
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        throw new UserError(
          "Not authenticated. Sign in with `swamp auth login`.",
        );
      }
      if (res.status === 403) {
        throw new UserError(
          `You do not have permission to revoke tokens for collective "${collectiveSlug}". Only owners and admins can manage collective API tokens.`,
        );
      }
      let serverError: unknown;
      try {
        serverError = (JSON.parse(text) as { error?: unknown })?.error;
      } catch {
        serverError = undefined;
      }
      // an older swamp-club answers an unknown token with 422
      if (
        (res.status === 404 || res.status === 422) &&
        serverError === "Token not found"
      ) {
        throw new UserError(
          `Token "${tokenId}" not found in collective "${collectiveSlug}".`,
        );
      }
      if (res.status === 404) {
        throw new UserError(
          `Collective "${collectiveSlug}" not found.`,
        );
      }
      throw new UserError(
        `Failed to revoke collective token (HTTP ${res.status}): ${text}`,
      );
    }

    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      // Only the caller's own abort stays an AbortError (the fetch wrapper's rule).
      if (
        signal?.aborted && error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(
        `Lost the connection to ${this.serverUrl} while reading its response, so whether token "${tokenId}" was revoked is unknown: ${message}. Check with \`swamp auth token list --collective ${collectiveSlug}\`.`,
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (
      typeof data !== "object" || data === null ||
      (data as Record<string, unknown>).ok !== true
    ) {
      throw new UserError(
        `${this.serverUrl} answered HTTP ${res.status} without confirming token "${tokenId}" was revoked from collective "${collectiveSlug}". Check with \`swamp auth token list --collective ${collectiveSlug}\`.`,
      );
    }
  }

  /**
   * the server derives the key id from the credential, so a key can only revoke
   * itself; a 2xx counts only when its body confirms it, other answers throw so
   * failure is never mistaken for revocation
   */
  async revokePresentingApiKey(
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<RevokePresentingApiKeyResult> {
    const res = await this.fetch(
      "/api/v1/me/api-key",
      {
        method: "DELETE",
        headers: {
          "x-api-key": apiKey,
        },
      },
      signal,
    );

    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      // Only the caller's own abort stays an AbortError (the fetch wrapper's rule).
      if (
        signal?.aborted && error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(
        `Lost the connection to ${this.serverUrl} while reading its response: ${message}`,
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const fields = typeof data === "object" && data !== null
      ? data as Record<string, unknown>
      : {};

    if (res.ok) {
      if (fields.revoked === true) {
        return {
          kind: "revoked",
          id: typeof fields.id === "string" ? fields.id : "",
        };
      }
      throw new UserError(
        `${this.serverUrl} answered HTTP ${res.status} without confirming the API key was revoked.`,
      );
    }
    // 401 and 403 count only with the exact bodies swamp-club's route sends: a
    // proxy or gateway can answer them on its own (or strip x-api-key) while
    // the key is still valid, e.g. with {"error":"invalid_token"}.
    if (res.status === 401) {
      if (fields.error === "Unauthorized") return { kind: "already_invalid" };
      throw new UserError(
        `${this.serverUrl} answered HTTP 401 without a swamp-club error body, so it is unclear whether the API key is still valid.`,
      );
    }
    if (
      res.status === 403 &&
      fields.error === "Only a personal API key can revoke itself"
    ) {
      return { kind: "not_personal_key" };
    }
    if (res.status === 404) return { kind: "unsupported" };

    const flat = text.replace(/\s+/g, " ").trim();
    const body = flat.length > MAX_ERROR_BODY_CHARS
      ? `${flat.slice(0, MAX_ERROR_BODY_CHARS)}…`
      : flat;
    throw new UserError(
      body
        ? `${this.serverUrl} answered HTTP ${res.status}: ${body}`
        : `${this.serverUrl} answered HTTP ${res.status}.`,
    );
  }

  /**
   * never throws: the background poll is best effort, so failures are result
   * cases; bypasses the shared fetch helper because a Retry-After sleep would
   * hold teardown
   */
  async inboxSummary(
    apiKey: string,
    etag: string | null,
    signal: AbortSignal,
  ): Promise<InboxSummaryResult> {
    let headers: Headers;
    try {
      headers = mergeIdentityHeaders(this.identity, {
        "x-api-key": apiKey,
        ...(etag !== null ? { "If-None-Match": etag } : {}),
      });
    } catch {
      // A key or a cached etag holding a character no header may carry.
      return { kind: "failed", reason: "invalid request header" };
    }
    const doFetch = this.options.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.serverUrl}/api/inbox/summary`, {
        method: "GET",
        headers,
        signal,
      });
    } catch (error) {
      const reason = signal.aborted ||
          (error instanceof DOMException &&
            (error.name === "TimeoutError" || error.name === "AbortError"))
        ? "timeout"
        : "connection failed";
      return { kind: "failed", reason };
    }

    const status = res.status;
    // The signal also bounds reading the body; a body cut off by it is a
    // slow link, not a malformed answer.
    const failed = (reason: string): InboxSummaryResult => ({
      kind: "failed",
      reason: signal.aborted ? "timeout" : reason,
    });
    try {
      if (status === 304) {
        await res.body?.cancel();
        return { kind: "not_modified" };
      }
      if (status === 401) {
        await res.body?.cancel();
        return { kind: "rejected" };
      }
      if (status === 403) {
        // Only swamp-club's own body means a collective key; a gateway's
        // 403 says nothing about the inbox.
        return parseInboxErrorCode(await readJson(res)) === INBOX_REQUIRES_USER
          ? { kind: "unavailable" }
          : failed(`HTTP ${status}`);
      }
      if (status === 404) {
        await res.body?.cancel();
        return { kind: "unsupported" };
      }
      if (status === 429) {
        const retryAfterSeconds = parseRetryAfter(
          res.headers.get("retry-after"),
        );
        await res.body?.cancel();
        return retryAfterSeconds !== undefined
          ? { kind: "backoff", retryAfterSeconds }
          : { kind: "backoff" };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return failed(`HTTP ${status}`);
      }
      const summary = parseInboxSummary(await readJson(res));
      if (!summary) return failed("malformed response");
      return { kind: "ok", summary, etag: res.headers.get("etag") };
    } catch {
      return failed("connection failed");
    }
  }

  // bypasses the shared fetch helper so a Retry-After sleep can't hold teardown
  async accountNotices(
    apiKey: string,
    signal: AbortSignal,
  ): Promise<AccountNoticesResult> {
    let headers: Headers;
    try {
      headers = mergeIdentityHeaders(this.identity, {
        "x-api-key": apiKey,
        "Accept": "application/json",
      });
    } catch {
      return { kind: "failed", reason: "invalid request header" };
    }
    const doFetch = this.options.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.serverUrl}/api/v1/account/notices`, {
        method: "GET",
        headers,
        // a redirect could carry x-api-key to another host
        redirect: "error",
        signal,
      });
    } catch (error) {
      const reason = signal.aborted ||
          (error instanceof DOMException &&
            (error.name === "TimeoutError" || error.name === "AbortError"))
        ? "timeout"
        : "connection failed";
      return { kind: "failed", reason };
    }

    const status = res.status;
    const failed = (reason: string): AccountNoticesResult => ({
      kind: "failed",
      reason: signal.aborted ? "timeout" : reason,
    });
    try {
      if (status === 401) {
        await res.body?.cancel();
        return { kind: "rejected" };
      }
      if (status === 403) {
        // only swamp-club's own body means a collective key
        const body = await readCappedJson(res, MAX_ACCOUNT_NOTICES_BODY_BYTES);
        return body !== TOO_LARGE &&
            parseAccountNoticesErrorCode(body) === NOTICES_REQUIRE_USER
          ? { kind: "unavailable" }
          : failed(`HTTP ${status}`);
      }
      if (status === 404) {
        await res.body?.cancel();
        return { kind: "unsupported" };
      }
      if (status === 429) {
        const retryAfterSeconds = parseRetryAfter(
          res.headers.get("retry-after"),
        );
        await res.body?.cancel();
        return retryAfterSeconds !== undefined
          ? { kind: "backoff", retryAfterSeconds }
          : { kind: "backoff" };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return failed(`HTTP ${status}`);
      }
      const body = await readCappedJson(res, MAX_ACCOUNT_NOTICES_BODY_BYTES);
      if (body === TOO_LARGE) return failed("response too large");
      const notices = parseAccountNotices(body);
      if (!notices) return failed("malformed response");
      return { kind: "ok", notices };
    } catch {
      return failed("connection failed");
    }
  }

  async listInboxMessages(
    apiKey: string,
    options: InboxListOptions = {},
    signal?: AbortSignal,
  ): Promise<InboxMessagePage> {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set("status", options.status);
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options.before !== undefined) params.set("before", options.before);
    const query = params.size > 0 ? `?${params}` : "";
    const res = await this.fetch(
      `/api/inbox/messages${query}`,
      { method: "GET", headers: { "x-api-key": apiKey } },
      signal,
    );
    if (!res.ok) {
      throw await this.inboxError(
        res,
        "list your inbox",
        NO_INBOX_MESSAGE,
        signal,
      );
    }
    const page = parseInboxMessagePage(await this.readInboxJson(res, signal));
    if (!page) {
      throw new UserError("Swamp Club returned a malformed inbox page.");
    }
    return page;
  }

  async getInboxMessage(
    apiKey: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<InboxMessage> {
    const res = await this.fetch(
      `/api/inbox/messages/${encodeURIComponent(id)}`,
      { method: "GET", headers: { "x-api-key": apiKey } },
      signal,
    );
    if (!res.ok) {
      throw await this.inboxError(
        res,
        `fetch message ${id}`,
        `Message ${id} not found.`,
        signal,
      );
    }
    const message = parseInboxMessage(await this.readInboxJson(res, signal));
    if (!message) {
      throw new UserError(
        `Swamp Club returned a malformed answer for message ${id}.`,
      );
    }
    return message;
  }

  /**
   * returns the requested ids confirmed, in order; a throw may follow applied
   * batches, but marking read is idempotent so retrying the whole call is safe;
   * onConfirmed reports each batch as answered
   */
  async markInboxRead(
    apiKey: string,
    ids: readonly string[],
    signal?: AbortSignal,
    onConfirmed?: (ids: string[]) => void,
  ): Promise<string[]> {
    // ULIDs are case-insensitive and the schema reports them upper case,
    // so ids are deduplicated and matched without regard to case.
    const byKey = new Map<string, string>();
    for (const id of ids) {
      if (!byKey.has(id.toUpperCase())) byKey.set(id.toUpperCase(), id);
    }
    const unique = [...byKey.values()];
    const confirmed = new Set<string>();
    for (let i = 0; i < unique.length; i += MARK_READ_BATCH_SIZE) {
      const batch = unique.slice(i, i + MARK_READ_BATCH_SIZE);
      const res = await this.fetch(
        "/api/inbox/read",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({ ids: batch }),
        },
        signal,
      );
      if (!res.ok) {
        throw await this.inboxError(
          res,
          "mark messages read",
          NO_INBOX_MESSAGE,
          signal,
        );
      }
      const read = parseInboxReadIds(await this.readInboxJson(res, signal));
      if (!read) {
        throw new UserError(
          "Swamp Club returned a malformed answer to marking messages read.",
        );
      }
      const answered = new Set(read.map((id) => id.toUpperCase()));
      for (const id of answered) confirmed.add(id);
      onConfirmed?.(batch.filter((id) => answered.has(id.toUpperCase())));
    }
    return unique.filter((id) => confirmed.has(id.toUpperCase()));
  }

  /**
   * The UserError for a failed inbox request. It lifts the server's `error`
   * field and never echoes a raw body, which may be a proxy's page.
   */
  private async inboxError(
    res: Response,
    action: string,
    notFoundMessage: string,
    signal?: AbortSignal,
  ): Promise<UserError> {
    // 401 and 404 need no body, so a stalled one cannot blur them.
    if (res.status === 401) {
      await res.body?.cancel();
      return new UserError(
        'Swamp Club rejected your API key. Run "swamp auth login".',
      );
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return new UserError(notFoundMessage);
    }
    const code = parseInboxErrorCode(await this.readInboxJson(res, signal));
    if (res.status === 403 && code === INBOX_REQUIRES_USER) {
      return new UserError(INBOX_REQUIRES_USER_MESSAGE);
    }
    const detail = code !== undefined ? sanitizeFieldText(code, 200) : "";
    return new UserError(
      detail
        ? `Failed to ${action} (HTTP ${res.status}): ${detail}`
        : `Failed to ${action} (HTTP ${res.status}).`,
    );
  }

  /**
   * a body cut off by the caller's signal rethrows the abort; a timeout or
   * dropped connection is a UserError that says so, never a malformed answer
   */
  private async readInboxJson(
    res: Response,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await readJson(res);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new UserError(
          `Reading the answer from ${this.serverUrl} timed out.`,
          "timeout",
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(
        `Could not read the answer from ${this.serverUrl}: ${message}`,
      );
    }
  }

  private async fetch(
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
    timeoutMs = 15_000,
  ): Promise<Response> {
    const url = `${this.serverUrl}${path}`;
    // Built per attempt so a Retry-After wait never eats into the next
    // request's timeout; only the caller's signal cancels the wait.
    const attemptSignal = () => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      return callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : timeoutSignal;
    };
    // identity headers merge first so caller-supplied init.headers win, letting
    // per-call x-api-key or Authorization values override the constructor
    // identity
    const headers = mergeIdentityHeaders(this.identity, init.headers);
    const doFetch = this.options.fetch ?? globalThis.fetch;
    try {
      const res = await fetchWithRateLimitRetry(
        () => doFetch(url, { ...init, headers, signal: attemptSignal() }),
        {
          method: init.method,
          signal: callerSignal,
          sleep: this.options.sleep,
        },
      );
      if (res.status === 429) {
        throw rateLimitError({
          ...(await readRateLimit(res)),
          credentialed: hasCredential(headers),
        });
      }
      return res;
    } catch (error) {
      if (error instanceof UserError) throw error;
      if (
        callerSignal?.aborted && error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        const seconds = Math.round(timeoutMs / 1000);
        throw new UserError(
          `Request to ${this.serverUrl}${path} timed out after ${seconds}s.`,
          "timeout",
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(
        `Could not connect to ${this.serverUrl}: ${message}`,
      );
    }
  }
}
