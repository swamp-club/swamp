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

function isCount(value: unknown): boolean {
  return count.safeParse(value).success;
}

// z.record drops a __proto__ key, and label keys are free text
const countsByName = z.custom<Record<string, number>>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every(isCount),
  { message: "expected a mapping of names to counts" },
).transform((value) => Object.fromEntries(Object.entries(value)));

const WorkersSchema = z.object({
  total: count,
  byVersion: countsByName,
  byLabelKey: countsByName,
}).strict();

const ExtensionSchema = z.object({
  name: z.string(),
  version: z.string(),
}).strict();

// adding a field is an architecture decision: the allowlist is the contract
export const FingerprintSchema = z.object({
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
    role: z.enum(["leader", "follower", "peer", "single"]),
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

/** what a running serve last reported; it never enters hash() or a data version */
export const FingerprintRuntimeSchema = FingerprintSchema.pick({
  team: true,
  startedAt: true,
  ready: true,
});

export type FingerprintRuntime = z.infer<typeof FingerprintRuntimeSchema>;

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

  runtime(): FingerprintRuntime {
    return structuredClone({
      team: this.props.team,
      startedAt: this.props.startedAt,
      ready: this.props.ready,
    });
  }

  /** changes only when configuration does */
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

/** the merged serve settings the settings hash reads, by their merged option names */
export interface FingerprintSettingsSource {
  readonly authMode: string;
  /** a path: only whether it is set reaches the hash */
  readonly certFile?: string;
  readonly remoteOnly: boolean;
  readonly verifyOnEnroll: boolean;
  readonly dispatchEnvAllow?: string;
  readonly reservedWorkerLabels?: string;
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
  const reservedWorkerLabels = names(source.reservedWorkerLabels);
  return sha256(canonicalJson({
    // only when set, so a node without it hashes as it did before the setting
    ...(reservedWorkerLabels.length > 0 ? { reservedWorkerLabels } : {}),
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
