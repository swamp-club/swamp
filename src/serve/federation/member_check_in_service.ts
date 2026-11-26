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
  backoffDelayMs,
  clampIntervalSeconds,
  DEFAULT_CHECK_IN_INTERVAL_SECONDS,
  DEFAULT_INTERVAL_BOUNDS,
  type IntervalBounds,
  MAX_BACKOFF_MS,
  nextCheckInDelayMs,
} from "../../domain/serve/check_in_schedule.ts";
import type { Fingerprint } from "../../domain/serve/fingerprint.ts";
import {
  type CheckInResult,
  decideStart,
  type HubLink,
  type HubLinkInstance,
  type StartDecision,
} from "../../domain/serve/hub_link.ts";
import { InstanceId } from "../../domain/serve/instance_id.ts";
import type { MemberCredential } from "../../domain/serve/member_credential.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { HubClient, HubOutcome } from "./hub_client.ts";
import type { HubLinkStore } from "./hub_link_store.ts";
import type { MemberCredentialVault } from "./member_credential_vault.ts";

const logger = getSwampLogger(["serve", "federation", "member"]);

export const MAX_JOIN_TOKEN_BYTES = 4096;
export const DEFAULT_LIVENESS_MS = 30_000;
export const DEFAULT_JOIN_WAIT_MS = 5_000;
const JOIN_WRITE_ATTEMPTS = 5;
const JOIN_WRITE_RETRY_MS = 250;

export interface MemberCheckInSchedule {
  readonly intervalBounds: IntervalBounds;
  readonly maxBackoffMs: number;
  /** how often aliveAt is refreshed, whatever the link state */
  readonly livenessMs: number;
  /** how often a node that lost the join claim looks for the credential */
  readonly joinWaitMs: number;
  readonly random: () => number;
}

export const DEFAULT_MEMBER_SCHEDULE: MemberCheckInSchedule = {
  intervalBounds: DEFAULT_INTERVAL_BOUNDS,
  maxBackoffMs: MAX_BACKOFF_MS,
  livenessMs: DEFAULT_LIVENESS_MS,
  joinWaitMs: DEFAULT_JOIN_WAIT_MS,
  random: Math.random,
};

export interface MemberCheckInServiceOptions {
  readonly hubUrl: string;
  readonly joinTokenFile?: string;
  readonly instanceId: string;
  readonly links: HubLinkStore;
  readonly credentials: MemberCredentialVault;
  readonly client: Pick<HubClient, "join" | "checkIn" | "dispose">;
  /** this serve's fingerprint, runtime fields included */
  readonly fingerprint: () => Promise<Fingerprint>;
  readonly readJoinToken?: (path: string) => Promise<string | undefined>;
  readonly now?: () => number;
  readonly schedule?: Partial<MemberCheckInSchedule>;
}

type Step =
  | { readonly kind: "stop" }
  | { readonly kind: "check-in"; readonly credential: MemberCredential }
  | { readonly kind: "wait"; readonly delayMs: number };

/**
 * joins the hub once and checks in on the hub's cadence, in the background;
 * nothing here ever rejects into serve, and serve never waits on the hub
 */
export class MemberCheckInService {
  readonly #options: MemberCheckInServiceOptions;
  readonly #schedule: MemberCheckInSchedule;
  readonly #now: () => number;
  readonly #instanceId: string;
  readonly #stopped = new AbortController();
  #instance: HubLinkInstance;
  #writes: Promise<void> = Promise.resolve();
  #run: Promise<void> | undefined;
  #liveness: Promise<void> | undefined;
  #intervalSeconds = DEFAULT_CHECK_IN_INTERVAL_SECONDS;
  #lastLogged: CheckInResult | "joined" | undefined;

  constructor(options: MemberCheckInServiceOptions) {
    this.#options = options;
    this.#schedule = { ...DEFAULT_MEMBER_SCHEDULE, ...options.schedule };
    this.#now = options.now ?? Date.now;
    this.#instanceId = InstanceId.create(options.instanceId).value;
    const startedAt = this.#iso();
    this.#instance = {
      instanceId: this.#instanceId,
      startedAt,
      aliveAt: startedAt,
      lastAttemptAt: null,
      lastSuccessAt: null,
      result: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
      stoppedAt: null,
    };
  }

  /** returns at once; stop() waits for what this started */
  start(): void {
    if (this.#run !== undefined) return;
    this.#run = this.#guarded("run", () => this.#main());
    this.#liveness = this.#guarded("liveness", () => this.#keepAlive());
  }

  async stop(): Promise<void> {
    this.#stopped.abort();
    this.#options.client.dispose();
    await this.#run;
    await this.#liveness;
    if (this.#run === undefined) return;
    this.#instance = { ...this.#instance, stoppedAt: this.#iso() };
    await this.#guarded("stop", () => this.#saveInstance());
  }

  get #aborted(): boolean {
    return this.#stopped.signal.aborted;
  }

  async #main(): Promise<void> {
    await this.#guarded("prune", async () => {
      await this.#options.links.pruneInstances(this.#instanceId);
    });
    await this.#saveInstance();
    while (!this.#aborted) {
      let step: Step;
      try {
        step = await this.#nextStep();
      } catch (error) {
        logger.warn("Federation member could not reach its link: {error}", {
          error: messageOf(error),
        });
        step = { kind: "wait", delayMs: this.#backoff() };
      }
      if (step.kind === "stop") return;
      if (step.kind === "wait") {
        await this.#sleep(step.delayMs);
        continue;
      }
      await this.#checkInLoop(step.credential);
      return;
    }
  }

  async #decide(): Promise<StartDecision & { credential?: MemberCredential }> {
    const credential = await this.#options.credentials.read();
    const link = await this.#options.links.readLink();
    return {
      ...decideStart(link, {
        configuredHubUrl: this.#options.hubUrl,
        credentialMemberId: credential?.memberId,
        hasJoinToken: this.#options.joinTokenFile !== undefined,
      }),
      credential,
    };
  }

  async #nextStep(): Promise<Step> {
    const decision = await this.#decide();
    switch (decision.action) {
      case "check-in": {
        await this.#writeLinkIfChanged(decision.link);
        return { kind: "check-in", credential: decision.credential! };
      }
      case "mismatched": {
        await this.#writeLinkIfChanged(decision.link);
        this.#logOnce("rejected", () =>
          logger.error(
            "Not joining: this serve already belongs to the hub at {joined}, and serve.yaml names another. Stop serve and run swamp serve hub forget --yes to leave it",
            { joined: hostOf(decision.link.hubUrl) },
          ));
        return { kind: "stop" };
      }
      case "idle":
      case "join":
        return await this.#underClaim();
    }
  }

  // joining and discarding a stray credential run only under the one join claim
  async #underClaim(): Promise<Step> {
    const links = this.#options.links;
    if (!await links.claimJoin(this.#instanceId)) {
      await this.#record("waiting");
      return { kind: "wait", delayMs: this.#schedule.joinWaitMs };
    }
    try {
      const decision = await this.#decide();
      if (decision.action === "check-in" || decision.action === "mismatched") {
        return { kind: "wait", delayMs: 0 };
      }
      if (decision.discardCredential) {
        await this.#options.credentials.delete();
      }
      await this.#writeLinkIfChanged(decision.link);
      if (decision.action === "idle") {
        this.#logOnce(
          decision.link.state === "refused" ? "refused" : "waiting",
          () =>
            decision.link.state === "refused"
              ? logger.warn(
                "Removed by its hub. To join again, set a new join-token-file and restart serve",
              )
              : logger.warn(
                "Not joined: serve.yaml sets federation.hub but no join-token-file",
              ),
        );
        return { kind: "stop" };
      }
      return await this.#join(decision.link);
    } finally {
      await links.releaseJoin(this.#instanceId);
    }
  }

  async #join(previous: HubLink): Promise<Step> {
    const token = await (this.#options.readJoinToken ?? readJoinTokenFile)(
      this.#options.joinTokenFile!,
    );
    if (token === undefined) {
      this.#logOnce("join_refused", () =>
        logger.error(
          "Not joining: the join-token-file is missing, empty or over {max} bytes. Fix it and restart serve",
          { max: MAX_JOIN_TOKEN_BYTES },
        ));
      return { kind: "stop" };
    }
    const joining = previous.beginJoin(this.#options.hubUrl);
    await this.#options.links.writeLink(joining);
    const outcome = await this.#options.client.join(
      token,
      await this.#options.fingerprint(),
    );
    this.#instance = {
      ...this.#instance,
      lastAttemptAt: this.#iso(),
    };
    if (outcome.kind === "ok") {
      const reply = outcome.value;
      const received = joining.received({
        memberId: reply.memberId,
        memberName: reply.memberName,
        hubName: reply.hub.name,
        joinedAt: this.#iso(),
      });
      // the hub spent the token: from here a lost write loses the membership.
      // The reply is recorded first, so a restart finds a stored credential its own
      await this.#retrying(() => this.#options.links.writeLink(received));
      await this.#retrying(() =>
        this.#options.credentials.store(reply.credential)
      );
      await this.#retrying(() =>
        this.#options.links.writeLink(received.joined())
      );
      this.#intervalSeconds = this.#clamp(reply.checkInIntervalSeconds);
      this.#lastLogged = "joined";
      logger.info("Joined hub {hub} as member {member}", {
        hub: reply.hub.name,
        member: reply.memberName,
      });
      return { kind: "check-in", credential: reply.credential };
    }
    await this.#rollBackJoin(previous);
    if (outcome.kind === "stopped") return { kind: "stop" };
    if (outcome.kind === "unauthorized") {
      // a token spent by another node that joined meanwhile is no refusal
      const now = await this.#options.links.readLink();
      if (now.memberId !== null && now.state !== "refused") {
        return { kind: "wait", delayMs: this.#schedule.joinWaitMs };
      }
      await this.#record("join_refused");
      this.#logOnce("join_refused", () =>
        logger.error(
          "The hub refused the join token (used, expired, revoked or unknown). Mint a new one and restart serve",
        ));
      return { kind: "stop" };
    }
    if (outcome.kind === "conflict") {
      await this.#record("name_taken");
      this.#logOnce("name_taken", () =>
        logger.error(
          "The hub refused the join: a live member already has this name. Remove it on the hub, then restart serve",
        ));
      return { kind: "stop" };
    }
    return { kind: "wait", delayMs: await this.#failed(outcome) };
  }

  // another node may have joined meanwhile: undo only a joining record with no reply yet, which the join claim makes ours
  async #rollBackJoin(previous: HubLink): Promise<void> {
    const stored = await this.#options.links.readLink();
    if (stored.state === "joining" && stored.memberId === null) {
      await this.#options.links.writeLink(previous);
    }
  }

  // short and deaf to shutdown: an issued credential is worth a few seconds,
  // and the join claim must not go stale meanwhile
  async #retrying(write: () => Promise<void>): Promise<void> {
    for (let attempt = 1;; attempt++) {
      try {
        await write();
        return;
      } catch (error) {
        if (attempt >= JOIN_WRITE_ATTEMPTS) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, JOIN_WRITE_RETRY_MS * attempt)
        );
      }
    }
  }

  async #checkInLoop(credential: MemberCredential): Promise<void> {
    while (!this.#aborted) {
      let delayMs: number;
      try {
        const outcome = await this.#options.client.checkIn(
          credential,
          this.#instanceId,
          await this.#options.fingerprint(),
        );
        if (outcome.kind === "stopped") return;
        if (outcome.kind === "unauthorized") {
          await this.#refused(credential);
          return;
        }
        if (outcome.kind === "ok") {
          this.#intervalSeconds = this.#clamp(
            outcome.value.checkInIntervalSeconds,
          );
          await this.#nameHub(credential, outcome.value.hub.name);
          delayMs = this.#intervalDelay();
          await this.#succeeded(delayMs);
        } else {
          delayMs = await this.#failed(outcome);
        }
      } catch (error) {
        logger.warn("Federation check-in failed: {error}", {
          error: messageOf(error),
        });
        delayMs = await this.#failed({ kind: "unreachable" });
      }
      await this.#sleep(delayMs);
    }
  }

  // only the link and credential of the member that was refused; a newer join is left alone
  async #refused(credential: MemberCredential): Promise<void> {
    const link = await this.#options.links.readLink();
    if (link.memberId === credential.memberId && link.holdsCredential) {
      await this.#options.links.writeLink(link.refuse());
    }
    const stored = await this.#options.credentials.read();
    if (stored?.memberId === credential.memberId) {
      await this.#options.credentials.delete();
    }
    await this.#record("refused");
    this.#logOnce("refused", () =>
      logger.warn(
        "The hub refused this serve's credential: it was removed or revoked. Check-ins stopped and the credential was deleted",
      ));
  }

  async #nameHub(credential: MemberCredential, hubName: string): Promise<void> {
    const link = await this.#options.links.readLink();
    if (link.memberId !== credential.memberId || !link.checksIn) return;
    await this.#writeLinkIfChanged(link.withHubName(hubName));
  }

  async #succeeded(delayMs: number): Promise<void> {
    const at = this.#iso();
    if (this.#lastLogged !== undefined && this.#lastLogged !== "joined") {
      logger.info("Federation check-in succeeded again");
    }
    this.#lastLogged = undefined;
    this.#instance = {
      ...this.#instance,
      lastAttemptAt: at,
      lastSuccessAt: at,
      result: "ok",
      consecutiveFailures: 0,
      nextAttemptAt: new Date(this.#now() + delayMs).toISOString(),
    };
    await this.#saveInstance();
  }

  async #failed(outcome: HubOutcome<unknown>): Promise<number> {
    const failures = this.#instance.consecutiveFailures + 1;
    const result = resultOf(outcome);
    const delayMs = result === "instance_limit"
      ? this.#schedule.maxBackoffMs
      : this.#backoff(
        failures,
        outcome.kind === "rate_limited" ? outcome.retryAfterSeconds : undefined,
      );
    this.#instance = {
      ...this.#instance,
      lastAttemptAt: this.#iso(),
      result,
      consecutiveFailures: failures,
      nextAttemptAt: new Date(this.#now() + delayMs).toISOString(),
    };
    this.#logOnce(result, () =>
      logger.warn(
        "Federation request to the hub failed ({result}); retrying with backoff",
        { result },
      ));
    await this.#saveInstance();
    return delayMs;
  }

  async #record(result: CheckInResult): Promise<void> {
    this.#instance = { ...this.#instance, result, nextAttemptAt: null };
    await this.#saveInstance();
  }

  async #keepAlive(): Promise<void> {
    while (!this.#aborted) {
      await this.#sleep(this.#schedule.livenessMs);
      if (this.#aborted) return;
      this.#instance = { ...this.#instance, aliveAt: this.#iso() };
      await this.#guarded("liveness", () => this.#saveInstance());
    }
  }

  // one write at a time, so the loop and the liveness tick never interleave;
  // best effort: a store outage must never end the loop
  #saveInstance(): Promise<void> {
    const write = this.#writes.then(() =>
      this.#options.links.writeInstance(this.#instance)
    ).catch((error) => {
      logger.debug("Federation instance record not written: {error}", {
        error: messageOf(error),
      });
    });
    this.#writes = write;
    return write;
  }

  async #writeLinkIfChanged(link: HubLink): Promise<void> {
    const stored = await this.#options.links.readLink();
    if (JSON.stringify(stored.toJSON()) !== JSON.stringify(link.toJSON())) {
      await this.#options.links.writeLink(link);
    }
  }

  #clamp(seconds: number): number {
    return clampIntervalSeconds(seconds, this.#schedule.intervalBounds);
  }

  #intervalDelay(): number {
    return nextCheckInDelayMs(this.#intervalSeconds, this.#schedule.random);
  }

  #backoff(
    failures = this.#instance.consecutiveFailures + 1,
    retryAfterSeconds?: number,
  ): number {
    return backoffDelayMs({
      intervalSeconds: this.#intervalSeconds,
      failures,
      random: this.#schedule.random,
      retryAfterSeconds,
      maxBackoffMs: this.#schedule.maxBackoffMs,
    });
  }

  #logOnce(key: CheckInResult, log: () => void): void {
    if (this.#lastLogged === key) return;
    this.#lastLogged = key;
    log();
  }

  #sleep(ms: number): Promise<void> {
    if (this.#aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const signal = this.#stopped.signal;
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      signal.addEventListener("abort", done);
    });
  }

  async #guarded(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      logger.warn("Federation member step {what} failed: {error}", {
        what,
        error: messageOf(error),
      });
    }
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }
}

function resultOf(outcome: HubOutcome<unknown>): CheckInResult {
  switch (outcome.kind) {
    case "rate_limited":
      return "rate_limited";
    case "server_error":
      return "server_error";
    case "rejected":
      return "rejected";
    case "conflict":
      return "instance_limit";
    case "unauthorized":
      return "refused";
    default:
      return "unreachable";
  }
}

function hostOf(url: string | null): string {
  if (url === null) return "an unknown hub";
  try {
    return new URL(url).host;
  } catch {
    return "an unknown hub";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** the token, trimmed; undefined when the file is missing, empty or too large */
export async function readJoinTokenFile(
  path: string,
): Promise<string | undefined> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return undefined;
  }
  try {
    const buffer = new Uint8Array(MAX_JOIN_TOKEN_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer.subarray(size));
      if (read === null) break;
      size += read;
    }
    if (size > MAX_JOIN_TOKEN_BYTES) return undefined;
    const token = new TextDecoder().decode(buffer.subarray(0, size)).trim();
    return token === "" ? undefined : token;
  } finally {
    file.close();
  }
}
