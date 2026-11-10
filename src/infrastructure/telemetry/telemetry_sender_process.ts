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

import { dirname, fromFileUrl, join } from "@std/path";
import type {
  TelemetryService,
} from "../../domain/telemetry/telemetry_service.ts";
import type { TelemetrySender } from "../../domain/telemetry/telemetry_sender.ts";

export const TELEMETRY_SENDER_MARKER = "__swamp_telemetry_sender";
export const SENDER_LOCK_FILE = "sender.lock";
/** a sender heartbeats after every batch, each bounded by its request timeout */
export const SENDER_LOCK_STALE_MS = 60_000;
export const SENDER_REQUEST_TIMEOUT_MS = 10_000;
export const SENDER_MAX_BATCHES = 400;
/** a burst of commands shares one sender: it waits this long for more entries */
export const SENDER_LINGER_MS = 30_000;
export const SENDER_POLL_MS = 1_000;
/** steady activity keeps resetting the linger, so a sender's life is capped */
export const SENDER_MAX_LIFETIME_MS = 300_000;
// the repo id may come from an evaluated expression, so it stays off argv
export const SENDER_REPO_ID_ENV = "SWAMP_TELEMETRY_SENDER_REPO_ID";

export function isTelemetrySenderInvocation(args: readonly string[]): boolean {
  return args[0] === TELEMETRY_SENDER_MARKER;
}

export interface SenderOptions {
  readonly endpoint: string;
  readonly userAgent: string;
  readonly repoId?: string;
  readonly keepFlushed: boolean;
}

export function senderArgs(token: string, options: SenderOptions): string[] {
  return [
    TELEMETRY_SENDER_MARKER,
    "--lock-token",
    token,
    "--endpoint",
    options.endpoint,
    "--user-agent",
    options.userAgent,
    ...(options.keepFlushed ? ["--keep-flushed"] : []),
  ];
}

export function parseSenderArgs(
  args: readonly string[],
  repoId: string | undefined = Deno.env.get(SENDER_REPO_ID_ENV),
): (SenderOptions & { readonly token: string }) | undefined {
  if (!isTelemetrySenderInvocation(args)) return undefined;
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    return at > 0 && at + 1 < args.length ? args[at + 1] : undefined;
  };
  const token = value("--lock-token");
  const endpoint = value("--endpoint");
  const userAgent = value("--user-agent");
  if (!token || !endpoint || !userAgent) return undefined;
  return {
    token,
    endpoint,
    userAgent,
    ...(repoId !== undefined ? { repoId } : {}),
    keepFlushed: args.includes("--keep-flushed"),
  };
}

export interface SenderCommand {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

/** the compiled binary runs itself; from source, deno runs the entry module */
export function hostSenderCommand(
  execPath: string = Deno.execPath(),
): SenderCommand {
  if (!/[\\/]deno(\.exe)?$/i.test(execPath)) {
    return { command: execPath, prefixArgs: [] };
  }
  const entry = fromFileUrl(
    new URL("./telemetry_sender_entry.ts", import.meta.url),
  );
  const config = join(dirname(entry), "..", "..", "..", "deno.json");
  return {
    command: execPath,
    prefixArgs: ["run", "-A", "--config", config, entry],
  };
}

export function launchDetached(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
): void {
  const child = new Deno.Command(command, {
    args: [...args],
    env,
    stdin: "null",
    stdout: "null",
    stderr: "null",
    // it outlives the command that started it
    detached: true,
  }).spawn();
  child.unref();
  // Nothing waits on it; its status is never read.
  child.status.catch(() => {});
}

async function writeNew(path: string, token: string): Promise<void> {
  await Deno.writeTextFile(path, token, { createNew: true });
}

/**
 * the token when this caller now holds the lock; undefined while a live sender
 * holds it. A lock not touched for SENDER_LOCK_STALE_MS was left by a sender
 * that died, and is taken over
 */
export async function claimSenderLock(
  lockPath: string,
  now: () => number = Date.now,
): Promise<string | undefined> {
  const token = crypto.randomUUID();
  await Deno.mkdir(dirname(lockPath), { recursive: true });
  try {
    await writeNew(lockPath, token);
    return token;
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  let mtime: number | undefined;
  try {
    mtime = (await Deno.stat(lockPath)).mtime?.getTime();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (mtime !== undefined && now() - mtime < SENDER_LOCK_STALE_MS) {
    return undefined;
  }
  // Two takers can race here and both send; the ingest dedupes on insert_id.
  const aside = `${lockPath}.stale-${token}`;
  try {
    await Deno.rename(lockPath, aside);
    await Deno.remove(aside).catch(() => {});
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  try {
    await writeNew(lockPath, token);
    return token;
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) return undefined;
    throw error;
  }
}

/** touches the lock while it still names token; false once another holds it */
export async function heartbeatSenderLock(
  lockPath: string,
  token: string,
  now: () => number = Date.now,
): Promise<boolean> {
  try {
    if ((await Deno.readTextFile(lockPath)) !== token) return false;
    const at = new Date(now());
    await Deno.utime(lockPath, at, at);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function releaseSenderLock(
  lockPath: string,
  token: string,
): Promise<void> {
  try {
    if ((await Deno.readTextFile(lockPath)) !== token) return;
    await Deno.remove(lockPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export interface StartSenderDeps {
  readonly launch?: (
    command: string,
    args: readonly string[],
    env: Record<string, string>,
  ) => void;
  readonly command?: SenderCommand;
  readonly now?: () => number;
}

/**
 * starts a detached sender unless one holds the lock; never waits on a send.
 * Resolves true when a sender was started
 */
export async function startTelemetrySender(
  telemetryDir: string,
  options: SenderOptions,
  deps: StartSenderDeps = {},
): Promise<boolean> {
  const lockPath = join(telemetryDir, SENDER_LOCK_FILE);
  const token = await claimSenderLock(lockPath, deps.now);
  if (token === undefined) return false;
  const command = deps.command ?? hostSenderCommand();
  try {
    (deps.launch ?? launchDetached)(
      command.command,
      [...command.prefixArgs, ...senderArgs(token, options)],
      options.repoId !== undefined
        ? { [SENDER_REPO_ID_ENV]: options.repoId }
        : {},
    );
    return true;
  } catch (error) {
    await releaseSenderLock(lockPath, token);
    throw error;
  }
}

export interface DrainOptions {
  readonly service: TelemetryService;
  readonly sender: TelemetrySender;
  readonly distinctId: string;
  readonly repoId?: string;
  readonly authToken?: string;
  readonly keepFlushed: boolean;
  /** false stops the drain: another sender took the lock */
  readonly heartbeat: () => Promise<boolean>;
  readonly requestTimeoutMs?: number;
  readonly maxBatches?: number;
  /** sent but not marked; carried across drains so none is sent twice */
  readonly skipIds?: Set<string>;
}

/** sends the spool batch by batch until it is empty or a send fails */
export async function drainTelemetrySpool(
  options: DrainOptions,
): Promise<{ readonly sent: number; readonly ok: boolean }> {
  const skipIds = options.skipIds ?? new Set<string>();
  let sent = 0;
  const maxBatches = options.maxBatches ?? SENDER_MAX_BATCHES;
  for (let batch = 0; batch < maxBatches; batch++) {
    if (!await options.heartbeat()) break;
    const outcome = await options.service.flushTelemetry({
      sender: options.sender,
      distinctId: options.distinctId,
      ...(options.repoId !== undefined ? { repoId: options.repoId } : {}),
      ...(options.authToken !== undefined
        ? { authToken: options.authToken }
        : {}),
      keepFlushed: options.keepFlushed,
      signal: AbortSignal.timeout(
        options.requestTimeoutMs ?? SENDER_REQUEST_TIMEOUT_MS,
      ),
      skipIds,
    });
    // sent but not marked: never sent again by this drain
    for (const id of outcome.unmarkedIds) skipIds.add(id);
    if (!outcome.result.ok) return { sent, ok: false };
    if (outcome.sentCount === 0) break;
    sent += outcome.sentCount;
  }
  return { sent, ok: true };
}

export interface LingerOptions extends DrainOptions {
  readonly lingerMs?: number;
  readonly pollMs?: number;
  readonly maxLifetimeMs?: number;
  /** read before each drain, so a login or logout during the linger applies */
  readonly readAuthToken?: () => Promise<string | undefined>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * drains the spool, then lingers for later commands' entries; a failed send
 * holds the lock for a linger without sending, so commands start no new sender
 */
export async function drainAndLinger(options: LingerOptions): Promise<void> {
  const skipIds = options.skipIds ?? new Set<string>();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const lingerMs = options.lingerMs ?? SENDER_LINGER_MS;
  const pollMs = options.pollMs ?? SENDER_POLL_MS;
  const maxLifetimeMs = options.maxLifetimeMs ?? SENDER_MAX_LIFETIME_MS;
  const drain = async () => {
    const { authToken: _startToken, ...rest } = options;
    const authToken = options.readAuthToken
      ? await options.readAuthToken()
      : options.authToken;
    return await drainTelemetrySpool({
      ...rest,
      ...(authToken !== undefined ? { authToken } : {}),
      skipIds,
    });
  };
  const startedAt = now();
  const lingering = (since: number) =>
    now() - since < lingerMs && now() - startedAt < maxLifetimeMs;
  const hold = async () => {
    const failedAt = now();
    while (lingering(failedAt)) {
      await sleep(pollMs);
      if (!await options.heartbeat()) return;
    }
  };
  if (!(await drain()).ok) return await hold();
  let idleSince = now();
  while (lingering(idleSince)) {
    await sleep(pollMs);
    if (!await options.heartbeat()) return;
    const outcome = await drain();
    if (!outcome.ok) return await hold();
    if (outcome.sent > 0) idleSince = now();
  }
}
