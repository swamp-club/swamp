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
 * Session credentials for the remote-execution data plane.
 *
 * At enrollment the orchestrator issues a short-lived bearer credential; the
 * worker presents it on every data-plane HTTP request and refreshes it over
 * the control socket before expiry, so the window slides forward (see
 * design/remote-execution.md, "Authenticating the data plane").
 */

export interface SessionCredentialRecord {
  credential: string;
  workerId: string;
  /** Epoch ms after which the credential no longer verifies. */
  expiresAtMs: number;
}

/** Default credential lifetime: 15 minutes, refreshed well before expiry. */
export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;

function generateCredential(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Issues, verifies, refreshes, and revokes data-plane session credentials.
 * Purely in-memory: credentials are meaningless across an orchestrator
 * restart, which matches the worker lifecycle — a restarted orchestrator
 * drops all control sockets, and reconnecting workers re-enroll.
 */
export class SessionCredentialService {
  #byCredential = new Map<string, SessionCredentialRecord>();
  #byWorker = new Map<string, string>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options?: { ttlMs?: number; now?: () => number }) {
    this.#ttlMs = options?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#now = options?.now ?? Date.now;
  }

  /**
   * Issue a fresh credential for a worker, revoking any prior one — a worker
   * holds exactly one valid session credential at a time.
   */
  issue(workerId: string): SessionCredentialRecord {
    this.revokeForWorker(workerId);
    const record: SessionCredentialRecord = {
      credential: generateCredential(),
      workerId,
      expiresAtMs: this.#now() + this.#ttlMs,
    };
    this.#byCredential.set(record.credential, record);
    this.#byWorker.set(workerId, record.credential);
    return record;
  }

  /**
   * Verify a presented credential. Returns the worker id it authenticates,
   * or null when unknown or expired. Expired records are pruned on sight.
   */
  verify(credential: string): string | null {
    const record = this.#byCredential.get(credential);
    if (!record) {
      return null;
    }
    if (record.expiresAtMs <= this.#now()) {
      this.#byCredential.delete(credential);
      if (this.#byWorker.get(record.workerId) === credential) {
        this.#byWorker.delete(record.workerId);
      }
      return null;
    }
    return record.workerId;
  }

  /**
   * Slide the window forward: re-issue against a currently valid credential.
   * Returns null when the presented credential is not valid, in which case
   * the worker must re-enroll.
   */
  refresh(credential: string): SessionCredentialRecord | null {
    const workerId = this.verify(credential);
    if (workerId === null) {
      return null;
    }
    return this.issue(workerId);
  }

  /** Revoke the worker's current credential, if any. */
  revokeForWorker(workerId: string): void {
    const credential = this.#byWorker.get(workerId);
    if (credential !== undefined) {
      this.#byCredential.delete(credential);
      this.#byWorker.delete(workerId);
    }
  }
}
