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

import type { ServerCredentialRepository } from "../domain/auth/server_credential.ts";
import { normalizeServerUrl } from "../domain/auth/server_url.ts";
import { resolveExtraHeaders } from "../domain/auth/extra_headers.ts";
import type { DatastoreEngine } from "../domain/datastore/datastore_format.ts";
import { ServeUpstreamTarget } from "../domain/datastore_v3/serve_upstream.ts";
import { FileServerCredentialRepository } from "../infrastructure/persistence/server_credential_repository.ts";
import {
  getEnvCaCerts,
  implicitServeUrl,
  readTokenFile,
} from "./remote_run.ts";

/** Whether serve is a command's datastore upstream, and why. */
/** The words of the command this process runs, as typed: set at startup. */
let currentCommandPath: readonly string[] = [];

/**
 * Records the command words `runInvocation` parsed, for
 * {@link resolveServeUpstream}'s callers in the repo context, which are
 * reached from inside each command's action.
 */
export function setServeUpstreamCommandPath(path: readonly string[]): void {
  currentCommandPath = [...path];
}

/** The command words recorded at startup; empty in-process (tests, serve). */
export function serveUpstreamCommandPath(): readonly string[] {
  return currentCommandPath;
}

/** Test seam: forgets the recorded command words. */
export function resetServeUpstreamCommandPath(): void {
  currentCommandPath = [];
}

export interface ServeUpstreamDecision {
  readonly applies: boolean;
  readonly reason: string;
}

/**
 * A top-level command family's answer. With `subcommands`, the family's own
 * `applies` is the answer for the bare group and for any subcommand the map
 * does not list; the rules test requires every registered subcommand to be
 * listed, so that default only covers the group's own help output.
 */
export interface ServeUpstreamFamilyRule extends ServeUpstreamDecision {
  readonly subcommands?: Readonly<Record<string, ServeUpstreamDecision>>;
}

const APPLIES = "reads or writes the repository like any other command";
const NO_REPO = "opens no repository; the answer is moot";

/**
 * The one table that says which commands use serve as their v3 datastore
 * upstream when the checkout has a serve address. Keyed by the top-level
 * word as typed, so aliases (`behaviour`, `summarize`) have their own rows.
 * `integration/serve_upstream_rules_test.ts` fails when a registered
 * top-level command, alias, or `datastore` subcommand has no row here.
 *
 * Excluded commands bind the datastore's storage directly, as they do
 * without a serve address.
 */
/**
 * The command families that, in a v3 checkout written through serve, run
 * locally with serve as their datastore's upstream even though they also
 * have a `--server` flag (swamp-club#3985): the data plane, whose records
 * the datastore holds. An address from the environment or `.swamp.yaml`
 * no longer sends them to serve over its WebSocket API; an explicit
 * `--server` still does. The control plane (`access`, `audit`, `doctor`,
 * `datastore`, …) keeps that routing: it administers serve itself.
 */
export const SERVE_UPSTREAM_LOCAL_FAMILIES: ReadonlySet<string> = new Set([
  "behavior",
  "behaviour",
  "data",
  "model",
  "report",
  "summarise",
  "summarize",
  "vault",
  "workflow",
]);

/**
 * Whether the command at `commandPath` runs locally with serve as its v3
 * datastore's upstream rather than on serve: a data-plane family that
 * serve mode applies to.
 */
export function serveUpstreamRunsLocally(
  commandPath: readonly string[],
): boolean {
  const [command] = commandPath;
  return command !== undefined &&
    SERVE_UPSTREAM_LOCAL_FAMILIES.has(command) &&
    serveUpstreamAppliesTo(commandPath);
}

export const SERVE_UPSTREAM_COMMANDS: Readonly<
  Record<string, ServeUpstreamFamilyRule>
> = {
  // --- excluded ---
  serve: {
    applies: false,
    reason: "serve is the upstream; it owns the storage binding itself",
  },
  worker: {
    applies: false,
    reason:
      "workers run steps for serve and reach it over their own connection",
  },
  init: {
    applies: false,
    reason: "creates the repository and binds its datastore",
  },
  repo: {
    applies: false,
    reason: "init and upgrade create or rewrite the repository's binding",
  },
  datastore: {
    applies: false,
    reason: "datastore commands bind the storage on purpose",
    subcommands: {
      type: {
        applies: true,
        reason: "searches the datastore type registry; opens no storage",
      },
      status: {
        applies: false,
        reason: "reports the bound storage's health and configuration",
      },
      setup: {
        applies: false,
        reason: "creates or rebinds the datastore itself",
      },
      sync: {
        applies: false,
        reason: "pulls and pushes against the storage explicitly",
      },
      lock: {
        applies: false,
        reason: "inspects and force-releases the storage's writer lock",
      },
      compact: {
        applies: false,
        reason: "checkpoints and vacuums the storage's own databases",
      },
      gc: {
        applies: false,
        reason: "deletes unreferenced chunks from the storage",
      },
      "migrate-index": {
        applies: false,
        reason: "migrates the storage's index format",
      },
      catalog: {
        applies: false,
        reason: "pulls catalog metadata from other namespaces in the storage",
      },
      namespace: {
        applies: false,
        reason: "sets, lists and migrates the storage's namespace layout",
      },
      config: {
        applies: false,
        reason: "migrates configuration into the storage's config tier",
      },
    },
  },
  doctor: {
    applies: true,
    reason: APPLIES,
    subcommands: {
      audit: { applies: true, reason: APPLIES },
      datastores: {
        applies: false,
        reason: "diagnoses and repairs the bound storage and checkout",
      },
      extensions: { applies: true, reason: APPLIES },
      install: { applies: true, reason: NO_REPO },
      secrets: { applies: true, reason: APPLIES },
      vaults: { applies: true, reason: APPLIES },
      workflows: { applies: true, reason: APPLIES },
    },
  },
  // --- applies ---
  access: { applies: true, reason: APPLIES },
  agent: { applies: true, reason: APPLIES },
  audit: { applies: true, reason: APPLIES },
  auth: { applies: true, reason: NO_REPO },
  behavior: { applies: true, reason: APPLIES },
  behaviour: { applies: true, reason: APPLIES },
  completions: { applies: true, reason: NO_REPO },
  config: { applies: true, reason: NO_REPO },
  dashboard: { applies: true, reason: APPLIES },
  data: { applies: true, reason: APPLIES },
  extension: { applies: true, reason: APPLIES },
  "first-rule": { applies: true, reason: NO_REPO },
  help: { applies: true, reason: NO_REPO },
  inbox: { applies: true, reason: NO_REPO },
  invite: { applies: true, reason: NO_REPO },
  issue: { applies: true, reason: NO_REPO },
  model: { applies: true, reason: APPLIES },
  quest: { applies: true, reason: NO_REPO },
  report: { applies: true, reason: APPLIES },
  run: { applies: true, reason: APPLIES },
  source: { applies: true, reason: NO_REPO },
  start: { applies: true, reason: NO_REPO },
  subscription: { applies: true, reason: NO_REPO },
  summarise: { applies: true, reason: APPLIES },
  summarize: { applies: true, reason: APPLIES },
  telemetry: { applies: true, reason: NO_REPO },
  update: { applies: true, reason: NO_REPO },
  vault: { applies: true, reason: APPLIES },
  version: { applies: true, reason: NO_REPO },
  workflow: { applies: true, reason: APPLIES },
  workspace: { applies: true, reason: NO_REPO },
};

/**
 * Whether the command at `commandPath` uses serve as its v3 datastore
 * upstream. `commandPath` is the command words as typed: the top-level
 * command and, when there is one, its subcommand (what
 * `extractCommandInfo` returns as `command` and `subcommand`); words past
 * the second are ignored. An empty path or a word the table does not know
 * answers false, which keeps today's direct storage binding.
 */
export function serveUpstreamAppliesTo(
  commandPath: readonly string[],
): boolean {
  const [command, subcommand] = commandPath;
  if (
    command === undefined || !Object.hasOwn(SERVE_UPSTREAM_COMMANDS, command)
  ) {
    return false;
  }
  const family = SERVE_UPSTREAM_COMMANDS[command];
  if (
    subcommand !== undefined && family.subcommands !== undefined &&
    Object.hasOwn(family.subcommands, subcommand)
  ) {
    return family.subcommands[subcommand].applies;
  }
  return family.applies;
}

/** What {@link resolveServeUpstream} takes. */
export interface ResolveServeUpstreamOptions {
  /** The engine the datastore's format marker chose. */
  engine: DatastoreEngine;
  /** The invocation's command words; see {@link serveUpstreamAppliesTo}. */
  commandPath: readonly string[];
  /**
   * The repository marker's serverAddress, when the caller has it. Without
   * it, the address cached from the marker at startup is used.
   */
  markerServerAddress?: string;
  /** Test seam; defaults to the servers.json repository. */
  credentialRepository?: ServerCredentialRepository;
  /** Test seam; defaults to `SWAMP_CA_CERT` (see `getEnvCaCerts`). */
  getCaCerts?: () => readonly string[] | undefined;
}

/**
 * The serve this invocation uses as its v3 datastore upstream, or
 * `undefined` when there is none: the engine is not v3, the command binds
 * storage on purpose (see {@link SERVE_UPSTREAM_COMMANDS}), or no serve
 * address is configured (`SWAMP_SERVE_URL`, `SWAMP_SERVER_URL`, the
 * marker's serverAddress).
 *
 * The token comes only from sources bound to the address, so a token meant
 * for one server is never sent to another:
 *
 * 1. `SWAMP_SERVER_TOKEN_FILE`, only when `SWAMP_SERVE_URL` or
 *    `SWAMP_SERVER_URL` is set and normalizes to the resolved address.
 *    A marker-only address never reads it.
 * 2. The credential repository: `SWAMP_SERVER_TOKEN` when
 *    `SWAMP_SERVER_URL` normalizes to the address, else the stored
 *    credential for the address in servers.json.
 *
 * No token is not an error: a serve with `--auth-mode none` needs none,
 * and one that does answers 401, which carries the login hint.
 *
 * @throws {UserError} when the address is not a valid http(s) or ws(s) URL,
 *   or a bound token file cannot be read.
 */
export async function resolveServeUpstream(
  opts: ResolveServeUpstreamOptions,
): Promise<ServeUpstreamTarget | undefined> {
  if (opts.engine !== "v3") return undefined;
  if (!serveUpstreamAppliesTo(opts.commandPath)) return undefined;

  const address = implicitServeUrl(opts.markerServerAddress);
  if (address === undefined || address === "") return undefined;

  // Validates and normalizes the address before any credential lookup, so
  // an invalid one fails without its value echoed.
  const addressOnly = ServeUpstreamTarget.create({ serverUrl: address });
  const key = addressOnly.serverUrl;

  let token = await boundTokenFileToken(key);
  if (token === undefined) {
    const repo = opts.credentialRepository ??
      new FileServerCredentialRepository();
    const credential = await repo.get(key);
    token = credential?.token || undefined;
  }

  const caCerts = (opts.getCaCerts ?? getEnvCaCerts)();

  return ServeUpstreamTarget.create({
    serverUrl: key,
    token,
    caCerts,
    extraHeaders: resolveExtraHeaders(),
  });
}

/**
 * Whether `SWAMP_SERVER_TOKEN_FILE` is bound to `key`: one of the
 * environment addresses (`SWAMP_SERVE_URL`, `SWAMP_SERVER_URL`) normalizes
 * to it. An unset, empty or unparseable environment address names nothing,
 * so a marker-only address is never bound.
 *
 * Today `implicitServeUrl` prefers the environment over the marker, so a set
 * environment address is the resolved one; this check keeps the token
 * file bound if that precedence ever changes.
 */
export function tokenFileBoundTo(
  key: string,
  envAddresses: readonly (string | undefined)[],
): boolean {
  return envAddresses.some((value) => {
    if (!value) return false;
    try {
      return normalizeServerUrl(value) === key;
    } catch {
      return false;
    }
  });
}

/** The `SWAMP_SERVER_TOKEN_FILE` token when it is bound to `key`. */
async function boundTokenFileToken(key: string): Promise<string | undefined> {
  const tokenFile = Deno.env.get("SWAMP_SERVER_TOKEN_FILE");
  if (!tokenFile) return undefined;
  const bound = tokenFileBoundTo(key, [
    Deno.env.get("SWAMP_SERVE_URL"),
    Deno.env.get("SWAMP_SERVER_URL"),
  ]);
  if (!bound) return undefined;
  return await readTokenFile(tokenFile, "SWAMP_SERVER_TOKEN_FILE");
}
