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

import type {
  CommandInvocationData,
  InvocationContextData,
} from "../domain/telemetry/mod.ts";
import {
  detectAgentHarness,
  RELEVANT_ENV_VARS,
} from "../domain/telemetry/mod.ts";
import type { TelemetryService } from "../domain/telemetry/telemetry_service.ts";

import type { DatastoreConfigData } from "../domain/datastore/datastore_config.ts";
import type { VaultConfigData } from "../domain/vaults/vault_config.ts";
import { isBooleanFlag } from "./boolean_flags.ts";

const BUILTIN_VAULT_TYPES = new Set(["local_encryption", "mock"]);

export function isExternalDatastoreConfigured(
  datastore: DatastoreConfigData | undefined,
): boolean {
  return datastore !== undefined && datastore.type !== "filesystem";
}

export function isExternalVaultConfigured(
  vaults: VaultConfigData[],
): boolean {
  return vaults.some((v) => !BUILTIN_VAULT_TYPES.has(v.type));
}

/**
 * set once at the top of runCli and cleared in its finally; commands that emit
 * child telemetry read it via `getActiveTelemetryService()`
 */
let activeTelemetryService: TelemetryService | null = null;

/**
 * published alongside the service because serve, a daemon, cannot rely on CLI
 * teardown to flush and runs its own flush loop with the same credentials
 */
export interface TelemetryContext {
  service: TelemetryService;
  userId: string | null;
  /** undefined outside a swamp repo; the event is then keyed solely by userId */
  repoId: string | undefined;
  telemetryEndpoint: string;
  keepFlushed: boolean;
  authToken: string | null;
}

let activeTelemetryContext: TelemetryContext | null = null;

export function setActiveTelemetryService(service: TelemetryService): void {
  activeTelemetryService = service;
}

export function clearActiveTelemetryService(): void {
  activeTelemetryService = null;
}

export function getActiveTelemetryService(): TelemetryService | null {
  return activeTelemetryService;
}

export function setActiveTelemetryContext(context: TelemetryContext): void {
  activeTelemetryContext = context;
}

/** the context holds an auth token and must not outlive the invocation */
export function clearActiveTelemetryContext(): void {
  activeTelemetryContext = null;
}

export function getActiveTelemetryContext(): TelemetryContext | null {
  return activeTelemetryContext;
}

/**
 * "categorical" is a system-defined value safe to record; "redact" is
 * user-identifiable. Commands not listed, and positions beyond the schema,
 * default to redact
 */
const ARG_SCHEMAS: Record<string, readonly ("categorical" | "redact")[]> = {
  "model create": ["categorical", "redact"],
  "model method": ["categorical", "redact", "categorical"],
  // `behavior run` is classified before the command tree exists, so the alias
  // spelling cannot be canonicalised here and needs its own entry
  "model output": ["categorical", "redact"],
  "vault create": ["categorical", "redact"],
  "type describe": ["categorical"],
  "workflow history": ["categorical", "redact"],
  ...behaviorArgSchemas(),
};

/**
 * each swamp behavior path is classified like its legacy swamp model twin; this
 * runs before the command tree exists, so the behaviour alias gets its own
 * entries
 */
function behaviorArgSchemas(): Record<
  string,
  readonly ("categorical" | "redact")[]
> {
  const schemas: Record<string, readonly ("categorical" | "redact")[]> = {
    run: ["redact", "categorical", "redact"],
    create: ["categorical", "redact"],
    describe: ["redact", "categorical"],
    // `history <name>` and `output <name>` are shorthands that take a name
    // first, so neither slot can be categorical without recording it.
    history: ["redact", "redact"],
    output: ["redact", "redact"],
    get: ["redact"],
    edit: ["redact"],
    delete: ["redact"],
    validate: ["redact"],
    evaluate: ["redact"],
    search: ["redact"],
    list: ["redact"],
    cancel: ["redact"],
    type: ["redact", "redact"],
  };
  const entries: Record<string, readonly ("categorical" | "redact")[]> = {};
  for (const group of ["behavior", "behaviour"]) {
    for (const [sub, schema] of Object.entries(schemas)) {
      entries[`${group} ${sub}`] = schema;
    }
  }
  return entries;
}

export const GLOBAL_OPTIONS: ReadonlySet<string> = new Set([
  "--json",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--no-telemetry",
  "--no-color",
  "--show-properties",
]);

/**
 * drives hook detection, loader gating, stdout routing and span attributes;
 * recorded telemetry uses `resolveTelemetryInvocation` instead. Option values
 * are redacted, only keys are recorded
 */
export function extractCommandInfo(args: string[]): CommandInvocationData {
  const result: CommandInvocationData = {
    command: "",
    args: [],
    optionKeys: [],
    globalOptions: [],
  };

  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("-")) {
      if (GLOBAL_OPTIONS.has(arg)) {
        result.globalOptions.push(arg);
      }
      if (consumesNextArg(arg, args[i + 1])) {
        i++;
      }
      i++;
      continue;
    }

    result.command = arg;
    i++;
    break;
  }

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("-")) {
      if (GLOBAL_OPTIONS.has(arg)) {
        result.globalOptions.push(arg);
      } else {
        result.optionKeys.push(arg.split("=")[0]);
      }
      if (consumesNextArg(arg, args[i + 1])) {
        i++;
      }
      i++;
      continue;
    }

    result.subcommand = arg;
    i++;
    break;
  }

  const schemaKey = result.subcommand
    ? `${result.command} ${result.subcommand}`
    : result.command;
  const argSchema = ARG_SCHEMAS[schemaKey];
  let positionalIndex = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("-")) {
      const optionKey = arg.split("=")[0];

      if (GLOBAL_OPTIONS.has(optionKey)) {
        if (!result.globalOptions.includes(optionKey)) {
          result.globalOptions.push(optionKey);
        }
      } else {
        if (!result.optionKeys.includes(optionKey)) {
          result.optionKeys.push(optionKey);
        }
      }

      if (consumesNextArg(arg, args[i + 1])) {
        i++;
      }
    } else {
      const sensitivity = argSchema?.[positionalIndex] ?? "redact";
      result.args.push(sensitivity === "categorical" ? arg : "<REDACTED>");
      positionalIndex++;
    }

    i++;
  }

  return result;
}

/**
 * an option written `--log-level=debug` carries its value, so the next argument
 * is the command; swallowing it would misparse `--log-level=debug invite link`
 * and corrupt stdout routing
 */
function consumesNextArg(arg: string, next: string | undefined): boolean {
  return next !== undefined &&
    !next.startsWith("-") &&
    !isBooleanFlag(arg) &&
    !arg.includes("=");
}

export function isTelemetryDisabled(args: string[]): boolean {
  return args.includes("--no-telemetry");
}

/**
 * the full env contains secrets (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, vault
 * tokens); projecting through the whitelist keeps every other key out of the
 * telemetry pipeline
 */
export function projectEnvSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const key of RELEVANT_ENV_VARS) {
    const value = Deno.env.get(key);
    if (value !== undefined) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

/**
 * `configuredAiTools` is undefined with no marker (outside a swamp repo) and
 * `[]` when the marker opted out via legacy `tool: none`; the two carry
 * different meaning downstream and must stay distinct
 */
export function buildInvocationContext(
  envSnapshot: Record<string, string>,
  configuredAiTools: string[] | undefined,
  externalDatastoreConfigured: boolean,
  datastoreType: string | undefined,
  externalVaultConfigured: boolean,
): InvocationContextData {
  const detection = detectAgentHarness(envSnapshot);
  const data: InvocationContextData = {
    agentSessionDetected: detection.agentSessionDetected,
    isInteractive: Deno.stdin.isTerminal(),
    externalDatastoreConfigured,
    externalVaultConfigured,
  };
  if (configuredAiTools !== undefined) {
    data.configuredAiTools = configuredAiTools;
  }
  if (detection.detectedAiTool !== undefined) {
    data.detectedAiTool = detection.detectedAiTool;
  }
  if (datastoreType !== undefined) {
    data.datastoreType = datastoreType;
  }
  return data;
}
