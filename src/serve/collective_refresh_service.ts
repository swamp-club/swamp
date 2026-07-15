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
import type { OAuthUserInfo } from "./oauth_client.ts";

const logger = getSwampLogger(["serve", "collective-refresh"]);

export interface CollectiveRefreshDeps {
  readonly intervalMs: number;
  readonly oauthProvider: string;
  readonly groupsField: string;

  getUserInfo(
    providerUrl: string,
    accessToken: string,
    groupsField: string,
    signal: AbortSignal,
  ): Promise<OAuthUserInfo>;

  listActiveTokens(): Promise<ActiveTokenInfo[]>;

  getAccessToken(tokenName: string): Promise<string | null>;

  updateTokenCollectives(
    tokenName: string,
    collectives: string[],
    groups: string[],
  ): Promise<void>;

  revokeToken(tokenName: string): Promise<void>;

  updateConnectionCollectives(
    principalId: string,
    collectives: readonly string[],
    groups: readonly string[],
  ): void;

  closeConnectionsForPrincipal(principalId: string): void;
}

export interface ActiveTokenInfo {
  readonly name: string;
  readonly principalId: string;
  readonly collectives: string[];
  readonly groups: string[];
}

export class CollectiveRefreshService {
  readonly #deps: CollectiveRefreshDeps;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #disposed = false;

  constructor(deps: CollectiveRefreshDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#disposed) return;
    logger.info(
      "Starting collective refresh service (interval: {interval}ms)",
      {
        interval: this.#deps.intervalMs,
      },
    );
    this.#scheduleNext();
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

  #scheduleNext(): void {
    if (this.#disposed) return;
    this.#timer = setTimeout(() => {
      void this.#tick();
    }, this.#deps.intervalMs);
  }

  async #tick(): Promise<void> {
    if (this.#disposed) return;
    this.#running = true;
    try {
      await this.#refreshAll();
    } catch (err) {
      logger.error`Collective refresh cycle failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    } finally {
      this.#running = false;
      this.#scheduleNext();
    }
  }

  async #refreshAll(): Promise<void> {
    const tokens = await this.#deps.listActiveTokens();
    logger.info("Refreshing collectives for {count} active token(s)", {
      count: tokens.length,
    });

    for (const token of tokens) {
      if (this.#disposed) break;
      await this.#refreshToken(token);
    }
  }

  async #refreshToken(token: ActiveTokenInfo): Promise<void> {
    const accessToken = await this.#deps.getAccessToken(token.name);
    if (!accessToken) return;

    try {
      const signal = AbortSignal.timeout(30_000);
      const userInfo = await this.#deps.getUserInfo(
        this.#deps.oauthProvider,
        accessToken,
        this.#deps.groupsField,
        signal,
      );

      const collectivesChanged = !setsEqual(
        token.collectives,
        userInfo.collectives,
      );
      const groupsChanged = !setsEqual(token.groups, userInfo.groups);
      if (collectivesChanged || groupsChanged) {
        await this.#deps.updateTokenCollectives(
          token.name,
          [...userInfo.collectives],
          [...userInfo.groups],
        );
        this.#deps.updateConnectionCollectives(
          token.principalId,
          userInfo.collectives,
          userInfo.groups,
        );
        logger.info(
          "Updated collectives/groups for token {name} (principal {principal})",
          { name: token.name, principal: token.principalId },
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Userinfo request failed: 401")) {
        logger.warn(
          "Userinfo rejected for {name} — revoking server token (session expired or user deprovisioned)",
          { name: token.name },
        );
        await this.#deps.revokeToken(token.name);
        this.#deps.closeConnectionsForPrincipal(token.principalId);
      } else {
        logger.warn(
          "Failed to refresh collectives for {name}, keeping existing snapshot: {error}",
          { name: token.name, error: message },
        );
      }
    }
  }
}

function setsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}
