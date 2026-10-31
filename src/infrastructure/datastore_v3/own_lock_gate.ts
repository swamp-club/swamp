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
 * What serve's own runs wait on before taking a behavior's lock
 * (swamp-club#4195). A new serve leader adopts the explicit leases the
 * leader before it kept; until a lease on a key is adopted, a run of serve's
 * own must not take that key's lock, or it would run on a behavior someone
 * still holds. Serve's runs take their locks apart from the lease API, so
 * serve sets this gate for its process; a CLI process never does, and its
 * locks never wait on it.
 *
 * @module
 */

/** Resolves once serve's own run may take the lock for `lockKey`. */
export type OwnLockGate = (
  lockKey: string,
  maxWaitMs: number,
) => Promise<void>;

let gate: OwnLockGate | undefined;

/** Sets this process's gate, or clears it with undefined. */
export function setOwnLockGate(next: OwnLockGate | undefined): void {
  gate = next;
}

/**
 * Waits until the gate lets this process take the lock for `lockKey`, a
 * lock key without a namespace; at once when no gate is set.
 *
 * @throws LockTimeoutError when the gate is still shut after `maxWaitMs`
 */
export async function passOwnLockGate(
  lockKey: string,
  maxWaitMs: number,
): Promise<void> {
  await gate?.(lockKey, maxWaitMs);
}
