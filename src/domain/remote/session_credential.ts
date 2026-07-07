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
  /** When set, this credential is scoped to a specific dispatch. */
  dispatchId?: string;
}

/** Default credential lifetime: 15 minutes, refreshed well before expiry. */
export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;

/**
 * Generate a 256-bit opaque bearer token, hex-encoded. Used for both
 * data-plane session credentials and enrollment-token secrets.
 */
export function generateOpaqueToken(): string {
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
  #byDispatch = new Map<string, string>();
  #credentialsByWorker = new Map<string, Set<string>>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options?: { ttlMs?: number; now?: () => number }) {
    this.#ttlMs = options?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#now = options?.now ?? Date.now;
  }

  /**
   * Issue a fresh control-channel credential for a worker, revoking any
   * prior control-channel credential. Per-dispatch credentials are not
   * affected by this call.
   */
  issue(workerId: string): SessionCredentialRecord {
    this.revokeForWorker(workerId);
    const record: SessionCredentialRecord = {
      credential: generateOpaqueToken(),
      workerId,
      expiresAtMs: this.#now() + this.#ttlMs,
    };
    this.#byCredential.set(record.credential, record);
    this.#byWorker.set(workerId, record.credential);
    let workerCreds = this.#credentialsByWorker.get(workerId);
    if (!workerCreds) {
      workerCreds = new Set();
      this.#credentialsByWorker.set(workerId, workerCreds);
    }
    workerCreds.add(record.credential);
    return record;
  }

  /**
   * Issue a per-dispatch credential. These are independent of the
   * control-channel credential and are not revoked by `issue()` or
   * `refresh()`. They are revoked explicitly via `revokeDispatch()`.
   */
  issueForDispatch(
    workerId: string,
    dispatchId: string,
  ): SessionCredentialRecord {
    const record: SessionCredentialRecord = {
      credential: generateOpaqueToken(),
      workerId,
      expiresAtMs: this.#now() + this.#ttlMs,
      dispatchId,
    };
    this.#byCredential.set(record.credential, record);
    this.#byDispatch.set(dispatchId, record.credential);
    let workerCreds = this.#credentialsByWorker.get(workerId);
    if (!workerCreds) {
      workerCreds = new Set();
      this.#credentialsByWorker.set(workerId, workerCreds);
    }
    workerCreds.add(record.credential);
    return record;
  }

  /**
   * Verify a presented credential. Returns the worker id and optional
   * dispatch id it authenticates, or null when unknown or expired.
   */
  verify(
    credential: string,
  ): { workerId: string; dispatchId?: string } | null {
    const record = this.#byCredential.get(credential);
    if (!record) {
      return null;
    }
    if (record.expiresAtMs <= this.#now()) {
      this.#deleteCredential(record);
      return null;
    }
    return {
      workerId: record.workerId,
      dispatchId: record.dispatchId,
    };
  }

  /**
   * Slide the window forward: re-issue against a currently valid
   * control-channel credential. Does not affect dispatch credentials.
   */
  refresh(credential: string): SessionCredentialRecord | null {
    const result = this.verify(credential);
    if (result === null) {
      return null;
    }
    if (result.dispatchId) {
      return null;
    }
    return this.issue(result.workerId);
  }

  #deleteCredential(record: SessionCredentialRecord): void {
    this.#byCredential.delete(record.credential);
    if (this.#byWorker.get(record.workerId) === record.credential) {
      this.#byWorker.delete(record.workerId);
    }
    if (record.dispatchId) {
      this.#byDispatch.delete(record.dispatchId);
    }
    this.#credentialsByWorker.get(record.workerId)?.delete(record.credential);
  }

  /** Revoke the worker's control-channel credential, if any. */
  revokeForWorker(workerId: string): void {
    const credential = this.#byWorker.get(workerId);
    if (credential !== undefined) {
      this.#byCredential.delete(credential);
      this.#byWorker.delete(workerId);
      this.#credentialsByWorker.get(workerId)?.delete(credential);
    }
  }

  /** Revoke all credentials for a worker (control + dispatch). */
  revokeAllForWorker(workerId: string): void {
    this.#byWorker.delete(workerId);
    const creds = this.#credentialsByWorker.get(workerId);
    if (creds) {
      for (const cred of creds) {
        const record = this.#byCredential.get(cred);
        if (record?.dispatchId) {
          this.#byDispatch.delete(record.dispatchId);
        }
        this.#byCredential.delete(cred);
      }
      this.#credentialsByWorker.delete(workerId);
    }
  }

  /** Revoke a specific dispatch credential by dispatch id. */
  revokeDispatch(workerId: string, dispatchId: string): void {
    const credential = this.#byDispatch.get(dispatchId);
    if (credential === undefined) return;
    const record = this.#byCredential.get(credential);
    if (!record || record.workerId !== workerId) return;
    this.#deleteCredential(record);
  }
}
