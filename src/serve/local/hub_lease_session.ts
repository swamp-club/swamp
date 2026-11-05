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

import type {
  IssuedLease,
  LeaseRequest,
} from "../../infrastructure/http/hub_admin_client.ts";

/** renewing well inside the hub's lease TTL keeps a live invocation's lease */
export const LEASE_RENEW_MS = 15_000;

export interface HubLeaseClient {
  issueLease(request: LeaseRequest): Promise<IssuedLease>;
  setBackend(id: string, port: number): Promise<void>;
  renew(id: string): Promise<{ readonly pages: number } | null>;
  revoke(id: string): Promise<void>;
}

/**
 * One `swamp start` or `swamp dashboard` invocation's page lease on the hub:
 * its token is the page token, renewal reports the open dashboard tabs, and
 * closing revokes it so the hub can stop.
 */
export class HubLeaseSession {
  readonly #client: HubLeaseClient;
  readonly #lease: IssuedLease;
  readonly #renewMs: number;
  readonly #stop = new AbortController();
  #pages = 0;
  #lost = false;
  #loop: Promise<void> | undefined;
  #onPages: ((pages: number) => void) | undefined;

  private constructor(
    client: HubLeaseClient,
    lease: IssuedLease,
    renewMs: number,
  ) {
    this.#client = client;
    this.#lease = lease;
    this.#renewMs = renewMs;
  }

  static async open(
    client: HubLeaseClient,
    request: LeaseRequest,
    options: { readonly renewMs?: number } = {},
  ): Promise<HubLeaseSession> {
    const lease = await client.issueLease(request);
    const session = new HubLeaseSession(
      client,
      lease,
      options.renewMs ?? LEASE_RENEW_MS,
    );
    session.#loop = session.#renew();
    return session;
  }

  get token(): string {
    return this.#lease.token;
  }

  /** dashboard tabs open on this lease when the hub last said */
  get pages(): number {
    return this.#pages;
  }

  /** true once the hub no longer holds the lease (it stopped or expired it) */
  get lost(): boolean {
    return this.#lost;
  }

  onPages(listener: (pages: number) => void): void {
    this.#onPages = listener;
  }

  async attachBackend(port: number): Promise<void> {
    await this.#client.setBackend(this.#lease.id, port);
  }

  async #renew(): Promise<void> {
    const signal = this.#stop.signal;
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#renewMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (signal.aborted) return;
      try {
        const status = await this.#client.renew(this.#lease.id);
        if (status === null) {
          this.#lost = true;
          this.#pages = 0;
          this.#onPages?.(0);
          return;
        }
        this.#pages = status.pages;
        this.#onPages?.(status.pages);
      } catch {
        // A missed renewal is retried; the hub's TTL outlasts several.
      }
    }
  }

  async close(): Promise<void> {
    this.#stop.abort();
    await this.#loop;
    if (!this.#lost) {
      try {
        await this.#client.revoke(this.#lease.id);
      } catch {
        // A hub that is gone has no lease left to revoke.
      }
    }
  }
}
