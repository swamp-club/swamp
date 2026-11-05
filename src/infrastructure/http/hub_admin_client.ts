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

export const HUB_ADMIN_TIMEOUT_MS = 10_000;

export class HubAdminError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`The swamp hub refused the request (${status} ${code})`);
    this.name = "HubAdminError";
  }
}

export interface HubPing {
  readonly pid: number;
  readonly port: number;
  readonly engine: string;
  readonly engineGitSha: string;
  readonly autoExit: boolean;
}

/** the swamp command holding a lease, as the hub overview names it */
export type LeaseClient = "start" | "dashboard" | "hub";

interface LeaseOwner {
  readonly client?: LeaseClient;
  readonly pid?: number;
  /** the page's own requests and open tabs keep the lease, not a running command */
  readonly pageRenewed?: true;
}

export type LeaseRequest =
  | LeaseOwner & {
    readonly scope: "all";
    /** lets the page read the hub overview and stop engines, sessions or the hub */
    readonly manage?: true;
  }
  | LeaseOwner & {
    readonly scope: "workspace";
    readonly workspace: string;
    /** serve the workspace from this folder instead of the registry */
    readonly path?: string;
  };

export interface IssuedLease {
  readonly id: string;
  readonly token: string;
}

/** The hub's loopback admin API, authenticated with the record's admin token. */
export class HubAdminClient {
  readonly #base: string;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(
    port: number,
    adminToken: string,
    timeoutMs = HUB_ADMIN_TIMEOUT_MS,
  ) {
    this.#base = `http://127.0.0.1:${port}`;
    this.#token = adminToken;
    this.#timeoutMs = timeoutMs;
  }

  async #call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.#timeoutMs,
  ): Promise<Response> {
    const response = await fetch(this.#base + path, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return response;
    let code = "unknown";
    try {
      code = String((await response.json()).error ?? code);
    } catch {
      // The status is enough.
    }
    throw new HubAdminError(response.status, code);
  }

  async ping(timeoutMs?: number): Promise<HubPing> {
    return await (await this.#call("GET", "/hub/ping", undefined, timeoutMs))
      .json();
  }

  async issueLease(request: LeaseRequest): Promise<IssuedLease> {
    return await (await this.#call("POST", "/hub/leases", request)).json();
  }

  async setBackend(id: string, port: number): Promise<void> {
    const response = await this.#call(
      "PUT",
      `/hub/leases/${encodeURIComponent(id)}/backend`,
      { url: `http://127.0.0.1:${port}` },
    );
    await response.body?.cancel();
  }

  /** renews the lease; null once the hub no longer holds it */
  async renew(id: string): Promise<{ readonly pages: number } | null> {
    try {
      const response = await this.#call(
        "GET",
        `/hub/leases/${encodeURIComponent(id)}`,
      );
      return await response.json();
    } catch (error) {
      if (error instanceof HubAdminError && error.status === 404) return null;
      // A refused loopback connection is a hub that has exited; a new one
      // would have a new admin token, so the lease is gone either way.
      if (error instanceof TypeError) return null;
      throw error;
    }
  }

  async revoke(id: string): Promise<void> {
    try {
      const response = await this.#call(
        "DELETE",
        `/hub/leases/${encodeURIComponent(id)}`,
      );
      await response.body?.cancel();
    } catch (error) {
      if (error instanceof HubAdminError && error.status === 404) return;
      throw error;
    }
  }

  /** false when the hub won't stop: it isn't one swamp launched, or holds leases */
  async shutdown(): Promise<boolean> {
    try {
      const response = await this.#call("POST", "/hub/shutdown");
      await response.body?.cancel();
      return true;
    } catch (error) {
      if (error instanceof HubAdminError && error.status === 409) return false;
      throw error;
    }
  }
}
