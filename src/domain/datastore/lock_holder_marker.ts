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
 * The pid of the nearest swamp above a child that has taken a per-model lock:
 * a swamp sets it to its own pid once it takes one, and until then leaves the
 * value it inherited. A single pid, so a child running an older swamp, which
 * reads only this name, still skips the real lock holder's locks through a
 * swamp in between that takes none.
 */
export const SWAMP_LOCK_HOLDER_PID = "SWAMP_LOCK_HOLDER_PID";

/**
 * Every swamp process above a child, comma-separated, oldest first, ending
 * with the one that started it. A nested swamp skips the per-model locks
 * held for the run that started it, since that run holds its lock until the
 * child exits; {@link SWAMP_LOCK_HOLDER_TOKENS} says which locks those are.
 * For one of these pids that names none, it skips every lock that pid holds
 * on this host (design/enablers/datastores.md, "Parent-Process Lock
 * Awareness").
 */
export const SWAMP_LOCK_ANCESTOR_PIDS = "SWAMP_LOCK_ANCESTOR_PIDS";

/**
 * The per-model locks held for the run that started a child: comma-separated
 * `<pid>:<nonce>+<nonce>` entries, the nonces being those written to the
 * lock files. A listed nonce is the proof: the child skips the lock file
 * carrying it whichever process on whichever host holds it, so the list
 * also names locks handed over a worker dispatch or a `--server` request,
 * whose holder is not above the child. The pid matters only for a swamp
 * above the child on its host: one with an entry (an empty one when the run
 * holds none) is held to it, so the child still waits on the locks that
 * swamp holds for other runs, such as parallel steps or other `swamp serve`
 * runs, and one without is matched on the pid alone. Set per spawn, never in
 * the process env (design/enablers/datastores.md, "Parent-Process Lock
 * Awareness").
 */
export const SWAMP_LOCK_HOLDER_TOKENS = "SWAMP_LOCK_HOLDER_TOKENS";

/** The most ancestors kept in the chain; the newest are kept. */
export const MAX_LOCK_ANCESTORS = 64;

/** What a lock-file nonce may contain; anything else is dropped. */
export const LOCK_NONCE_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * The per-model locks held for a run an orchestrator dispatches to a remote
 * worker: its pid, its hostname, and the lock-file nonces of the locks it
 * holds for the run and of those handed down to it. The worker hands the
 * nonces to the dispatch runner, and declares an orchestrator on its own
 * host an ancestor of it (see {@link withRemoteLockHolder}).
 */
export interface RemoteLockHolder {
  readonly pid: number;
  readonly hostname: string;
  readonly lockIds: readonly string[];
}

/**
 * The most lock nonces a {@link RemoteLockHolder} carries, which is also the
 * dispatch schema's bound: a worker refuses a dispatch naming more, so a
 * longer list is not sent (see {@link LockHolderMarker.remoteLockHolder}).
 */
export const MAX_REMOTE_LOCK_IDS = 256;

/**
 * The longest {@link SWAMP_LOCK_HOLDER_TOKENS} value a swamp forwards to a
 * server, and the longest a server accepts (see
 * {@link LockHolderMarker.forwardedLockTokens}). The format caps the pids
 * but not the nonces listed for each; this leaves room for several hundred.
 */
export const MAX_FORWARDED_LOCK_TOKENS_LENGTH = 16_384;

/** The slice of `Deno.env` that {@link LockHolderMarker} reads and writes. */
export type LockHolderEnvStore = Pick<typeof Deno.env, "get" | "set">;

/** The owner fields a per-model lock file records. */
export interface LockOwner {
  readonly pid?: number;
  readonly hostname?: string;
  readonly nonce?: string;
}

/**
 * How a per-model lock relates to this process, as its drain sees it:
 * - `"ancestor"`: held for the run that started it, by a swamp above it or
 *   by one that handed the lock down across a worker dispatch or a
 *   `--server` request. The holder keeps it until this process exits, so
 *   the drain skips it.
 * - `"ancestor-other-run"`: held by a swamp above it, but for another run
 *   or step of that swamp, so the drain waits on it.
 * - `"other"`: held by anything else; the drain waits on it.
 */
export type LockRelation = "ancestor" | "ancestor-other-run" | "other";

interface Inherited {
  readonly holder: string | undefined;
  readonly ancestors: string | undefined;
  readonly tokens: string | undefined;
}

/**
 * Hands this process's identity down to any swamp it starts, so the nested
 * swamp's per-model lock drain skips the locks its ancestors hold instead of
 * waiting on them (design/enablers/datastores.md, "Parent-Process Lock
 * Awareness").
 *
 * Never cleared: the chain is published once at startup and the holder once
 * the process first takes a lock. A lock file carrying a pid exists only
 * while that process holds it, so keeping either for the rest of the
 * process's life is equivalent to keeping it while it holds locks, and
 * concurrent lock holders in one process (parallel workflow steps,
 * `swamp serve` runs) cannot clear it under each other. Which locks belong
 * to which run is per execution instead: {@link runHolding} scopes it, and
 * {@link childLockEnv} hands it to one spawned swamp. A run requested from
 * a server crosses no process boundary to inherit through, so the client
 * sends {@link forwardedLockTokens} and the server runs it under
 * {@link runAdopting}.
 */
export class LockHolderMarker {
  #inherited: Inherited | undefined;
  #holding = false;
  readonly #held = new AsyncLocalStorage<readonly string[]>();

  constructor(
    private readonly env: LockHolderEnvStore = Deno.env,
    private readonly pid: number = Deno.pid,
    private readonly host: () => string = hostname,
  ) {}

  /**
   * Captures what this process inherited, then publishes the ancestor chain
   * (inherited chain plus its own pid) for its children. The holder keeps its
   * inherited value until {@link markHoldingLocks}. Later calls do nothing.
   *
   * Writes the env it was built with: tests use an instance with an injected
   * store, never {@link processLockHolderMarker}, which writes the real
   * process env shared by every test file.
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
   * Records that this process holds per-model locks, so an older child (which
   * reads only the holder) skips them. Called each time locks are acquired;
   * only the first call writes, and nothing clears it.
   *
   * Does not capture what was inherited; only {@link publish} does, so a
   * process's own drain skips its parent's holder even after this runs.
   */
  markHoldingLocks(): void {
    if (this.#holding) {
      return;
    }
    this.#holding = true;
    this.env.set(SWAMP_LOCK_HOLDER_PID, String(this.pid));
  }

  /**
   * The pids whose per-model locks this process's drain skips: the swamp
   * processes above it, never itself. Before {@link publish} (an embedder or
   * a unit test) this reads the live env.
   */
  ancestorPids(): ReadonlySet<number> {
    return new Set(inheritedChain(this.#inheritedOrLive(), this.pid));
  }

  /**
   * Runs `fn` as work done under the per-model locks whose lock-file nonces
   * are `lockIds`, so a swamp started from within it (see
   * {@link childLockEnv}) skips those locks and not the ones this process
   * holds for other runs. Nests: work started inside `fn` also counts as
   * holding the outer scopes' locks, which stay held until it finishes.
   * Pass an empty list for work that holds no lock, so its children still
   * wait on every lock this process holds.
   */
  runHolding<T>(lockIds: readonly string[], fn: () => Promise<T>): Promise<T> {
    const outer = this.#held.getStore() ?? [];
    return this.#held.run([...new Set([...outer, ...lockIds])], fn);
  }

  /**
   * The lock list to send with a run requested from a server: what
   * {@link childLockEnv} would hand a child. The server can then tell the
   * run's own children about the locks held for the run that started this
   * process, which they cannot inherit through the request (see
   * {@link runAdopting}). Undefined when
   * there is nothing to send, or when the list is longer than
   * {@link MAX_FORWARDED_LOCK_TOKENS_LENGTH}: the server would refuse the
   * request, so the run goes without it.
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
   * Runs `fn`, a run a client requested, as also holding the locks named in
   * the lock list the client forwarded (see {@link forwardedLockTokens}):
   * every well-formed nonce in it, whichever pid its entry names. The holder
   * may be this process, a swamp between it and the client, or a swamp on
   * another host, so nothing here can check the client holds them. Knowing
   * a lock's nonce is the proof; design/enablers/datastores.md,
   * "Parent-Process Lock Awareness", says what that trusts. With no nonce
   * `fn` runs as called, in no new scope.
   *
   * A run that outlives the request keeps the nonces after the calling step
   * releases its lock. That is harmless: every acquisition writes a new
   * nonce, so a stale one matches no lock file. Until the step releases it,
   * though, a run the client no longer waits on still skips that lock
   * (design/enablers/datastores.md, Known limits).
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
    const outer = this.#held.getStore() ?? [];
    return this.#held.run([...new Set([...outer, ...adopted])], fn);
  }

  /**
   * The lock env for one swamp started by this process: the
   * {@link SWAMP_LOCK_HOLDER_TOKENS} entries it inherited, plus one for its
   * own pid naming the locks held by the {@link runHolding} scope it is
   * called from. Outside any scope this process adds no entry, so its child
   * matches its locks on the pid alone, as before. Empty when there is
   * nothing to hand down. Spread it into the child's env; never write it to
   * the process env, which every run in the process shares.
   *
   * An inherited entry under this process's own pid is kept, and its nonces
   * stay in the entry a scope writes: it is a lock handed down from a swamp
   * on another host that has the same pid, not a lock of this process.
   */
  childLockEnv(): Record<string, string> {
    const entries = parseTokens(this.#inheritedOrLive().tokens);
    const held = this.#held.getStore();
    if (held !== undefined) {
      const own = new Set([...(entries.get(this.pid) ?? []), ...held]);
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
   * The locks held for a run about to be dispatched to a remote worker:
   * those of the {@link runHolding} scope this is called from, and those
   * handed down to this process, which the worker's runner cannot inherit.
   * A swamp started from a shell step hands on what it inherited with every
   * dispatch it makes, for as long as it runs: the run that started it holds
   * those locks until it exits. Undefined when there are none, so nothing is
   * handed over. The list can
   * exceed {@link MAX_REMOTE_LOCK_IDS}; the caller must not send one that
   * does.
   */
  remoteLockHolder(): RemoteLockHolder | undefined {
    const lockIds = [
      ...new Set([
        ...this.inheritedLockIds(),
        ...(this.#held.getStore() ?? []),
      ]),
    ];
    if (lockIds.length === 0) {
      return undefined;
    }
    return { pid: this.pid, hostname: this.host(), lockIds };
  }

  /**
   * A test for how a lock file relates to this process (see
   * {@link LockRelation}). A lock whose nonce was handed down is held for
   * this process's run, whichever process holds it and on whichever host:
   * a nonce is written only to its lock file and to the hand-down, and a
   * lock taken again gets a new one. Any other lock is an ancestor's when
   * its pid is an ancestor's and it was taken on this host. A process on
   * another host sharing the datastore (e.g. over NFS) can carry the same
   * pid. A lock with no recorded hostname matches on pid alone. When that
   * ancestor handed down which locks it holds for this process's run, the
   * lock is held for another run. Without that list, or for a lock with no
   * nonce, the pid alone decides.
   *
   * The hostname is read when the test is built, not when the module
   * loads. If the host is renamed between an ancestor taking its lock and
   * this call (macOS can rename on a network change), an ancestor's lock
   * matched on the pid no longer matches and is waited on like any other.
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
   * The nonces of the locks handed down to this process as held for the run
   * that started it, whichever process holds them. A lock skipped on the pid
   * alone is not among them: nothing says its holder keeps it until this
   * process exits.
   */
  inheritedLockIds(): ReadonlySet<string> {
    return allNonces(parseTokens(this.#inheritedOrLive().tokens));
  }

  /**
   * What this process inherited. Before {@link publish} (an embedder or a
   * unit test) this reads the live env.
   */
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
 * The env for a dispatch runner on `host`, with `holder`'s locks handed
 * down: they go into {@link SWAMP_LOCK_HOLDER_TOKENS} under the
 * orchestrator's pid, so a swamp the dispatched step starts skips those
 * locks and no other lock the orchestrator holds. An orchestrator on `host`
 * is also declared an ancestor, its pid at the front of
 * {@link SWAMP_LOCK_ANCESTOR_PIDS}, which is what an older swamp under the
 * runner matches on. One on another host is not: its pid means nothing
 * here. Should that pid equal an ancestor's on this host that named no
 * locks, the entry holds that ancestor to this list and its locks are
 * waited on.
 *
 * Returns `env` unchanged when the holder carries no usable pid or nonce.
 * `holder` arrives over the network, so it is checked here as well as by
 * the dispatch schema; the pid is never added without its tokens entry,
 * which would match every lock the orchestrator holds.
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
  // Re-inserted last, so the cap leaves it in the env built here. The
  // runner's own entry goes after it; past the cap the chain drops this pid
  // no later than the tokens do, and the lock is then waited on.
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

/**
 * The inherited chain, seeded from the single holder when the parent
 * published no chain (an older swamp), deduplicated, without `ownPid`, and
 * capped at the newest {@link MAX_LOCK_ANCESTORS} entries.
 */
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

/**
 * Parses {@link SWAMP_LOCK_HOLDER_TOKENS}, merging repeated pids and
 * dropping malformed entries and nonces. Keeps the newest
 * {@link MAX_LOCK_ANCESTORS} pids, in order.
 */
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

/** Every nonce a parsed {@link SWAMP_LOCK_HOLDER_TOKENS} lists. */
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

/** The process-wide instance, published once by the CLI at startup. */
export const processLockHolderMarker: LockHolderMarker = new LockHolderMarker();

/**
 * Runs `fn`, a run a `--server` client requested, as also holding the locks
 * in the lock list the client forwarded, so a swamp the run starts skips the
 * locks held for the run that called in (design/enablers/datastores.md,
 * "Parent-Process Lock Awareness"). Wrap the whole request, so the run's own
 * scope and any detached launch nest under it. A step run inside it must
 * name its locks: `createStepLockHook` does.
 */
export function runAdoptingForwardedLocks<T>(
  lockHolderTokens: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return processLockHolderMarker.runAdopting(lockHolderTokens, fn);
}
