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

import { SwampHttpError } from "./http_errors.ts";
import type {
  CallOptions,
  DelegatedTokenSet,
  SwampIntegrationClient,
} from "./integration_client.ts";
import type { TokenStore } from "./token_store.ts";

/** what an action client asks for the bearer of each call */
export interface TokenSource {
  accessToken(options?: CallOptions): Promise<string>;
  /** serve refused this token; answer one to try once more */
  unauthorized(refused: string, options?: CallOptions): Promise<string>;
}

/** a token that never changes, such as a personal API token for a script */
export function fixedToken(token: string): TokenSource {
  return {
    accessToken: () => Promise.resolve(token),
    unauthorized: () => Promise.resolve(token),
  };
}

export type TokenEvent =
  | { kind: "refreshed"; delegationId: string }
  | {
    kind: "save_failed";
    delegationId: string;
    /** the store's own error */
    error: unknown;
  };

export interface DelegatedTokensOptions {
  integration: SwampIntegrationClient;
  store: TokenStore;
  delegationId: string;
  /** told about refreshes and a store that fails to save */
  onTokenEvent?: (event: TokenEvent) => void;
  /** for tests: this process's clock */
  now?: () => number;
}

const MIN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// one refresh at a time per delegation and store in this process; a racing one
// would be harmless, only wasted
const inFlight = new WeakMap<TokenStore, Map<string, Promise<string>>>();

function refreshDue(tokens: DelegatedTokenSet, nowMs: number): boolean {
  const margin = Math.max(
    MIN_REFRESH_MARGIN_MS,
    tokens.accessTokenLifetimeMs / 10,
  );
  return nowMs >= tokens.accessTokenDeadlineMs - margin;
}

/** a person's delegated tokens: refreshed before they expire and after a 401 */
export class DelegatedTokens implements TokenSource {
  readonly #integration: SwampIntegrationClient;
  readonly #store: TokenStore;
  readonly #delegationId: string;
  readonly #onTokenEvent?: (event: TokenEvent) => void;
  readonly #now: () => number;
  /** the newest set, kept when the store could not save it */
  #latest: DelegatedTokenSet | null = null;

  constructor(options: DelegatedTokensOptions) {
    this.#integration = options.integration;
    this.#store = options.store;
    this.#delegationId = options.delegationId;
    if (options.onTokenEvent) this.#onTokenEvent = options.onTokenEvent;
    this.#now = options.now ?? Date.now;
  }

  get delegationId(): string {
    return this.#delegationId;
  }

  async accessToken(options: CallOptions = {}): Promise<string> {
    const tokens = await this.#current();
    if (!refreshDue(tokens, this.#now())) return tokens.accessToken;
    return await this.#refresh(options);
  }

  async unauthorized(
    refused: string,
    options: CallOptions = {},
  ): Promise<string> {
    const tokens = await this.#current();
    // another call or another copy of the app refreshed already
    if (tokens.accessToken !== refused && !refreshDue(tokens, this.#now())) {
      return tokens.accessToken;
    }
    return await this.#refresh(options);
  }

  async #current(): Promise<DelegatedTokenSet> {
    const stored = await this.#store.load(this.#delegationId);
    const latest = this.#latest;
    const tokens = latest !== null &&
        (stored === null ||
          latest.accessTokenDeadlineMs > stored.accessTokenDeadlineMs)
      ? latest
      : stored;
    if (tokens === null) {
      throw new SwampHttpError({
        status: 0,
        code: "not_linked",
        message: "No tokens are stored for this delegation",
        route: "delegations/refresh",
      });
    }
    return tokens;
  }

  #refresh(options: CallOptions): Promise<string> {
    let byDelegation = inFlight.get(this.#store);
    if (!byDelegation) {
      byDelegation = new Map();
      inFlight.set(this.#store, byDelegation);
    }
    const running = byDelegation.get(this.#delegationId);
    if (running) return running;
    const map = byDelegation;
    const work = this.#refreshOnce(options).finally(() => {
      map.delete(this.#delegationId);
    });
    map.set(this.#delegationId, work);
    return work;
  }

  async #refreshOnce(options: CallOptions): Promise<string> {
    const tokens = await this.#current();
    const outcome = await this.#integration.refresh(
      tokens.refreshToken,
      options,
    );
    if (outcome.kind === "not_admitted") {
      throw new SwampHttpError({
        status: 401,
        code: "not_admitted",
        message:
          "Serve does not admit this person right now; the link refreshes again once they are admitted",
        route: "delegations/refresh",
        reason: "not_admitted",
      });
    }
    if (outcome.kind === "link_ended") {
      throw new SwampHttpError({
        status: 401,
        code: "link_ended",
        message:
          `The link has ended (${outcome.reason}); the person has to link again`,
        route: "delegations/refresh",
        reason: outcome.reason,
      });
    }
    const next: DelegatedTokenSet = {
      ...tokens,
      accessToken: outcome.accessToken,
      accessTokenExpiresAt: outcome.accessTokenExpiresAt,
      accessTokenDeadlineMs: outcome.accessTokenDeadlineMs,
      accessTokenLifetimeMs: outcome.accessTokenLifetimeMs,
      ...(outcome.refreshToken !== undefined
        ? { refreshToken: outcome.refreshToken }
        : {}),
      ...(outcome.expiresAt !== undefined
        ? { expiresAt: outcome.expiresAt }
        : {}),
    };
    this.#latest = next;
    try {
      await this.#store.save(this.#delegationId, next);
    } catch (error) {
      this.#onTokenEvent?.({
        kind: "save_failed",
        delegationId: this.#delegationId,
        error,
      });
      return next.accessToken;
    }
    this.#onTokenEvent?.({
      kind: "refreshed",
      delegationId: this.#delegationId,
    });
    return next.accessToken;
  }

  toJSON(): Record<string, unknown> {
    return { delegationId: this.#delegationId, tokens: "[redacted]" };
  }

  [Symbol.for("Deno.customInspect")](): string {
    return `DelegatedTokens { delegationId: ${this.#delegationId}, tokens: [redacted] }`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `DelegatedTokens { delegationId: ${this.#delegationId}, tokens: [redacted] }`;
  }
}
