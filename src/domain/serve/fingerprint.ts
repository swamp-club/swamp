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

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../expressions/expression_references.ts";

const count = z.number().int().nonnegative();

const WorkersSchema = z.object({
  total: count,
  byVersion: z.record(z.string(), count),
  byLabelKey: z.record(z.string(), count),
}).strict();

const ExtensionSchema = z.object({
  name: z.string(),
  version: z.string(),
}).strict();

// adding a field is an architecture decision: the allowlist is the contract
const FingerprintSchema = z.object({
  swampVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
  serveYamlVersion: z.union([z.literal(1), z.literal(2)]),
  deploymentMode: z.enum(["local", "durable", "durable (limited)"]),
  datastoreKind: z.string(),
  datastoreFormat: z.enum(["v2", "v3"]),
  vaultKinds: z.array(z.string()),
  authMode: z.enum(["none", "token", "oauth"]),
  tls: z.boolean(),
  remoteOnly: z.boolean(),
  loopbackOnly: z.boolean(),
  federationRole: z.enum(["hub", "member", "none"]),
  extensions: z.array(ExtensionSchema),
  settingsHash: z.string().regex(/^[0-9a-f]{64}$/),
  workers: WorkersSchema,
  team: z.object({
    role: z.enum(["leader", "follower", "single"]),
    nodes: z.number().int().positive(),
  }).strict().nullable(),
  startedAt: z.string().nullable(),
  ready: z.boolean().nullable(),
}).strict();

export type FingerprintProps = z.infer<typeof FingerprintSchema>;
export type FingerprintWorkers = FingerprintProps["workers"];

/** outside hash(): a pool change is not configuration drift */
const POOL_FIELDS = ["workers"] as const;
/** outside hash(): known only to a running serve */
const RUNTIME_FIELDS = ["team", "startedAt", "ready"] as const;

export type FingerprintStaticFields = Omit<
  FingerprintProps,
  typeof POOL_FIELDS[number] | typeof RUNTIME_FIELDS[number]
>;

export class Fingerprint {
  private constructor(private readonly props: FingerprintProps) {}

  /** refuses a missing field or any field outside the contract */
  static create(input: unknown): Fingerprint {
    const parsed = FingerprintSchema.parse(input);
    return new Fingerprint({
      ...parsed,
      vaultKinds: [...new Set(parsed.vaultKinds)].sort(),
      extensions: [...parsed.extensions].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      ),
    });
  }

  static fromJSON(json: unknown): Fingerprint {
    return Fingerprint.create(json);
  }

  toJSON(): FingerprintProps {
    return structuredClone(this.props);
  }

  staticFields(): FingerprintStaticFields {
    const fields: Record<string, unknown> = { ...this.props };
    for (const key of [...POOL_FIELDS, ...RUNTIME_FIELDS]) delete fields[key];
    return structuredClone(fields) as FingerprintStaticFields;
  }

  /** sha256 hex of the static fields: it changes only when configuration does */
  hash(): string {
    return sha256(canonicalJson(this.staticFields()));
  }

  equals(other: Fingerprint): boolean {
    return canonicalJson(this.props) === canonicalJson(other.props);
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The merged serve settings the settings hash reads, by their merged option
 * names. Admins, allowed users and collectives, webhooks, OAuth client
 * details, token secrets, paths, host and port are deliberately absent.
 */
export interface FingerprintSettingsSource {
  readonly authMode: string;
  readonly certFile?: string;
  readonly remoteOnly: boolean;
  readonly verifyOnEnroll: boolean;
  readonly dispatchEnvAllow?: string;
  readonly maxConcurrentRuns?: number;
  readonly maxRunsPerPrincipal?: number;
  readonly maxRunDuration?: string;
  readonly approveRequiresExplicitGrant: boolean;
  readonly signalRequiresExplicitGrant: boolean;
  readonly tagRequiresExplicitGrant: boolean;
  readonly grantReload: string;
  readonly hotReload: boolean;
  readonly reusePort: boolean;
  readonly schedule: boolean;
  readonly dashboard: boolean;
  readonly autoResume: boolean;
  readonly shutdownDrainTimeout?: string;
  readonly restrictedModelTypes?: string;
  readonly restrictedCommands?: string;
}

function names(list: string | undefined): string[] {
  if (list === undefined) return [];
  return [
    ...new Set(list.split(",").map((s) => s.trim()).filter((s) => s !== "")),
  ].sort();
}

// copies field by field, so a setting outside the list can never reach the hash
export function computeSettingsHash(source: FingerprintSettingsSource): string {
  return sha256(canonicalJson({
    authMode: source.authMode,
    tls: !!source.certFile,
    remoteOnly: source.remoteOnly,
    verifyOnEnroll: source.verifyOnEnroll,
    dispatchEnvAllow: names(source.dispatchEnvAllow),
    maxConcurrentRuns: source.maxConcurrentRuns ?? null,
    maxRunsPerPrincipal: source.maxRunsPerPrincipal ?? null,
    maxRunDuration: source.maxRunDuration ?? null,
    approveRequiresExplicitGrant: source.approveRequiresExplicitGrant,
    signalRequiresExplicitGrant: source.signalRequiresExplicitGrant,
    tagRequiresExplicitGrant: source.tagRequiresExplicitGrant,
    grantReload: source.grantReload,
    hotReload: source.hotReload,
    reusePort: source.reusePort,
    schedule: source.schedule,
    dashboard: source.dashboard,
    autoResume: source.autoResume,
    shutdownDrainTimeout: source.shutdownDrainTimeout ?? null,
    restrictedModelTypes: names(source.restrictedModelTypes),
    restrictedCommands: names(source.restrictedCommands),
  }));
}
