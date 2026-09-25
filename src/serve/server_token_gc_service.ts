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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "token-gc"]);

export const DEFAULT_TOKEN_GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_TOKEN_GC_GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

export interface TokenGcInfo {
  readonly name: string;
  readonly definitionId: string;
  readonly state: "active" | "expired" | "revoked";
  readonly expiresAt: string;
  readonly revokedAt?: string;
  /** Vault the token's `token-main` record says holds its secret. */
  readonly vaultName?: string;
  /** Secret key the token's `token-main` record names. */
  readonly secretKey?: string;
}

export interface ServerTokenGcDeps {
  readonly intervalMs: number;
  readonly gracePeriodMs: number;

  listTokens(): Promise<TokenGcInfo[]>;

  /**
   * Deletes the token's secret. A failure keeps the token's records for the
   * next sweep, so a secret is never left behind with nothing referencing it.
   */
  deleteTokenSecret(token: TokenGcInfo): Promise<void>;

  /** Best effort: a failure is logged and the token is still collected. */
  deleteOAuthAccessToken(tokenName: string): Promise<void>;

  /** Deletes the token's definition, data and outputs. */
  deleteTokenRecord(definitionId: string, tokenName: string): Promise<void>;
}

export class ServerTokenGcService {
  readonly #deps: ServerTokenGcDeps;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #disposed = false;

  constructor(deps: ServerTokenGcDeps) {
    this.#deps = deps;
  }

  /**
   * Starts the sweep loop. The first sweep runs straight away, on a timer so
   * it never delays the caller, then once every `intervalMs`.
   */
  start(): void {
    if (this.#disposed) return;
    logger.info(
      "Starting server token GC service (interval: {interval}ms, grace period: {grace}ms)",
      {
        interval: this.#deps.intervalMs,
        grace: this.#deps.gracePeriodMs,
      },
    );
    this.#scheduleNext(0);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    while (this.#running) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async runOnce(): Promise<number> {
    return await this.#sweep();
  }

  #scheduleNext(delayMs: number): void {
    if (this.#disposed) return;
    this.#timer = setTimeout(() => {
      void this.#tick();
    }, delayMs);
    Deno.unrefTimer(this.#timer);
  }

  async #tick(): Promise<void> {
    this.#timer = null;
    if (this.#disposed) return;
    this.#running = true;
    try {
      await this.#sweep();
    } catch (err) {
      logger.error`Server token GC cycle failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    } finally {
      this.#running = false;
      this.#scheduleNext(this.#deps.intervalMs);
    }
  }

  async #sweep(): Promise<number> {
    const tokens = await this.#deps.listTokens();
    const now = Date.now();
    let gcCount = 0;

    for (const token of tokens) {
      if (this.#disposed) break;

      if (!this.#isGcEligible(token, now)) continue;

      try {
        await this.#gcToken(token);
        gcCount++;
      } catch (err) {
        logger.warn(
          "Failed to GC server token {name}, will retry next cycle: {error}",
          {
            name: token.name,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    if (gcCount > 0) {
      logger.info("GC'd {count} expired/revoked server token(s)", {
        count: gcCount,
      });
    }

    return gcCount;
  }

  #isGcEligible(token: TokenGcInfo, nowMs: number): boolean {
    if (token.state === "revoked") return true;

    const expiresAtMs = Date.parse(token.expiresAt);
    const effectivelyExpired = token.state === "expired" ||
      expiresAtMs <= nowMs;

    if (!effectivelyExpired) return false;

    return (nowMs - expiresAtMs) >= this.#deps.gracePeriodMs;
  }

  async #gcToken(token: TokenGcInfo): Promise<void> {
    // The secret goes first, and a failure stops here so the next sweep
    // retries. A stale copy of the records, such as an HA peer's local cache,
    // cannot authenticate once the secret is gone.
    await this.#deps.deleteTokenSecret(token);

    try {
      await this.#deps.deleteOAuthAccessToken(token.name);
    } catch (err) {
      logger.warn(
        "Failed to delete OAuth access token for {name}: {error}",
        {
          name: token.name,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }

    await this.#deps.deleteTokenRecord(token.definitionId, token.name);
  }
}
