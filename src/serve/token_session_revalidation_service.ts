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
 * ends sessions whose token lost its authority (revoked, expired, deleted,
 * rotated) wherever that happened: here, on an HA peer, or from the CLI
 */

import type { TokenAdmissionChecker } from "./token_admission.ts";
import { runDetached } from "../infrastructure/tracing/mod.ts";
import { z } from "zod";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type ServerToken,
  ServerTokenSecretMismatchError,
  verifyServerTokenSecret,
} from "../domain/models/access/server_token_model.ts";
import { ServerTokenNotFoundError } from "./token_auth.ts";
import { delegationOfSessionName } from "./delegated_token_auth.ts";
import {
  DELEGATION_ENDED_REASON,
  NOT_ADMITTED_REASON,
  TOKEN_EXPIRED_REASON,
  TOKEN_GONE_REASON,
  TOKEN_INVALID_REASON,
  TOKEN_REVOKED_REASON,
  TOKEN_ROTATED_REASON,
  type TokenSessionTerminationCause,
} from "./handlers/shared.ts";

const logger = getSwampLogger(["serve", "token-session-revalidation"]);

export const DEFAULT_TOKEN_SESSION_REVALIDATION_MS = 30_000;
/** how long a session outlives a record that does not pair with the secret */
export const STALE_COPY_KEEP_MS = 10 * 60_000;

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
 * a session is kept only while its own mint is still the active, unexpired
 * record; a record that does not pair with the vault secret is a stale copy,
 * not a rotation, since a rotation writes the secret before the record
 */
export function tokenSessionVerdict(
  token: ServerToken | null,
  sessionCreatedAt: string,
  nowMs: number,
  recordIsStaleCopy = false,
): TokenSessionVerdict {
  if (token === null) {
    return {
      keep: false,
      cause: "deleted",
      code: REVOKED_CLOSE_CODE,
      reason: TOKEN_GONE_REASON,
    };
  }
  if (token.state === "revoked") {
    return {
      keep: false,
      cause: "revoked",
      code: REVOKED_CLOSE_CODE,
      reason: TOKEN_REVOKED_REASON,
    };
  }
  if (token.createdAt !== sessionCreatedAt) {
    // a stale copy is older than the live mint; an unparseable time fails closed
    if (
      recordIsStaleCopy &&
      Date.parse(sessionCreatedAt) > Date.parse(token.createdAt)
    ) return { keep: true };
    return {
      keep: false,
      cause: "rotated",
      code: REVOKED_CLOSE_CODE,
      reason: TOKEN_ROTATED_REASON,
    };
  }
  // Written as "not in the future" so an unparseable expiresAt (NaN) fails
  // closed rather than keeping the session.
  if (token.state === "expired" || !(Date.parse(token.expiresAt) > nowMs)) {
    return {
      keep: false,
      cause: "expired",
      code: EXPIRED_CLOSE_CODE,
      reason: TOKEN_EXPIRED_REASON,
    };
  }
  return { keep: true };
}

/**
 * A record that is present but will not parse is rejected at upgrade, so its
 * open sessions must not outlive it either. Only other failures (I/O, a
 * datastore hiccup) are treated as transient.
 */
function isUnreadableRecord(err: unknown): boolean {
  return err instanceof SyntaxError || err instanceof z.ZodError;
}

export interface TokenSessionCloseOptions {
  readonly onlyCreatedAt: string;
  readonly code: number;
  readonly reason: string;
  readonly cause: TokenSessionTerminationCause;
}

export interface TokenSessionRevalidationDeps {
  readonly intervalMs: number;
  listTokenSessions(): readonly { name: string; createdAt: string }[];
  readToken(name: string): Promise<ServerToken>;
  /** absent, a changed mint is always a rotation */
  readSecret?(vaultName: string, secretKey: string): Promise<string>;
  terminateSessions(name: string, options: TokenSessionCloseOptions): number;
  /** a delegation's sessions are checked against the directory, never a token record */
  delegationStanding?(id: string): string;
  delegationPerson?(
    id: string,
  ):
    | { readonly sub: string; readonly collectives: readonly string[] }
    | undefined;
  /** null or absent: no admission check, as outside OAuth mode */
  readonly admission?: TokenAdmissionChecker | null;
  now?(): number;
}

export class TokenSessionRevalidationService {
  readonly #deps: TokenSessionRevalidationDeps;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: Promise<void> = Promise.resolve();
  #disposed = false;
  /** session key to when it was first kept over a stale copy */
  #staleSince = new Map<string, number>();

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

  async runOnce(): Promise<number> {
    return await this.#revalidate();
  }

  #scheduleNext(): void {
    if (this.#disposed) return;
    this.#timer = runDetached(() =>
      setTimeout(() => {
        this.#pending = this.#tick();
      }, this.#deps.intervalMs)
    );
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
    const stillStale = new Set<string>();
    for (const [name, mints] of mintsByName) {
      if (this.#disposed) break;
      const delegationId = delegationOfSessionName(name);
      if (delegationId !== undefined) {
        const standing = this.#deps.delegationStanding?.(delegationId) ??
          "unknown";
        if (standing === "standing") {
          const person = this.#deps.delegationPerson?.(delegationId);
          if (
            !this.#deps.admission || person === undefined ||
            this.#deps.admission.delegation(person).admitted
          ) continue;
          closed += this.#closeNotAdmitted(name, mints);
          continue;
        }
        for (const createdAt of mints) {
          closed += this.#deps.terminateSessions(name, {
            onlyCreatedAt: createdAt,
            code: REVOKED_CLOSE_CODE,
            reason: DELEGATION_ENDED_REASON,
            cause: "delegation-ended",
          });
        }
        continue;
      }
      let token: ServerToken | null;
      try {
        token = await this.#deps.readToken(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof ServerTokenNotFoundError) {
          token = null;
        } else if (isUnreadableRecord(err)) {
          logger.warn(
            "Token {name} has an unreadable record; closing its sessions: {error}",
            { name, error: message },
          );
          for (const createdAt of mints) {
            closed += this.#deps.terminateSessions(name, {
              onlyCreatedAt: createdAt,
              code: REVOKED_CLOSE_CODE,
              reason: TOKEN_INVALID_REASON,
              cause: "invalid",
            });
          }
          continue;
        } else {
          // a transient read failure must not drop every session; the next pass
          // retries, and the session cap still bounds the worst case
          logger.warn(
            "Could not revalidate sessions for token {name}, keeping them until the next pass: {error}",
            { name, error: message },
          );
          continue;
        }
      }

      const nowMs = this.#deps.now?.() ?? Date.now();
      const staleCopy = token !== null &&
        mints.some((createdAt) => createdAt !== token.createdAt) &&
        await this.#isStaleCopy(token);
      const admission = token === null || !this.#deps.admission
        ? undefined
        : await this.#deps.admission.serverToken(token);
      // a lookup that cannot answer keeps sessions: nobody was denied, and the
      // next pass retries
      const admitted = admission === undefined || admission.admitted ||
        admission.unavailable === true;
      for (const createdAt of mints) {
        let verdict = tokenSessionVerdict(
          token,
          createdAt,
          nowMs,
          staleCopy,
        );
        if (verdict.keep && token !== null && createdAt !== token.createdAt) {
          const key = JSON.stringify([name, createdAt]);
          const since = this.#staleSince.get(key) ?? nowMs;
          this.#staleSince.set(key, since);
          stillStale.add(key);
          if (nowMs - since >= STALE_COPY_KEEP_MS) {
            verdict = tokenSessionVerdict(token, createdAt, nowMs);
          }
        }
        if (verdict.keep) {
          if (!admitted) closed += this.#closeNotAdmitted(name, [createdAt]);
          continue;
        }
        closed += this.#deps.terminateSessions(name, {
          onlyCreatedAt: createdAt,
          code: verdict.code,
          reason: verdict.reason,
          cause: verdict.cause,
        });
      }
    }
    for (const key of this.#staleSince.keys()) {
      if (!stillStale.has(key)) this.#staleSince.delete(key);
    }
    return closed;
  }

  /** any doubt reads as a real rotation, which closes the session */
  async #isStaleCopy(token: ServerToken): Promise<boolean> {
    const readSecret = this.#deps.readSecret;
    if (readSecret === undefined || token.secretFingerprint === undefined) {
      return false;
    }
    try {
      const secret = await readSecret(token.vaultName, token.secretKey);
      await verifyServerTokenSecret(token, secret);
      return false;
    } catch (err) {
      if (!(err instanceof ServerTokenSecretMismatchError)) return false;
      logger.warn(
        "Token {name} has a record that does not pair with its secret, so it is a stale copy and its sessions stay open; rotate the token if it persists",
        { name: token.name },
      );
      return true;
    }
  }

  #closeNotAdmitted(name: string, mints: readonly string[]): number {
    let closed = 0;
    for (const createdAt of mints) {
      closed += this.#deps.terminateSessions(name, {
        onlyCreatedAt: createdAt,
        code: REVOKED_CLOSE_CODE,
        reason: NOT_ADMITTED_REASON,
        cause: "not-admitted",
      });
    }
    return closed;
  }
}
