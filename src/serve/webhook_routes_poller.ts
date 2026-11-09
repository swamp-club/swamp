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

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["swamp", "serve", "webhook-routes-poller"]);

/** failed applies of one snapshot before the poller waits for the next change */
export const MAX_FAILED_ROUTE_APPLIES = 3;

export interface WebhookRoutesApplyResult {
  readonly changed: number;
  readonly errors: readonly string[];
}

export interface WebhookRoutesPollerOptions {
  readonly intervalMs: number;
  /** equal values mean the loader would read the same files */
  readonly snapshot: () => Promise<string>;
  readonly apply: () => Promise<WebhookRoutesApplyResult>;
  readonly now?: () => Date;
}

export interface WebhookRoutesPollStatus {
  readonly intervalMs: number;
  readonly lastCheckedAt: string | null;
  readonly lastAppliedAt: string | null;
  readonly lastError: string | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WebhookRoutesPoller {
  readonly #options: WebhookRoutesPollerOptions;
  readonly #now: () => Date;
  #timer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  #running = false;
  #pending: Promise<void> = Promise.resolve();
  // unknown at start, so the first settled snapshot is applied even when it
  // matches what serve loaded at startup
  #applied: string | undefined;
  #previous: string | undefined;
  #failedSnapshot: string | undefined;
  #failures = 0;
  #lastCheckedAt: string | null = null;
  #lastAppliedAt: string | null = null;
  #lastError: string | null = null;

  constructor(options: WebhookRoutesPollerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      // a slow check skips the ticks it overlaps rather than queueing them
      if (this.#running) return;
      this.#pending = this.#pending.then(() => this.#tick());
    }, this.#options.intervalMs);
    Deno.unrefTimer(this.#timer);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#pending;
  }

  /** runs one check after any check already running */
  pollNow(): Promise<void> {
    this.#pending = this.#pending.then(() => this.#tick());
    return this.#pending;
  }

  status(): WebhookRoutesPollStatus {
    return {
      intervalMs: this.#options.intervalMs,
      lastCheckedAt: this.#lastCheckedAt,
      lastAppliedAt: this.#lastAppliedAt,
      lastError: this.#lastError,
    };
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    this.#running = true;
    try {
      await this.#check();
    } finally {
      this.#running = false;
    }
  }

  async #check(): Promise<void> {
    let snapshot: string;
    try {
      snapshot = await this.#options.snapshot();
    } catch (error) {
      this.#lastCheckedAt = this.#now().toISOString();
      const reason = `Could not read the webhook routes directory: ${
        message(error)
      }`;
      if (this.#lastError !== reason) logger.warn`${reason}`;
      this.#lastError = reason;
      return;
    }
    this.#lastCheckedAt = this.#now().toISOString();

    // a deploy caught mid-write differs from the last tick, so it waits a tick
    const settled = snapshot === this.#previous;
    this.#previous = snapshot;
    if (!settled || snapshot === this.#applied) return;
    if (
      snapshot === this.#failedSnapshot &&
      this.#failures >= MAX_FAILED_ROUTE_APPLIES
    ) return;
    if (this.#stopped) return;

    let result: WebhookRoutesApplyResult;
    try {
      result = await this.#options.apply();
    } catch (error) {
      if (snapshot !== this.#failedSnapshot) {
        this.#failedSnapshot = snapshot;
        this.#failures = 0;
      }
      this.#failures++;
      this.#lastError = `Could not apply changed webhook route files: ${
        message(error)
      }`;
      if (this.#failures >= MAX_FAILED_ROUTE_APPLIES) {
        logger
          .warn`${this.#lastError}; failed ${this.#failures} times, retrying when the route files change again`;
      } else if (this.#failures === 1) {
        logger.warn`${this.#lastError}; retrying on the next poll`;
      }
      return;
    }

    // the snapshot read before applying, so an edit made during it is seen
    this.#applied = snapshot;
    this.#failedSnapshot = undefined;
    this.#failures = 0;
    this.#lastError = null;
    this.#lastAppliedAt = this.#now().toISOString();
    if (result.changed > 0) {
      logger.info(
        "Applied {count} webhook route change(s) from route files (poll)",
        { count: result.changed },
      );
    }
    for (const error of result.errors) {
      logger.warn`Webhook route files (poll): ${error}`;
    }
  }
}
