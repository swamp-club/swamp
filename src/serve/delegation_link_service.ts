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

import { checkAdmission } from "../domain/access/admission.ts";
import {
  DELEGATION_REDEEM_WINDOW_MS,
  endDelegation,
  recordApproval,
  recordClubEnd,
  recordReported,
  refuseDelegation,
} from "../domain/access/delegation.ts";
import type { DelegationDirectory } from "../domain/access/delegation_directory.ts";
import type { IntegrationLookup } from "../domain/access/integration_directory.ts";
import type { DelegationRecord } from "../domain/models/access/delegation_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { DelegationStore } from "./delegation_store.ts";
import { type ServeLinkClient, ServeLinkError } from "./serve_link_client.ts";

const logger = getSwampLogger(["serve", "delegation-links"]);

export const LINK_TICK_MS = 1_000;
export const MAX_POLL_BACKOFF_MS = 60_000;
/** swamp-club expires an approved link it was never told about after an hour */
export const REPORT_WINDOW_MS = 60 * 60 * 1000;
export const MAX_CLUB_END_BACKOFF_MS = 60 * 60 * 1000;
export const PENDING_END_WARNING_MS = 60 * 60 * 1000;

export interface DelegationAuditEvent {
  readonly action:
    | "consent_result"
    | "refused"
    | "recorded"
    | "ended"
    | "club_ended"
    | "club_end_failed";
  readonly record: DelegationRecord;
  readonly outcome: string;
  readonly detail?: string;
}

export interface DelegationLinkServiceDeps {
  readonly store: DelegationStore;
  readonly directory: Pick<DelegationDirectory, "all" | "supersededBy">;
  readonly integrations: IntegrationLookup;
  readonly client: () => ServeLinkClient | undefined;
  readonly admission: {
    readonly allowedCollectives: readonly string[];
    readonly allowedUsers: readonly string[];
  };
  readonly isLeader: () => boolean;
  readonly audit?: (event: DelegationAuditEvent) => void;
  readonly now?: () => number;
  readonly tickMs?: number;
}

interface Backoff {
  next: number;
  failures: number;
}

/**
 * the leader alone drives links: it polls swamp-club for consent, reports, and
 * tells swamp-club about ends; every step is a locked write, so a second leader
 * briefly overlapping reads what the first wrote and never repeats it
 */
export class DelegationLinkService {
  readonly #deps: DelegationLinkServiceDeps;
  readonly #backoff = new Map<string, Backoff>();
  readonly #warnedAt = new Map<string, number>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(deps: DelegationLinkServiceDeps) {
    this.#deps = deps;
  }

  start(): void {
    this.#stopped = false;
    this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running;
  }

  /** one pass over every delegation; tests call it directly */
  async tick(): Promise<void> {
    if (!this.#deps.isLeader()) return;
    const now = this.#now();
    for (const record of this.#deps.directory.all()) {
      if (this.#stopped) return;
      if (!this.#due(record.id, now)) continue;
      const before = this.#backoff.get(record.id);
      try {
        await this.#step(record, now);
        // a step that chose its own wait (a pending poll) keeps it
        if (this.#backoff.get(record.id) === before) {
          this.#backoff.delete(record.id);
        }
      } catch (error) {
        this.#failed(record, now, error);
      }
    }
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#running = this.tick().catch((error) => {
        logger.error`Delegation link pass failed: ${error}`;
      }).finally(() => this.#schedule());
    }, this.#deps.tickMs ?? LINK_TICK_MS);
    Deno.unrefTimer(this.#timer);
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #due(id: string, now: number): boolean {
    const backoff = this.#backoff.get(id);
    return backoff === undefined || backoff.next <= now;
  }

  #wait(record: DelegationRecord, now: number, ms: number): void {
    const failures = this.#backoff.get(record.id)?.failures ?? 0;
    this.#backoff.set(record.id, { next: now + ms, failures });
  }

  #failed(record: DelegationRecord, now: number, error: unknown): void {
    const failures = (this.#backoff.get(record.id)?.failures ?? 0) + 1;
    const base = record.club.pollIntervalSeconds * 1000;
    const delay = Math.min(MAX_POLL_BACKOFF_MS, base * 2 ** failures);
    this.#backoff.set(record.id, { next: now + delay, failures });
    logger.warn(
      "Delegation {id} link step failed, retrying in {delay}ms: {error}",
      {
        id: record.id,
        delay,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }

  async #step(record: DelegationRecord, now: number): Promise<void> {
    switch (record.phase) {
      case "awaiting_consent":
        return await this.#poll(record, now);
      case "reporting":
        return await this.#report(record, now);
      case "consented":
        if (
          record.consentedAt !== undefined &&
          Date.parse(record.consentedAt) + DELEGATION_REDEEM_WINDOW_MS <= now
        ) await this.#end(record.id, "not_redeemed", now);
        return;
      case "issued":
        return await this.#checkIssued(record, now);
      case "ended":
        return await this.#tellClub(record, now);
      case "refused":
        return;
    }
  }

  async #poll(record: DelegationRecord, now: number): Promise<void> {
    if (Date.parse(record.club.consentExpiresAt) <= now) {
      await this.#refuse(record.id, "consent_expired", now, false);
      return;
    }
    const client = this.#requireClient();
    const status = await client.status(record.club.requestId);
    if (status.status === "pending") {
      this.#wait(record, now, record.club.pollIntervalSeconds * 1000);
      return;
    }
    if (status.status !== "approved") {
      this.#deps.audit?.({
        action: "consent_result",
        record,
        outcome: status.status,
      });
      await this.#refuse(record.id, `consent_${status.status}`, now, false);
      return;
    }
    if (status.digest !== record.club.digest) {
      await this.#refuse(record.id, "digest_mismatch", now, true);
      return;
    }
    const identity = status.identity;
    if (identity === undefined) {
      await this.#refuse(record.id, "identity_unavailable", now, true);
      return;
    }
    const admission = checkAdmission(
      identity.sub,
      identity.collectives,
      this.#deps.admission.allowedCollectives,
      this.#deps.admission.allowedUsers,
    );
    if (!admission.admitted) {
      this.#deps.audit?.({
        action: "consent_result",
        record,
        outcome: "not_admitted",
        detail: admission.reason,
      });
      await this.#refuse(record.id, "not_admitted", now, true);
      return;
    }
    this.#deps.audit?.({
      action: "consent_result",
      record,
      outcome: "approved",
    });
    await this.#deps.store.transition(record.id, (current) => {
      if (current?.phase !== "awaiting_consent") {
        return Promise.resolve({ write: null, value: undefined });
      }
      return Promise.resolve({
        write: recordApproval(current, {
          sub: identity.sub,
          username: identity.username,
          email: identity.email,
          collectives: [...identity.collectives],
          groups: [...identity.groups],
        }, now),
        value: undefined,
      });
    });
    const written = await this.#deps.store.read(record.id);
    if (written?.phase === "reporting") await this.#report(written, now);
  }

  async #report(record: DelegationRecord, now: number): Promise<void> {
    const client = this.#requireClient();
    const outcome = await client.report(record.club.requestId, {
      outcome: "recorded",
    });
    if (outcome.kind === "recorded") {
      await this.#deps.store.transition(record.id, (current) => {
        if (current?.phase !== "reporting") {
          return Promise.resolve({ write: null, value: undefined });
        }
        return Promise.resolve({
          write: recordReported(current, outcome.linkId, now),
          value: undefined,
        });
      });
      const written = await this.#deps.store.read(record.id);
      if (written) {
        this.#deps.audit?.({
          action: "recorded",
          record: written,
          outcome: "recorded",
        });
      }
      return;
    }
    await this.#refuse(
      record.id,
      outcome.kind === "terminal" ? outcome.code : "report_refused",
      now,
      false,
    );
  }

  async #checkIssued(record: DelegationRecord, now: number): Promise<void> {
    if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now) {
      await this.#end(record.id, "expired", now);
      return;
    }
    if (this.#deps.directory.supersededBy(record.id) !== undefined) {
      await this.#end(record.id, "superseded", now);
      return;
    }
    if (
      this.#deps.integrations.standingOf(record.integrationId).kind ===
        "revoked"
    ) {
      await this.#end(record.id, "integration_revoked", now);
    }
  }

  async #tellClub(record: DelegationRecord, now: number): Promise<void> {
    if (
      record.club.endState !== "pending" || record.club.linkId === undefined
    ) {
      return;
    }
    if (
      record.club.nextEndAttemptAt !== undefined &&
      Date.parse(record.club.nextEndAttemptAt) > now
    ) {
      this.#warnIfOld(record, now);
      return;
    }
    const client = this.#deps.client();
    let failure: string | undefined;
    if (client === undefined) {
      failure = "this serve has no swamp-club client";
    } else {
      try {
        await client.end(record.club.linkId);
      } catch (error) {
        failure = error instanceof ServeLinkError
          ? `${error.kind}: ${error.message}`
          : String(error);
      }
    }
    const retryAtMs = now +
      Math.min(MAX_CLUB_END_BACKOFF_MS, 30_000 * 2 ** record.club.endAttempts);
    await this.#deps.store.transition(record.id, (current) => {
      if (current === null || current.club.endState !== "pending") {
        return Promise.resolve({ write: null, value: undefined });
      }
      return Promise.resolve({
        write: recordClubEnd(
          current,
          failure === undefined
            ? { ok: true }
            : { ok: false, error: failure, retryAtMs },
          now,
        ),
        value: undefined,
      });
    });
    this.#deps.audit?.({
      action: failure === undefined ? "club_ended" : "club_end_failed",
      record,
      outcome: failure === undefined ? "ok" : "failed",
      ...(failure !== undefined ? { detail: failure } : {}),
    });
    if (failure !== undefined) this.#warnIfOld(record, now);
  }

  #warnIfOld(record: DelegationRecord, now: number): void {
    const endedAt = record.ended ? Date.parse(record.ended.at) : now;
    if (now - endedAt < PENDING_END_WARNING_MS) return;
    const warned = this.#warnedAt.get(record.id) ?? 0;
    if (now - warned < PENDING_END_WARNING_MS) return;
    this.#warnedAt.set(record.id, now);
    logger.warn(
      "Delegation {id} ended here but swamp-club has not been told after {attempts} attempt(s): {error}",
      {
        id: record.id,
        attempts: record.club.endAttempts,
        error: record.club.lastEndError ?? "not tried yet",
      },
    );
  }

  async #refuse(
    id: string,
    reason: string,
    now: number,
    tellClub: boolean,
  ): Promise<void> {
    if (tellClub) {
      const record = await this.#deps.store.read(id);
      if (record) {
        try {
          await this.#requireClient().report(record.club.requestId, {
            outcome: "refused",
            reason,
          });
        } catch (error) {
          // swamp-club expires an unreported approval itself within the hour
          logger.warn("Delegation {id} refusal not reported: {error}", {
            id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    await this.#deps.store.transition(id, (current) => {
      if (
        current === null ||
        (current.phase !== "awaiting_consent" && current.phase !== "reporting")
      ) return Promise.resolve({ write: null, value: undefined });
      return Promise.resolve({
        write: refuseDelegation(current, reason, now),
        value: undefined,
      });
    });
    const written = await this.#deps.store.read(id);
    if (written) {
      this.#deps.audit?.({
        action: "refused",
        record: written,
        outcome: reason,
      });
    }
  }

  async #end(id: string, cause: string, now: number): Promise<void> {
    await endLocally(this.#deps.store, id, cause, now, this.#deps.audit);
  }

  #requireClient(): ServeLinkClient {
    const client = this.#deps.client();
    if (client === undefined) {
      throw new ServeLinkError(
        "unavailable",
        "this serve has no swamp-club client to link through",
      );
    }
    return client;
  }
}

/** shared with the routes and the operator command: an end applies here at once */
export async function endLocally(
  store: DelegationStore,
  id: string,
  cause: string,
  now: number,
  audit?: (event: DelegationAuditEvent) => void,
): Promise<DelegationRecord | null> {
  const ended = await store.transition(id, (current) => {
    if (current === null) {
      return Promise.resolve({ write: null, value: null });
    }
    if (current.phase === "ended" || current.phase === "refused") {
      return Promise.resolve({ write: null, value: current });
    }
    const next = current.phase === "awaiting_consent" ||
        current.phase === "reporting"
      ? refuseDelegation(current, cause, now)
      : endDelegation(current, cause, now);
    return Promise.resolve({ write: next, value: next });
  });
  if (ended !== null) {
    audit?.({ action: "ended", record: ended, outcome: cause });
  }
  return ended;
}
