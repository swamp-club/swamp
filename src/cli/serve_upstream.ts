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
import { resolveExtraHeaders } from "../domain/auth/extra_headers.ts";
import type { DatastoreEngine } from "../domain/datastore/datastore_format.ts";
import { ServeUpstreamTarget } from "../domain/datastore_v3/serve_upstream.ts";
import { FileServerCredentialRepository } from "../infrastructure/persistence/server_credential_repository.ts";
import {
  getEnvCaCerts,
  implicitServeUrl,
  readTokenFile,
  tokenFileBoundTo,
  warnWithheldTokenFile,
} from "./remote_run.ts";

let currentCommandPath: readonly string[] = [];

export function setServeUpstreamCommandPath(path: readonly string[]): void {
  currentCommandPath = [...path];
}

export function serveUpstreamCommandPath(): readonly string[] {
  return currentCommandPath;
}

export function resetServeUpstreamCommandPath(): void {
  currentCommandPath = [];
}

export interface ServeUpstreamDecision {
  readonly applies: boolean;
  readonly reason: string;
}

/**
 * with `subcommands`, the family's own `applies` answers for the bare group and
 * unlisted subcommands; the rules test requires every subcommand listed, so it
 * only covers the group's help output
 */
export interface ServeUpstreamFamilyRule extends ServeUpstreamDecision {
  readonly subcommands?: Readonly<Record<string, ServeUpstreamDecision>>;
}

const APPLIES = "reads or writes the repository like any other command";
const NO_REPO = "opens no repository; the answer is moot";

/**
 * the one table saying which commands use serve as their v3 datastore upstream,
 * keyed by the top-level word as typed so aliases have their own rows; excluded
 * commands bind storage directly
 */
/**
 * data-plane families run locally with serve as upstream despite a --server
 * flag: an address from the environment or .swamp.yaml does not send them to
 * serve, an explicit --server does
 */
export const SERVE_UPSTREAM_LOCAL_FAMILIES: ReadonlySet<string> = new Set([
  "behavior",
  "behaviour",
  "data",
  "extension",
  "model",
  "report",
  "summarise",
  "summarize",
  "vault",
  "workflow",
]);

/**
 * `datastore status` runs locally: it reports the checkout's own copy and
 * offline-saved work serve cannot see, and adds serve's section when serve
 * answers; an explicit `--server` still sends it to serve
 */
export const SERVE_UPSTREAM_LOCAL_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "datastore status",
]);

export function serveUpstreamRunsLocally(
  commandPath: readonly string[],
): boolean {
  const [command, subcommand] = commandPath;
  if (command === undefined) return false;
  const local = SERVE_UPSTREAM_LOCAL_FAMILIES.has(command) ||
    (subcommand !== undefined &&
      SERVE_UPSTREAM_LOCAL_SUBCOMMANDS.has(`${command} ${subcommand}`));
  return local && serveUpstreamAppliesTo(commandPath);
}

/**
 * a forwarded run record applies a decision and never makes one, so these reach
 * serve's handlers, as --server does
 */
const DECIDED_ON_SERVE =
  "a decision on a run is serve's to make; the command goes to serve's handler";

export const SERVE_UPSTREAM_COMMANDS: Readonly<
  Record<string, ServeUpstreamFamilyRule>
> = {
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
        applies: true,
        reason:
          "reports this checkout's datastore: through serve, its copy and the work it saved offline (swamp-club#4195)",
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
        applies: true,
        reason:
          "lists the leases serve holds and force-releases one through the serve a checkout writes through; a checkout without serve still binds the storage's writer lock (swamp-club#4195)",
      },
      quarantine: {
        applies: true,
        reason:
          "asks the serve this checkout writes through to land a change it keeps (swamp-club#4195)",
      },
      compact: {
        applies: false,
        reason: "checkpoints and vacuums the storage's own databases",
      },
      gc: {
        applies: false,
        reason: "deletes unreferenced chunks from the storage",
      },
      claim: {
        applies: false,
        reason: "writes serve's claim into the storage's commit log",
      },
      release: {
        applies: false,
        reason: "removes serve's claim from the storage's commit log",
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
  extension: {
    applies: true,
    reason:
      "installs into this checkout, as without serve; only --server installs on serve (swamp-club#4281)",
  },
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
  workflow: {
    applies: true,
    reason: APPLIES,
    subcommands: {
      create: { applies: true, reason: APPLIES },
      delete: { applies: true, reason: APPLIES },
      edit: { applies: true, reason: APPLIES },
      evaluate: { applies: true, reason: APPLIES },
      get: { applies: true, reason: APPLIES },
      history: { applies: true, reason: APPLIES },
      validate: { applies: true, reason: APPLIES },
      search: { applies: true, reason: APPLIES },
      list: { applies: true, reason: APPLIES },
      run: { applies: true, reason: APPLIES },
      cancel: { applies: true, reason: APPLIES },
      recover: { applies: true, reason: APPLIES },
      resume: { applies: true, reason: APPLIES },
      approvals: { applies: true, reason: APPLIES },
      schedule: { applies: true, reason: APPLIES },
      schema: { applies: true, reason: APPLIES },
      trigger: { applies: true, reason: APPLIES },
      // The only waits a checkout can signal are serve's.
      waits: { applies: false, reason: DECIDED_ON_SERVE },
      approve: { applies: false, reason: DECIDED_ON_SERVE },
      reject: { applies: false, reason: DECIDED_ON_SERVE },
      signal: { applies: false, reason: DECIDED_ON_SERVE },
    },
  },
  workspace: { applies: true, reason: NO_REPO },
};

/**
 * an empty path or a word the table does not know answers false, which keeps
 * the direct storage binding; words past the second are ignored
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

export interface ResolveServeUpstreamOptions {
  engine: DatastoreEngine;
  commandPath: readonly string[];
  markerServerAddress?: string;
  credentialRepository?: ServerCredentialRepository;
  getCaCerts?: () => readonly string[] | undefined;
}

/**
 * the token comes only from sources bound to the address, so a token meant for
 * one server is never sent to another; no token is not an error: serve with
 * `--auth-mode none` needs none and others answer 401 with the login hint
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
  // A set token file that left no token was not bound to the address.
  if (token === undefined && Deno.env.get("SWAMP_SERVER_TOKEN_FILE")) {
    warnWithheldTokenFile(key, "env");
  }

  const caCerts = (opts.getCaCerts ?? getEnvCaCerts)();

  return ServeUpstreamTarget.create({
    serverUrl: key,
    token,
    caCerts,
    extraHeaders: resolveExtraHeaders(),
  });
}

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
