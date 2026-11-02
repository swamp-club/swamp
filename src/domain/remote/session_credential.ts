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
 * per-dispatch credentials keep the same string while the service slides their
 * expiry forward every 2/3 TTL until revoked; control-channel ones are
 * refreshed by the worker over the socket
 */

export interface SessionCredentialRecord {
  credential: string;
  workerId: string;
  expiresAtMs: number;
  dispatchId?: string;
}

export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;

const REFRESH_FRACTION = 2 / 3;

export function generateOpaqueToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SessionCredentialServiceOptions {
  ttlMs?: number;
  now?: () => number;
  setInterval?: (cb: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
}

/**
 * purely in-memory: credentials mean nothing across an orchestrator restart,
 * which drops all control sockets so reconnecting workers re-enroll
 */
export class SessionCredentialService {
  #byCredential = new Map<string, SessionCredentialRecord>();
  #byWorker = new Map<string, string>();
  #byDispatch = new Map<string, string>();
  #credentialsByWorker = new Map<string, Set<string>>();
  #refreshTimers = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #setInterval: (cb: () => void, ms: number) => number;
  readonly #clearInterval: (id: number) => void;

  constructor(options?: SessionCredentialServiceOptions) {
    this.#ttlMs = options?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#now = options?.now ?? Date.now;
    this.#setInterval = options?.setInterval ??
      ((cb: () => void, ms: number) =>
        globalThis.setInterval(cb, ms) as unknown as number);
    this.#clearInterval = options?.clearInterval ??
      ((id: number) => globalThis.clearInterval(id));
  }

  /**
   * revokes any prior control-channel credential for the worker; per-dispatch
   * credentials are unaffected
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
   * auto-refreshes until revoked via revokeDispatch or revokeAllForWorker; the
   * credential string stays the same, so the runner is never notified
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
    this.#startRefreshTimer(dispatchId, record);
    return record;
  }

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

  dispose(): void {
    for (const timerId of this.#refreshTimers.values()) {
      this.#clearInterval(timerId);
    }
    this.#refreshTimers.clear();
  }

  #startRefreshTimer(
    dispatchId: string,
    record: SessionCredentialRecord,
  ): void {
    const intervalMs = Math.max(1_000, this.#ttlMs * REFRESH_FRACTION);
    const timerId = this.#setInterval(() => {
      if (!this.#byCredential.has(record.credential)) {
        this.#stopRefreshTimer(dispatchId);
        return;
      }
      record.expiresAtMs = this.#now() + this.#ttlMs;
    }, intervalMs);
    this.#refreshTimers.set(dispatchId, timerId);
  }

  #stopRefreshTimer(dispatchId: string): void {
    const timerId = this.#refreshTimers.get(dispatchId);
    if (timerId !== undefined) {
      this.#clearInterval(timerId);
      this.#refreshTimers.delete(dispatchId);
    }
  }

  #deleteCredential(record: SessionCredentialRecord): void {
    this.#byCredential.delete(record.credential);
    if (this.#byWorker.get(record.workerId) === record.credential) {
      this.#byWorker.delete(record.workerId);
    }
    if (record.dispatchId) {
      this.#byDispatch.delete(record.dispatchId);
      this.#stopRefreshTimer(record.dispatchId);
    }
    this.#credentialsByWorker.get(record.workerId)?.delete(record.credential);
  }

  revokeForWorker(workerId: string): void {
    const credential = this.#byWorker.get(workerId);
    if (credential !== undefined) {
      this.#byCredential.delete(credential);
      this.#byWorker.delete(workerId);
      this.#credentialsByWorker.get(workerId)?.delete(credential);
    }
  }

  revokeAllForWorker(workerId: string): void {
    this.#byWorker.delete(workerId);
    const creds = this.#credentialsByWorker.get(workerId);
    if (creds) {
      for (const cred of creds) {
        const record = this.#byCredential.get(cred);
        if (record?.dispatchId) {
          this.#byDispatch.delete(record.dispatchId);
          this.#stopRefreshTimer(record.dispatchId);
        }
        this.#byCredential.delete(cred);
      }
      this.#credentialsByWorker.delete(workerId);
    }
  }

  revokeDispatch(workerId: string, dispatchId: string): void {
    const credential = this.#byDispatch.get(dispatchId);
    if (credential === undefined) return;
    const record = this.#byCredential.get(credential);
    if (!record || record.workerId !== workerId) return;
    this.#deleteCredential(record);
  }
}
