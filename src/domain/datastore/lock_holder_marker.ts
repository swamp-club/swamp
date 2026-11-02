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

import { AsyncLocalStorage } from "node:async_hooks";
import { hostname } from "node:os";

/**
 * a single pid so a child on an older swamp, which reads only this name, still
 * skips the real holder's locks through a swamp in between that takes none
 */
export const SWAMP_LOCK_HOLDER_PID = "SWAMP_LOCK_HOLDER_PID";

/**
 * every swamp above a child, oldest first; a nested swamp skips per-model locks
 * held for the run that started it, since that run holds them until the child
 * exits
 */
export const SWAMP_LOCK_ANCESTOR_PIDS = "SWAMP_LOCK_ANCESTOR_PIDS";

/**
 * locks held for the run that started a child, as <pid>:<nonce>+<nonce>
 * entries; a listed nonce is proof, so the child skips that lock whoever holds
 * it. Set per spawn, never in the process env
 */
export const SWAMP_LOCK_HOLDER_TOKENS = "SWAMP_LOCK_HOLDER_TOKENS";

export const MAX_LOCK_ANCESTORS = 64;

export const MAX_LOCK_NONCE_LENGTH = 128;

/**
 * bounded at the dispatch schema's own limit so a nonce that parses here never
 * makes a worker refuse a dispatch
 */
export const LOCK_NONCE_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export interface RemoteLockHolder {
  readonly pid: number;
  readonly hostname: string;
  readonly lockIds: readonly string[];
}

/**
 * the dispatch schema's bound: a worker refuses a dispatch naming more, so a
 * longer list is not sent
 */
export const MAX_REMOTE_LOCK_IDS = 256;

export const MAX_FORWARDED_LOCK_TOKENS_LENGTH = 16_384;

export type LockHolderEnvStore = Pick<typeof Deno.env, "get" | "set">;

export interface LockOwner {
  readonly pid?: number;
  readonly hostname?: string;
  readonly nonce?: string;
}

/**
 * ancestor: held for the run that started this process, so skipped;
 * ancestor-other-run: held by a swamp above for another run, so waited on;
 * other: waited on
 */
export type LockRelation = "ancestor" | "ancestor-other-run" | "other";

export interface LentLocks {
  lockIds(): readonly string[];
  /**
   * re-keys each lock so a swamp left over from an ended hop stops matching,
   * and waits for a structural command under a retired nonce; rejects on
   * timeout or abort, and the run must then write nothing
   */
  reclaim(signal?: AbortSignal): Promise<void>;
}

/**
 * await end when the hop returns, before the run writes anything; pass the
 * run's signal for a cancelled hop so it re-keys and rejects, but end a
 * finished hop with no signal and wait
 */
export interface LockHandOff<T> {
  readonly lent: T;
  end(signal?: AbortSignal): Promise<void>;
}

export interface RemoteHandOffSource {
  holder(): RemoteLockHolder | undefined;
  begin(): Promise<LockHandOff<RemoteLockHolder | undefined>>;
}

interface HeldScope {
  readonly parent: HeldScope | undefined;
  readonly lent: LentLocks | undefined;
  readonly fixed: readonly string[];
  live: number;
  reclaiming: Promise<void> | undefined;
}

function scopeChain(scope: HeldScope | undefined): HeldScope[] {
  const chain: HeldScope[] = [];
  for (let at = scope; at !== undefined; at = at.parent) chain.push(at);
  return chain;
}

function heldIn(scope: HeldScope | undefined): string[] {
  const ids = new Set<string>();
  for (const at of scopeChain(scope).reverse()) {
    for (const id of at.fixed) ids.add(id);
    for (const id of at.lent?.lockIds() ?? []) ids.add(id);
  }
  return [...ids];
}

interface Inherited {
  readonly holder: string | undefined;
  readonly ancestors: string | undefined;
  readonly tokens: string | undefined;
}

/**
 * never cleared: a lock file carrying a pid exists only while that process
 * holds it, and concurrent holders in one process cannot clear it under each
 * other; per-run ownership is scoped by runHolding
 */
export class LockHolderMarker {
  #inherited: Inherited | undefined;
  #holding = false;
  readonly #held = new AsyncLocalStorage<HeldScope>();

  constructor(
    private readonly env: LockHolderEnvStore = Deno.env,
    private readonly pid: number = Deno.pid,
    private readonly host: () => string = hostname,
  ) {}

  /**
   * tests use an instance with an injected store, never
   * processLockHolderMarker, which writes the real process env shared by every
   * test file
   */
  publish(): void {
    if (this.#inherited) {
      return;
    }
    const inherited = this.#readEnv();
    // Captured before writing, so this process's drain still skips the
    // locks its ancestors hold.
    this.#inherited = inherited;
    const chain = [...inheritedChain(inherited, this.pid), this.pid]
      .slice(-MAX_LOCK_ANCESTORS);
    this.env.set(SWAMP_LOCK_ANCESTOR_PIDS, chain.join(","));
  }

  /**
   * does not capture what was inherited; only publish does, so a process's own
   * drain still skips its parent's holder after this runs
   */
  markHoldingLocks(): void {
    if (this.#holding) {
      return;
    }
    this.#holding = true;
    this.env.set(SWAMP_LOCK_HOLDER_PID, String(this.pid));
  }

  ancestorPids(): ReadonlySet<number> {
    return new Set(inheritedChain(this.#inheritedOrLive(), this.pid));
  }

  /**
   * nests, outer locks stay held until fn finishes; pass an empty list for work
   * holding no lock so its children still wait on every lock this process holds
   */
  runHolding<T>(
    locks: readonly string[] | LentLocks,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lent = "reclaim" in locks ? locks : undefined;
    return this.#held.run({
      parent: this.#held.getStore(),
      lent,
      fixed: lent ? [] : [...(locks as readonly string[])],
      live: 0,
      reclaiming: undefined,
    }, fn);
  }

  /**
   * first waits for a reclaim in progress on this scope or one around it, so
   * the child is never given a nonce about to be retired; rejects if that
   * reclaim failed
   */
  async beginChildHandOff(): Promise<LockHandOff<Record<string, string>>> {
    const scope = this.#held.getStore();
    const end = await this.#begin(scope);
    return { lent: this.#childLockEnv(scope), end };
  }

  remoteHandOff(): RemoteHandOffSource {
    const scope = this.#held.getStore();
    return {
      holder: () => this.#remoteLockHolder(scope),
      begin: async () => {
        const end = await this.#begin(scope);
        return { lent: this.#remoteLockHolder(scope), end };
      },
    };
  }

  /**
   * a scope reclaims only its own run's locks when its count returns to zero,
   * so none is re-keyed under a live hop; the end signal reaches only its own
   * scope's reclaim, as outer runs may still write
   */
  async #begin(
    scope: HeldScope | undefined,
  ): Promise<(signal?: AbortSignal) => Promise<void>> {
    const scopes = scopeChain(scope);
    while (true) {
      const reclaims = scopes.flatMap((at) =>
        at.reclaiming ? [at.reclaiming] : []
      );
      if (reclaims.length === 0) break;
      await Promise.all(reclaims);
    }
    for (const at of scopes) at.live++;
    let ended = false;
    return async (signal) => {
      if (ended) return;
      ended = true;
      const reclaims: Promise<void>[] = [];
      for (const at of scopes) {
        at.live--;
        if (at.live > 0 || at.lent === undefined) continue;
        const reclaim = at.lent.reclaim(
          at === scope ? signal : undefined,
        ).finally(() => {
          if (at.reclaiming === reclaim) at.reclaiming = undefined;
        });
        at.reclaiming = reclaim;
        reclaims.push(reclaim);
      }
      const failed = (await Promise.allSettled(reclaims))
        .find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    };
  }

  /**
   * undefined when there is nothing to send or the list is over the cap: the
   * server would refuse the request, so the run goes without it
   */
  forwardedLockTokens(): string | undefined {
    const value = this.childLockEnv()[SWAMP_LOCK_HOLDER_TOKENS];
    if (
      value === undefined || value.length > MAX_FORWARDED_LOCK_TOKENS_LENGTH
    ) {
      return undefined;
    }
    return value;
  }

  /**
   * knowing a lock's nonce is the proof, since the holder cannot be checked;
   * adopted nonces are never re-keyed here, and a stale one matches no lock
   * file because a re-key or new acquisition writes a new nonce
   */
  runAdopting<T>(
    forwarded: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (
      forwarded === undefined ||
      forwarded.length > MAX_FORWARDED_LOCK_TOKENS_LENGTH
    ) {
      return fn();
    }
    const adopted = [...allNonces(parseTokens(forwarded))];
    if (adopted.length === 0) {
      return fn();
    }
    return this.#held.run({
      parent: this.#held.getStore(),
      lent: undefined,
      fixed: adopted,
      live: 0,
      reclaiming: undefined,
    }, fn);
  }

  /**
   * spread it into the child's env; never write it to the process env, which
   * every run in the process shares
   */
  childLockEnv(): Record<string, string> {
    return this.#childLockEnv(this.#held.getStore());
  }

  #childLockEnv(scope: HeldScope | undefined): Record<string, string> {
    const entries = parseTokens(this.#inheritedOrLive().tokens);
    if (scope !== undefined) {
      const own = new Set([
        ...(entries.get(this.pid) ?? []),
        ...heldIn(scope),
      ]);
      // Re-inserted so this process's entry is the newest.
      entries.delete(this.pid);
      entries.set(this.pid, own);
    }
    if (entries.size === 0) {
      return {};
    }
    return { [SWAMP_LOCK_HOLDER_TOKENS]: formatTokens(entries) };
  }

  /**
   * the list can exceed MAX_REMOTE_LOCK_IDS; the caller must not send one that
   * does
   */
  remoteLockHolder(): RemoteLockHolder | undefined {
    return this.#remoteLockHolder(this.#held.getStore());
  }

  #remoteLockHolder(
    scope: HeldScope | undefined,
  ): RemoteLockHolder | undefined {
    const lockIds = [
      ...new Set([...this.inheritedLockIds(), ...heldIn(scope)]),
    ];
    if (lockIds.length === 0) {
      return undefined;
    }
    return { pid: this.pid, hostname: this.host(), lockIds };
  }

  /**
   * a handed-down nonce means held for this run, any holder; otherwise an
   * ancestor's lock needs a matching pid taken on this host, since another host
   * sharing the datastore can reuse a pid
   */
  lockRelation(): (lock: LockOwner) => LockRelation {
    const inherited = this.#inheritedOrLive();
    const pids = new Set(inheritedChain(inherited, this.pid));
    const tokens = parseTokens(inherited.tokens);
    const handedDown = allNonces(tokens);
    const host = this.host();
    return (lock) => {
      if (lock.nonce !== undefined && handedDown.has(lock.nonce)) {
        return "ancestor";
      }
      if (
        lock.pid === undefined || !pids.has(lock.pid) ||
        (lock.hostname !== undefined && lock.hostname !== host)
      ) {
        return "other";
      }
      const listed = tokens.get(lock.pid);
      if (listed === undefined || lock.nonce === undefined) {
        return "ancestor";
      }
      return "ancestor-other-run";
    };
  }

  /**
   * a lock skipped on pid alone is not among them: nothing says its holder
   * keeps it until this process exits
   */
  inheritedLockIds(): ReadonlySet<string> {
    return allNonces(parseTokens(this.#inheritedOrLive().tokens));
  }

  #inheritedOrLive(): Inherited {
    return this.#inherited ?? this.#readEnv();
  }

  #readEnv(): Inherited {
    return {
      holder: this.env.get(SWAMP_LOCK_HOLDER_PID),
      ancestors: this.env.get(SWAMP_LOCK_ANCESTOR_PIDS),
      tokens: this.env.get(SWAMP_LOCK_HOLDER_TOKENS),
    };
  }
}

/**
 * holder arrives over the network so it is checked here as well as by the
 * dispatch schema; the pid is never added without its tokens entry, which would
 * match every lock the orchestrator holds
 */
export function withRemoteLockHolder(
  env: Record<string, string>,
  holder: RemoteLockHolder | undefined,
  host: string,
): Record<string, string> {
  if (holder === undefined) {
    return env;
  }
  const pid = parsePid(String(holder.pid));
  const nonces = holder.lockIds.filter((id) => LOCK_NONCE_PATTERN.test(id));
  if (pid === undefined || nonces.length === 0) {
    return env;
  }
  const tokens = parseTokens(env[SWAMP_LOCK_HOLDER_TOKENS]);
  const listed = tokens.get(pid) ?? new Set<string>();
  for (const nonce of nonces) {
    listed.add(nonce);
  }
  // re-inserted last so the cap leaves it in the env; past the cap the chain
  // drops this pid no later than the tokens do, and the lock is then waited on
  tokens.delete(pid);
  tokens.set(pid, listed);
  if (holder.hostname !== host) {
    return { ...env, [SWAMP_LOCK_HOLDER_TOKENS]: formatTokens(tokens) };
  }
  const chain = (env[SWAMP_LOCK_ANCESTOR_PIDS] ?? "").split(",")
    .map(parsePid)
    .filter((entry): entry is number => entry !== undefined && entry !== pid);
  return {
    ...env,
    [SWAMP_LOCK_ANCESTOR_PIDS]: [pid, ...chain.slice(-(MAX_LOCK_ANCESTORS - 1))]
      .join(","),
    [SWAMP_LOCK_HOLDER_TOKENS]: formatTokens(tokens),
  };
}

function inheritedChain(inherited: Inherited, ownPid: number): number[] {
  const chain: number[] = [];
  const seen = new Set<number>([ownPid]);
  const raw = (inherited.ancestors ?? "").split(",")
    .slice(-MAX_LOCK_ANCESTORS);
  raw.push(inherited.holder ?? "");
  for (const entry of raw) {
    const pid = parsePid(entry);
    if (pid !== undefined && !seen.has(pid)) {
      seen.add(pid);
      chain.push(pid);
    }
  }
  return chain.slice(-MAX_LOCK_ANCESTORS);
}

function parseTokens(value: string | undefined): Map<number, Set<string>> {
  const entries = new Map<number, Set<string>>();
  for (const entry of (value ?? "").split(",")) {
    const separator = entry.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const pid = parsePid(entry.slice(0, separator));
    if (pid === undefined) {
      continue;
    }
    const nonces = entries.get(pid) ?? new Set<string>();
    for (const nonce of entry.slice(separator + 1).split("+")) {
      if (LOCK_NONCE_PATTERN.test(nonce)) {
        nonces.add(nonce);
      }
    }
    // Re-inserted so a repeated pid counts as its newest position.
    entries.delete(pid);
    entries.set(pid, nonces);
  }
  return new Map([...entries].slice(-MAX_LOCK_ANCESTORS));
}

function allNonces(entries: Map<number, Set<string>>): Set<string> {
  const nonces = new Set<string>();
  for (const listed of entries.values()) {
    for (const nonce of listed) nonces.add(nonce);
  }
  return nonces;
}

function formatTokens(entries: Map<number, Set<string>>): string {
  return [...entries].slice(-MAX_LOCK_ANCESTORS)
    .map(([pid, nonces]) => `${pid}:${[...nonces].join("+")}`)
    .join(",");
}

function parsePid(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    return undefined;
  }
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

export const processLockHolderMarker: LockHolderMarker = new LockHolderMarker();

/**
 * wrap the whole request so the run's own scope and any detached launch nest
 * under it; a step run inside it must name its locks, as createStepLockHook
 * does
 */
export function runAdoptingForwardedLocks<T>(
  lockHolderTokens: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return processLockHolderMarker.runAdopting(lockHolderTokens, fn);
}
