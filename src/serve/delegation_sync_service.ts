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

import {
  applyClubIdentity,
  holdDelegation,
  isFinalPhase,
  releaseHold,
} from "../domain/access/delegation.ts";
import type { DelegationDirectory } from "../domain/access/delegation_directory.ts";
import type {
  DelegationRecord,
  HoldCause,
  LinkedPerson,
} from "../domain/models/access/delegation_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type DelegationAuditEvent,
  endLocally,
} from "./delegation_link_service.ts";
import type { DelegationStore } from "./delegation_store.ts";
import {
  type LinkPersonView,
  MAX_PEOPLE_LINK_IDS,
  type ServeLinkClient,
  ServeLinkError,
} from "./serve_link_client.ts";

const logger = getSwampLogger(["serve", "delegation-sync"]);

export const FEED_INTERVAL_MS = 30_000;
export const PEOPLE_INTERVAL_MS = 5 * 60_000;
/** an access token's life: a client refused longer than this ends its links */
export const CLIENT_REFUSAL_END_MS = 60 * 60_000;
export const MAX_SYNC_BACKOFF_MS = 5 * 60_000;
const SYNC_TICK_MS = 1_000;
// a runaway feed can't hold the leader's pass forever; the next pass carries on
const MAX_PAGES_PER_PASS = 50;

export interface DelegationSyncServiceDeps {
  readonly store: Pick<
    DelegationStore,
    "transition" | "readSync" | "syncTransition"
  >;
  readonly directory: Pick<DelegationDirectory, "all">;
  readonly client: () => ServeLinkClient | undefined;
  readonly isLeader: () => boolean;
  readonly audit?: (event: DelegationAuditEvent) => void;
  readonly now?: () => number;
  readonly feedIntervalMs?: number;
  readonly peopleIntervalMs?: number;
  readonly refusalEndMs?: number;
  readonly tickMs?: number;
}

interface Schedule {
  next: number;
  failures: number;
}

type Read = "feed" | "people";

/** only these two mean swamp-club refuses the client; any other 401 or 403 (a proxy, a WAF) is an outage */
const CLIENT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "invalid_client",
  "client_not_collective",
]);

function isClientRefusal(error: unknown): error is ServeLinkError {
  return error instanceof ServeLinkError && error.kind === "unauthorized" &&
    error.code !== undefined && CLIENT_REFUSAL_CODES.has(error.code);
}

/** a reason serve doesn't know yet still ends the delegation, as club_ended */
function endCauseOf(
  endedReason: string | undefined,
): "disowned" | "plan_lapsed" | "club_ended" {
  return endedReason === "disowned" || endedReason === "plan_lapsed"
    ? endedReason
    : "club_ended";
}

/**
 * a link's end ends the delegation it is still the link of; a link a relink
 * replaced ends it only when the person disowns it
 */
function endsWith(
  record: DelegationRecord,
  linkId: string,
  disowned: boolean,
): boolean {
  if (record.club.linkId === linkId) return true;
  return disowned &&
    (record.club.retiredLinks ?? []).some((link) => link.linkId === linkId);
}

function isLinked(record: DelegationRecord): boolean {
  return (record.phase === "issued" || record.phase === "suspended") &&
    record.club.linkId !== undefined;
}

/** turns swamp-club's answers into delegation writes; access is decided where every node reads them */
export class DelegationSyncService {
  readonly #deps: DelegationSyncServiceDeps;
  readonly #schedule: Record<Read, Schedule> = {
    feed: { next: 0, failures: 0 },
    people: { next: 0, failures: 0 },
  };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(deps: DelegationSyncServiceDeps) {
    this.#deps = deps;
  }

  start(): void {
    this.#stopped = false;
    this.#loop();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running;
  }

  /** one pass of whichever reads are due */
  async tick(): Promise<void> {
    if (!this.#deps.isLeader()) return;
    const client = this.#deps.client();
    if (client === undefined) return;
    for (const read of ["feed", "people"] as const) {
      if (this.#stopped) return;
      const schedule = this.#schedule[read];
      const now = this.#now();
      if (schedule.next > now) continue;
      try {
        if (read === "feed") await this.#syncFeed(client);
        else await this.#syncPeople(client);
        schedule.failures = 0;
        schedule.next = this.#now() + this.#interval(read);
      } catch (error) {
        await this.#failed(read, error);
      }
    }
  }

  #loop(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#running = this.tick().catch((error) => {
        logger.error`Delegation sync pass failed: ${error}`;
      }).finally(() => this.#loop());
    }, this.#deps.tickMs ?? SYNC_TICK_MS);
    Deno.unrefTimer(this.#timer);
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #interval(read: Read): number {
    return read === "feed"
      ? this.#deps.feedIntervalMs ?? FEED_INTERVAL_MS
      : this.#deps.peopleIntervalMs ?? PEOPLE_INTERVAL_MS;
  }

  async #failed(read: Read, error: unknown): Promise<void> {
    const schedule = this.#schedule[read];
    const now = this.#now();
    if (isClientRefusal(error)) {
      // checked again at the usual pace, so an accepted client clears it soon
      schedule.next = now + this.#interval(read);
      await this.#clientRefused(error.code!);
      return;
    }
    schedule.failures++;
    const delay = Math.min(
      MAX_SYNC_BACKOFF_MS,
      this.#interval(read) * 2 ** schedule.failures,
    );
    schedule.next = now + delay;
    logger.warn(
      "Reading swamp-club's link {read} failed, retrying in {delay}ms; links keep working meanwhile: {error}",
      {
        read,
        delay,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    // a refused client stays refused through a rate limit or an outage, so
    // its deadline still applies
    try {
      await this.#endPastRefusalDeadline();
    } catch (deadlineError) {
      logger
        .warn`Checking the refused client's deadline failed: ${deadlineError}`;
    }
  }

  async #syncFeed(client: ServeLinkClient): Promise<void> {
    if (!this.#deps.directory.all().some((r) => r.club.linkId !== undefined)) {
      return;
    }
    const stored = (await this.#deps.store.readSync())?.cursor;
    let expected = stored;
    let since = stored;
    let restarted = false;
    for (let page = 0; page < MAX_PAGES_PER_PASS; page++) {
      const changes = await client.changes(since);
      if (changes === "invalid_cursor") {
        if (restarted) {
          throw new ServeLinkError(
            "unavailable",
            "swamp-club refused the start of its link feed",
          );
        }
        logger
          .warn`swamp-club no longer reads this serve's link feed position; reading the feed from its start`;
        restarted = true;
        since = undefined;
        continue;
      }
      await this.#clientAccepted();
      // swamp-club steps an empty page's cursor back by its overlap, so storing
      // it would drift the feed backwards and write on every poll
      if (changes.ended.length === 0 && !restarted) return;
      if (changes.ended.length > 0) {
        await this.#applyEnds(client, changes.ended);
      }
      // another leader moved it; that leader reads on from there
      if (!await this.#storeCursor(expected, changes.cursor)) return;
      expected = changes.cursor;
      since = changes.cursor;
      if (!changes.more) return;
    }
  }

  /** compare and set: a leader replaced mid-page can never move the feed back */
  #storeCursor(expected: string | undefined, to: string): Promise<boolean> {
    const now = new Date(this.#now()).toISOString();
    return this.#deps.store.syncTransition((current) => {
      if (current?.cursor !== expected) return { write: null, value: false };
      if (current?.cursor === to) return { write: null, value: true };
      return {
        write: { ...(current ?? {}), cursor: to, updatedAt: now },
        value: true,
      };
    });
  }

  /**
   * every end applies once: a repeated ID (swamp-club overlaps the feed's end,
   * and a new leader replays from the stored cursor) finds it already ended
   */
  async #applyEnds(
    client: ServeLinkClient,
    linkIds: readonly string[],
  ): Promise<void> {
    const current = new Map<string, DelegationRecord>();
    const retired = new Map<string, DelegationRecord>();
    for (const record of this.#deps.directory.all()) {
      if (isFinalPhase(record.phase)) continue;
      if (record.club.linkId !== undefined) {
        current.set(record.club.linkId, record);
      }
      for (const link of record.club.retiredLinks ?? []) {
        retired.set(link.linkId, record);
      }
    }
    const relevant = linkIds.filter((id) => current.has(id) || retired.has(id));
    if (relevant.length === 0) return;
    const reasons = await this.#endedReasons(client, relevant);
    const now = this.#now();
    for (const linkId of relevant) {
      const cause = endCauseOf(reasons.get(linkId));
      const disowned = cause === "disowned";
      const target = current.get(linkId) ??
        (disowned ? retired.get(linkId) : undefined);
      if (target === undefined) continue;
      await endLocally(
        this.#deps.store,
        target.id,
        cause,
        now,
        this.#deps.audit,
        (fresh) => endsWith(fresh, linkId, disowned),
      );
    }
  }

  /** a cause is a nicety: without one the end still applies, as club_ended */
  async #endedReasons(
    client: ServeLinkClient,
    linkIds: readonly string[],
  ): Promise<Map<string, string>> {
    const reasons = new Map<string, string>();
    for (let i = 0; i < linkIds.length; i += MAX_PEOPLE_LINK_IDS) {
      try {
        const views = await client.people(
          linkIds.slice(i, i + MAX_PEOPLE_LINK_IDS),
        );
        for (const view of views) {
          if (view.state === "ended") {
            reasons.set(view.linkId, view.endedReason);
          }
        }
      } catch (error) {
        if (isClientRefusal(error)) throw error;
      }
    }
    return reasons;
  }

  async #syncPeople(client: ServeLinkClient): Promise<void> {
    const targets = this.#deps.directory.all().filter(isLinked);
    for (let i = 0; i < targets.length; i += MAX_PEOPLE_LINK_IDS) {
      const chunk = targets.slice(i, i + MAX_PEOPLE_LINK_IDS);
      const views = await client.people(chunk.map((r) => r.club.linkId!));
      await this.#clientAccepted();
      const byLink = new Map(views.map((view) => [view.linkId, view]));
      for (const record of chunk) {
        await this.#applyPerson(record, byLink.get(record.club.linkId!));
      }
    }
  }

  async #applyPerson(
    record: DelegationRecord,
    view: LinkPersonView | undefined,
  ): Promise<void> {
    const now = this.#now();
    const linkId = record.club.linkId!;
    if (view?.state === "ended") {
      const cause = endCauseOf(view.endedReason);
      await endLocally(
        this.#deps.store,
        record.id,
        cause,
        now,
        this.#deps.audit,
        (fresh) => endsWith(fresh, linkId, cause === "disowned"),
      );
      return;
    }
    await this.#change(record, (current) => {
      // the link moved on (a relink folded in) since this read was sent
      if (current.club.linkId !== linkId) return current;
      if (view === undefined) {
        return holdDelegation(current, "club_unknown", now);
      }
      let next = releaseHold(current, "club_unknown", now);
      if (view.state === "suspended") {
        return holdDelegation(next, "person_suspended", now);
      }
      next = releaseHold(next, "person_suspended", now);
      const person: LinkedPerson = {
        sub: view.identity.sub,
        username: view.identity.username,
        email: view.identity.email,
        collectives: [...view.identity.collectives],
        groups: [...view.identity.groups],
      };
      return applyClubIdentity(next, person, now);
    });
  }

  /** the client is refused: hold every link, and end them once it lasts past the deadline */
  async #clientRefused(code: string): Promise<void> {
    const now = this.#now();
    const iso = new Date(now).toISOString();
    const since = await this.#deps.store.syncTransition((current) => {
      if (current?.clientRefusal !== undefined) {
        return { write: null, value: current.clientRefusal.since };
      }
      return {
        write: {
          ...(current ?? {}),
          clientRefusal: { since: iso, code: code.slice(0, 64) },
          updatedAt: iso,
        },
        value: iso,
      };
    });
    const deadline = Date.parse(since) +
      (this.#deps.refusalEndMs ?? CLIENT_REFUSAL_END_MS);
    if (since === iso) {
      logger
        .error`swamp-club refuses this serve's client (${code}), so every delegated request is refused; unless swamp-club accepts the client again, every link ends at ${
        new Date(deadline).toISOString()
      }`;
    }
    for (const record of this.#deps.directory.all()) {
      if (
        (record.phase !== "issued" && record.phase !== "suspended") ||
        record.hold?.causes.includes("club_client_refused")
      ) continue;
      await this.#change(
        record,
        (current) => holdDelegation(current, "club_client_refused", now),
      );
    }
    await this.#endPastRefusalDeadline();
  }

  async #endPastRefusalDeadline(): Promise<void> {
    const refusal = (await this.#deps.store.readSync())?.clientRefusal;
    if (refusal === undefined) return;
    const now = this.#now();
    const deadline = Date.parse(refusal.since) +
      (this.#deps.refusalEndMs ?? CLIENT_REFUSAL_END_MS);
    if (now < deadline) return;
    for (const record of this.#deps.directory.all()) {
      if (!record.hold?.causes.includes("club_client_refused")) continue;
      await endLocally(
        this.#deps.store,
        record.id,
        "club_client_refused",
        now,
        this.#deps.audit,
      );
    }
  }

  async #clientAccepted(): Promise<void> {
    const held = this.#deps.directory.all().some((record) =>
      record.hold?.causes.includes("club_client_refused")
    );
    if (
      !held && (await this.#deps.store.readSync())?.clientRefusal === undefined
    ) {
      return;
    }
    const now = this.#now();
    const iso = new Date(now).toISOString();
    const cleared = await this.#deps.store.syncTransition((current) => {
      if (current?.clientRefusal === undefined) {
        return { write: null, value: false };
      }
      const { clientRefusal: _refusal, ...rest } = current;
      return { write: { ...rest, updatedAt: iso }, value: true };
    });
    if (cleared) {
      logger.info`swamp-club accepts this serve's client again`;
    }
    for (const record of this.#deps.directory.all()) {
      if (!record.hold?.causes.includes("club_client_refused")) continue;
      await this.#change(
        record,
        (current) => releaseHold(current, "club_client_refused", now),
      );
    }
  }

  /** one locked write, audited by what actually changed */
  async #change(
    record: DelegationRecord,
    step: (current: DelegationRecord) => DelegationRecord,
  ): Promise<void> {
    const outcome = await this.#deps.store.transition<
      { before: DelegationRecord; after: DelegationRecord } | null
    >(record.id, (current) => {
      if (current === null) {
        return Promise.resolve({ write: null, value: null });
      }
      const after = step(current);
      return Promise.resolve({
        write: after === current ? null : after,
        value: { before: current, after },
      });
    });
    if (outcome === null || outcome.before === outcome.after) return;
    this.#auditChange(outcome.before, outcome.after);
  }

  #auditChange(before: DelegationRecord, after: DelegationRecord): void {
    const audit = this.#deps.audit;
    if (audit === undefined) return;
    const had = new Set<HoldCause>(before.hold?.causes ?? []);
    const has = new Set<HoldCause>(after.hold?.causes ?? []);
    for (const cause of has) {
      if (!had.has(cause)) {
        audit({ action: "suspended", record: after, outcome: cause });
      }
    }
    for (const cause of had) {
      if (!has.has(cause)) {
        audit({ action: "suspension_lifted", record: after, outcome: cause });
      }
    }
    const was = before.person;
    const is = after.person;
    if (
      was !== undefined && is !== undefined &&
      (JSON.stringify(was.collectives) !== JSON.stringify(is.collectives) ||
        JSON.stringify(was.groups) !== JSON.stringify(is.groups))
    ) {
      audit({
        action: "identity_updated",
        record: after,
        outcome: is.collectives.length === 0 ? "outside_collective" : "updated",
      });
    }
  }
}
