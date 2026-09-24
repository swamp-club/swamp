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

/**
 * Re-checks the server token behind every open WebSocket session and ends the
 * sessions whose token has lost its authority — revoked, expired, deleted, or
 * rotated — wherever that happened: on this instance, on an HA peer (the
 * runtime data poller brings the record in), or from the CLI.
 */

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { ServerToken } from "../domain/models/access/server_token_model.ts";
import { classifyRedeemError } from "./token_auth.ts";
import type { TokenSessionTerminationCause } from "./handlers/shared.ts";

const logger = getSwampLogger(["serve", "token-session-revalidation"]);

/** Matches the default datastore poll interval, bounding HA revoke latency. */
export const DEFAULT_TOKEN_SESSION_REVALIDATION_MS = 30_000;

const REVOKED_CLOSE_CODE = 4003;
const EXPIRED_CLOSE_CODE = 4002;

export type TokenSessionVerdict =
  | { readonly keep: true }
  | {
    readonly keep: false;
    readonly cause: TokenSessionTerminationCause;
    readonly code: number;
    readonly reason: string;
  };

/**
 * Decides whether a session opened with the mint `sessionCreatedAt` of a token
 * may stay open. `token` is the current record, or null when it no longer
 * exists. A session is kept only while its own mint is still the active,
 * unexpired record.
 */
export function tokenSessionVerdict(
  token: ServerToken | null,
  sessionCreatedAt: string,
  nowMs: number,
): TokenSessionVerdict {
  if (token === null) {
    return {
      keep: false,
      cause: "deleted",
      code: REVOKED_CLOSE_CODE,
      reason: "Session revoked",
    };
  }
  if (token.state === "revoked") {
    return {
      keep: false,
      cause: "revoked",
      code: REVOKED_CLOSE_CODE,
      reason: "Session revoked",
    };
  }
  if (token.createdAt !== sessionCreatedAt) {
    return {
      keep: false,
      cause: "rotated",
      code: REVOKED_CLOSE_CODE,
      reason:
        "Session revoked: token rotated, reconnect with the new credential",
    };
  }
  if (token.state === "expired" || Date.parse(token.expiresAt) <= nowMs) {
    return {
      keep: false,
      cause: "expired",
      code: EXPIRED_CLOSE_CODE,
      reason: "Session expired — reconnect to re-authenticate",
    };
  }
  return { keep: true };
}

export interface TokenSessionCloseOptions {
  readonly onlyCreatedAt: string;
  readonly code: number;
  readonly reason: string;
  readonly cause: TokenSessionTerminationCause;
}

export interface TokenSessionRevalidationDeps {
  readonly intervalMs: number;
  /** Each distinct token mint with at least one open session. */
  listTokenSessions(): readonly { name: string; createdAt: string }[];
  readToken(name: string): Promise<ServerToken>;
  /** Closes (and audits) the sessions of one mint; returns how many. */
  terminateSessions(name: string, options: TokenSessionCloseOptions): number;
  now?(): number;
}

export class TokenSessionRevalidationService {
  readonly #deps: TokenSessionRevalidationDeps;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(deps: TokenSessionRevalidationDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#disposed) return;
    logger.info(
      "Starting token session revalidation (interval: {interval}ms)",
      { interval: this.#deps.intervalMs },
    );
    this.#scheduleNext();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#pending;
  }

  /** Runs one revalidation pass; returns the number of sessions closed. */
  async runOnce(): Promise<number> {
    return await this.#revalidate();
  }

  #scheduleNext(): void {
    if (this.#disposed) return;
    this.#timer = setTimeout(() => {
      this.#pending = this.#tick();
    }, this.#deps.intervalMs);
    Deno.unrefTimer(this.#timer);
  }

  async #tick(): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.#revalidate();
    } catch (err) {
      logger.error`Token session revalidation failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    } finally {
      this.#scheduleNext();
    }
  }

  async #revalidate(): Promise<number> {
    const mintsByName = new Map<string, string[]>();
    for (const session of this.#deps.listTokenSessions()) {
      const mints = mintsByName.get(session.name) ?? [];
      mints.push(session.createdAt);
      mintsByName.set(session.name, mints);
    }

    let closed = 0;
    for (const [name, mints] of mintsByName) {
      if (this.#disposed) break;
      let token: ServerToken | null;
      try {
        token = await this.#deps.readToken(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (classifyRedeemError(message) === "no-definition") {
          token = null;
        } else {
          // A transient read failure must not drop every session; the next
          // pass retries, and the 8-hour session cap still bounds the worst
          // case.
          logger.warn(
            "Could not revalidate sessions for token {name}, keeping them until the next pass: {error}",
            { name, error: message },
          );
          continue;
        }
      }

      const nowMs = this.#deps.now?.() ?? Date.now();
      for (const createdAt of mints) {
        const verdict = tokenSessionVerdict(token, createdAt, nowMs);
        if (verdict.keep) continue;
        closed += this.#deps.terminateSessions(name, {
          onlyCreatedAt: createdAt,
          code: verdict.code,
          reason: verdict.reason,
          cause: verdict.cause,
        });
      }
    }
    return closed;
  }
}
