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

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { markErrorPaths } from "../../domain/errors.ts";
import { isProcessGone, processHostIdentity } from "../runtime/process.ts";
import { processRuntimeSlot } from "../runtime/process_runtime.ts";

export const DEFAULT_TICKET_TTL_MS = 10_000;
export const LOCK_QUEUES_DIR = "lock-queues";
const TICKET_SUFFIX = ".ticket";
const SEQ_DIGITS = 16;
const MAX_ENQUEUE_ATTEMPTS = 16;
/** a heartbeat on a filesystem with whole-second mtimes must still move it */
const MIN_HEARTBEAT_STEP_MS = 1_000;

const TICKET_NAME = /^(\d{16})-([0-9a-f]{8})-(\d+)-([0-9a-f]{32})\.ticket$/;

export interface WaitTicket {
  readonly seq: number;
  readonly hostIdHash: string;
  readonly pid: number;
  readonly nonce: string;
}

export function formatTicketName(ticket: WaitTicket): string {
  return `${
    String(ticket.seq).padStart(SEQ_DIGITS, "0")
  }-${ticket.hostIdHash}-${ticket.pid}-${ticket.nonce}${TICKET_SUFFIX}`;
}

export function parseTicketName(name: string): WaitTicket | null {
  const match = TICKET_NAME.exec(name);
  if (match === null) return null;
  const seq = Number(match[1]);
  const pid = Number(match[3]);
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(pid)) return null;
  return { seq, hostIdHash: match[2], pid, nonce: match[4] };
}

/** two waiters that read the queue at once take the same seq; the nonce breaks the tie */
export function compareTickets(a: WaitTicket, b: WaitTicket): number {
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  if (a.nonce === b.nonce) return 0;
  return a.nonce < b.nonce ? -1 : 1;
}

export function nextSeq(tickets: readonly WaitTicket[]): number {
  let max = 0;
  for (const ticket of tickets) max = Math.max(max, ticket.seq);
  return max + 1;
}

export interface TicketObservation {
  readonly mtimeMs: number;
  readonly firstSeenMs: number;
}

/**
 * no two clocks are compared: a ticket is stale only once its mtime has stayed
 * the same for the TTL of the observer's own monotonic time; a pid is trusted
 * only on the host that wrote it, and a reused pid falls back to the TTL
 */
export function ticketLiveness(input: {
  readonly ticket: WaitTicket;
  readonly sameHost: boolean;
  readonly processGone: (pid: number) => boolean;
  readonly mtimeMs: number;
  readonly previous: TicketObservation | undefined;
  readonly nowMs: number;
  readonly ttlMs: number;
}): { readonly dead: boolean; readonly observation: TicketObservation } {
  const observation = input.previous !== undefined &&
      input.previous.mtimeMs === input.mtimeMs
    ? input.previous
    : { mtimeMs: input.mtimeMs, firstSeenMs: input.nowMs };
  if (input.sameHost && input.processGone(input.ticket.pid)) {
    return { dead: true, observation };
  }
  return {
    dead: input.nowMs - observation.firstSeenMs >= input.ttlMs,
    observation,
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

let cachedHostIdHash: Promise<string> | undefined;

export function ownHostIdHash(): Promise<string> {
  cachedHostIdHash ??= sha256Hex(processHostIdentity()).then((hex) =>
    hex.slice(0, 8)
  );
  return cachedHostIdHash;
}

/** outside data/ and never named .lock, so no lock scan or status walk sees a ticket */
export async function lockQueueDir(
  basePath: string,
  namespace: string | undefined,
  lockKey: string,
): Promise<string> {
  const hash = (await sha256Hex(lockKey)).slice(0, 32);
  return namespace
    ? join(basePath, namespace, LOCK_QUEUES_DIR, hash)
    : join(basePath, LOCK_QUEUES_DIR, hash);
}

export interface ListedTicket {
  readonly name: string;
  readonly mtimeMs: number;
}

/** the file operations the queue goes through, and the pid probe, so tests can stand in for them */
export interface LockQueueOps {
  /** null when the queue directory does not exist */
  list(dir: string): Promise<ListedTicket[] | null>;
  ensureDir(dir: string): Promise<void>;
  /** false when a file is already at the path; NotFound when the directory is gone */
  createExclusive(path: string): Promise<boolean>;
  touch(path: string, mtime: Date): Promise<void>;
  remove(path: string): Promise<void>;
  /** fails unless the directory is empty */
  removeDir(dir: string): Promise<void>;
  processGone(pid: number): boolean;
}

export const fsLockQueueOps: LockQueueOps = {
  list: async (dir) => {
    const listed: ListedTicket[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isFile || !entry.name.endsWith(TICKET_SUFFIX)) continue;
        try {
          const stat = await Deno.stat(join(dir, entry.name));
          listed.push({
            name: entry.name,
            mtimeMs: stat.mtime?.getTime() ?? 0,
          });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
    return listed;
  },
  ensureDir: (dir) => ensureDir(dir),
  createExclusive: async (path) => {
    try {
      const file = await Deno.open(path, { createNew: true, write: true });
      file.close();
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) return false;
      throw error;
    }
  },
  touch: (path, mtime) => Deno.utime(path, mtime, mtime),
  remove: (path) => Deno.remove(path),
  removeDir: (dir) => Deno.remove(dir),
  processGone: isProcessGone,
};

const ticketTtlOverride = processRuntimeSlot<{ ttlMs?: number }>(() => ({}));

/** the ticket TTL a lock made in this runtime uses when its options set none */
export function defaultTicketTtlMs(): number {
  return ticketTtlOverride().ttlMs ?? DEFAULT_TICKET_TTL_MS;
}

/** shortens the default ticket TTL of locks made in this runtime until disposed */
export function overrideTicketTtlForTesting(ttlMs: number): Disposable {
  const state = ticketTtlOverride();
  state.ttlMs = ttlMs;
  return {
    [Symbol.dispose]: () => {
      state.ttlMs = undefined;
    },
  };
}

export type QueuePosition =
  | { readonly head: true }
  | { readonly head: false; readonly ahead: number };

/**
 * a waiter's place in one lock's queue; holding the head confers nothing, since
 * only the exclusive create of the lock file does, so a wrong or stale ticket
 * can make the order unfair but never admit two holders
 */
export class LockQueue {
  private ticket: WaitTicket | undefined;
  private ticketPath: string | undefined;
  private heartbeatId: ReturnType<typeof setInterval> | undefined;
  private lastTouchMs = 0;
  private touching: Promise<void> = Promise.resolve();
  private readonly observations = new Map<string, TicketObservation>();

  constructor(
    readonly dir: string,
    private readonly ttlMs: number = DEFAULT_TICKET_TTL_MS,
    private readonly ops: LockQueueOps = fsLockQueueOps,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async isEmpty(): Promise<boolean> {
    const listed = await this.ops.list(this.dir);
    return listed === null ||
      !listed.some((entry) => parseTicketName(entry.name) !== null);
  }

  async enqueue(): Promise<void> {
    this.stopHeartbeat();
    const hostIdHash = await ownHostIdHash();
    for (let attempt = 1;; attempt++) {
      await this.ops.ensureDir(this.dir);
      const listed = await this.ops.list(this.dir) ?? [];
      const ticket: WaitTicket = {
        seq: nextSeq(this.parsed(listed).map(({ ticket }) => ticket)),
        hostIdHash,
        pid: Deno.pid,
        nonce: crypto.randomUUID().replaceAll("-", ""),
      };
      const path = join(this.dir, formatTicketName(ticket));
      let created: boolean;
      try {
        created = await this.ops.createExclusive(path);
      } catch (error) {
        // the last waiter to leave removed the directory between our ensure and create
        if (
          error instanceof Deno.errors.NotFound &&
          attempt < MAX_ENQUEUE_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }
      if (!created) {
        if (attempt < MAX_ENQUEUE_ATTEMPTS) continue;
        throw markErrorPaths(
          new Error(`Could not enqueue a wait ticket in ${this.dir}`),
          [this.dir],
        );
      }
      this.ticket = ticket;
      this.ticketPath = path;
      this.lastTouchMs = Date.now();
      this.startHeartbeat();
      return;
    }
  }

  /** a ticket another waiter judged dead and removed goes back at the end */
  async headCheck(): Promise<QueuePosition> {
    let listed = await this.ops.list(this.dir) ?? [];
    if (!this.ownTicketIn(listed)) {
      await this.enqueue();
      listed = await this.ops.list(this.dir) ?? [];
    }
    const own = this.ticket!;
    const hostIdHash = await ownHostIdHash();
    const tickets = this.parsed(listed);
    const names = new Set(tickets.map(({ entry }) => entry.name));
    for (const name of this.observations.keys()) {
      if (!names.has(name)) this.observations.delete(name);
    }
    let ahead = 0;
    for (const { ticket, entry } of tickets) {
      if (compareTickets(ticket, own) >= 0) continue;
      const { dead, observation } = ticketLiveness({
        ticket,
        sameHost: ticket.hostIdHash === hostIdHash,
        processGone: (pid) => this.ops.processGone(pid),
        mtimeMs: entry.mtimeMs,
        previous: this.observations.get(entry.name),
        nowMs: this.now(),
        ttlMs: this.ttlMs,
      });
      this.observations.set(entry.name, observation);
      if (!dead) {
        ahead++;
        continue;
      }
      try {
        await this.ops.remove(join(this.dir, entry.name));
      } catch {
        // another waiter removed it first, or it can be removed later
      }
      this.observations.delete(entry.name);
    }
    return ahead === 0 ? { head: true } : { head: false, ahead };
  }

  /** best effort: a ticket left behind is removed as dead by the waiters behind it */
  async leave(): Promise<void> {
    this.stopHeartbeat();
    await this.touching;
    const path = this.ticketPath;
    this.ticket = undefined;
    this.ticketPath = undefined;
    this.observations.clear();
    if (path !== undefined) {
      try {
        await this.ops.remove(path);
      } catch {
        // already removed by a waiter that judged it dead
      }
    }
    try {
      await this.ops.removeDir(this.dir);
    } catch {
      // another waiter's ticket is still there, or the directory is gone
    }
  }

  private ownTicketIn(listed: readonly ListedTicket[]): boolean {
    if (this.ticketPath === undefined || this.ticket === undefined) {
      return false;
    }
    const name = formatTicketName(this.ticket);
    return listed.some((entry) => entry.name === name);
  }

  private parsed(
    listed: readonly ListedTicket[],
  ): { ticket: WaitTicket; entry: ListedTicket }[] {
    const tickets: { ticket: WaitTicket; entry: ListedTicket }[] = [];
    for (const entry of listed) {
      const ticket = parseTicketName(entry.name);
      if (ticket !== null) tickets.push({ ticket, entry });
    }
    return tickets.sort((a, b) => compareTickets(a.ticket, b.ticket));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const path = this.ticketPath!;
    this.heartbeatId = setInterval(() => {
      const mtimeMs = Math.max(
        Date.now(),
        this.lastTouchMs + MIN_HEARTBEAT_STEP_MS,
      );
      this.lastTouchMs = mtimeMs;
      this.touching = this.touching.then(() =>
        this.ops.touch(path, new Date(mtimeMs)).catch(() => {
          // non-fatal: a removed ticket is enqueued again at the next check
        })
      );
    }, Math.max(1, Math.floor(this.ttlMs / 3)));
  }

  private stopHeartbeat(): void {
    if (this.heartbeatId !== undefined) {
      clearInterval(this.heartbeatId);
      this.heartbeatId = undefined;
    }
  }
}
