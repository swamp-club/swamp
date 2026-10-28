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
 * The owner of a v3 datastore (swamp-club#4063): the serve a team writes
 * through once `swamp datastore claim` names it. The owner is serve's
 * address, the one clients put in `serverAddress`, not one serve process:
 * every serve node behind that address writes as the owner, so a failover
 * is not a change of owner. A direct writer that finds an owner refuses.
 */

import { normalizeServerUrl } from "../auth/server_url.ts";
import { UserError } from "../errors.ts";

/** Error code for a write refused because serve owns the datastore. */
export const DATASTORE_CLAIMED_CODE = "datastore_claimed";

/** A claim on a v3 datastore: who owns it, since when, from where in the log. */
export class DatastoreOwner {
  private constructor(
    /** The normalized http(s) address (see `normalizeServerUrl`). */
    readonly address: string,
    /** When the claim was written, as an ISO 8601 timestamp. */
    readonly claimedAt: string,
    /**
     * The log's high-water mark when the claim was written: every commit at
     * or below it was caught up before serve took over.
     */
    readonly claimedAtCursor: number,
  ) {}

  /**
   * Validates and normalizes the input.
   *
   * @throws {UserError} when the address is not an http(s) or ws(s) URL,
   *   the timestamp is not a date, or the cursor is not a whole number from 0
   */
  static create(input: {
    readonly address: string;
    readonly claimedAt: string;
    readonly claimedAtCursor: number;
  }): DatastoreOwner {
    const address = normalizeOwnerAddress(input.address);
    if (Number.isNaN(Date.parse(input.claimedAt))) {
      throw new UserError(
        `A datastore claim's time is not a date: ${input.claimedAt}`,
      );
    }
    if (
      !Number.isSafeInteger(input.claimedAtCursor) || input.claimedAtCursor < 0
    ) {
      throw new UserError(
        `A datastore claim's log position must be a whole number from 0: ${input.claimedAtCursor}`,
      );
    }
    return new DatastoreOwner(address, input.claimedAt, input.claimedAtCursor);
  }

  /** Whether `address` names this owner, once normalized. */
  isAddress(address: string): boolean {
    return normalizeOwnerAddress(address) === this.address;
  }
}

/**
 * `address` normalized as an owner address: the form clients compare,
 * without credentials, query or fragment.
 *
 * @throws {UserError} when it is not an http(s) or ws(s) URL
 */
export function normalizeOwnerAddress(address: string): string {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new UserError(
      "The serve address is not a valid http(s) or ws(s) URL: give the " +
        "address clients put in serverAddress, e.g. https://swamp.example.com",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new UserError(
      "The serve address must not carry credentials: give the address " +
        "clients put in serverAddress, without a user or password",
    );
  }
  try {
    return normalizeServerUrl(address);
  } catch {
    throw new UserError(
      "The serve address is not a valid http(s) or ws(s) URL: give the " +
        "address clients put in serverAddress, e.g. https://swamp.example.com",
    );
  }
}

/**
 * Thrown when a writer that is not the datastore's owner tries to write a
 * claimed v3 datastore. Reads stay allowed; writes go through the owner.
 */
export class DatastoreClaimedError extends UserError {
  declare readonly code: typeof DATASTORE_CLAIMED_CODE;

  /**
   * @param detail what the refused writer did, before the way out
   * @param wayOut replaces the way out for a client (write through serve)
   */
  constructor(
    readonly owner: DatastoreOwner,
    readonly detail?: string,
    readonly wayOut?: string,
  ) {
    super(
      `This v3 datastore is claimed by swamp serve at ${owner.address} ` +
        `(since ${owner.claimedAt}): writes go through serve. ` +
        (detail === undefined ? "" : `${detail} `) +
        (wayOut ??
          "Set serverAddress in .swamp.yaml or SWAMP_SERVE_URL to " +
            `${owner.address}, then run 'swamp auth server-login --server ` +
            `${owner.address}'. Reads still work.`) +
        " Nothing was changed.",
      DATASTORE_CLAIMED_CODE,
    );
    this.name = "DatastoreClaimedError";
  }
}
