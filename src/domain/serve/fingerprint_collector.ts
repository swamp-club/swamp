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
  classifyDatastore,
  classifyVaults,
  resolveDeploymentMode,
} from "./deployment_mode.ts";
import {
  computeSettingsHash,
  Fingerprint,
  type FingerprintProps,
  type FingerprintSettingsSource,
  type FingerprintWorkers,
} from "./fingerprint.ts";
import { isLoopbackHost } from "./loopback.ts";

export interface FingerprintDatastoreFacts {
  /** the extension datastore type; undefined for the filesystem datastore */
  readonly customType: string | undefined;
  readonly format: "v2" | "v3";
  readonly hasControlPlane: boolean;
}

/** what a worker record contributes: never its label values */
export interface FingerprintWorkerFacts {
  readonly swampVersion: string;
  readonly labelKeys: readonly string[];
}

export interface FingerprintRuntimeFacts {
  readonly team: FingerprintProps["team"];
  readonly startedAt: string | null;
  readonly ready: boolean | null;
}

export interface FingerprintCollectorPorts {
  buildVersion(): string;
  platform(): { readonly platform: string; readonly arch: string };
  settings(): FingerprintSettingsSource & { readonly host: string };
  serveYamlVersion(): 1 | 2;
  federationRole(): FingerprintProps["federationRole"];
  datastore(): Promise<FingerprintDatastoreFacts>;
  vaultTypes(): Promise<readonly string[]>;
  extensions(): Promise<readonly { name: string; version: string }[]>;
  /** every readable worker record, whatever its status */
  workers(): Promise<readonly FingerprintWorkerFacts[]>;
}

export function countWorkers(
  workers: readonly FingerprintWorkerFacts[],
): FingerprintWorkers {
  // a Map, since label keys are free text and may name Object.prototype members
  const byVersion = new Map<string, number>();
  const byLabelKey = new Map<string, number>();
  for (const worker of workers) {
    byVersion.set(
      worker.swampVersion,
      (byVersion.get(worker.swampVersion) ?? 0) + 1,
    );
    for (const key of new Set(worker.labelKeys)) {
      byLabelKey.set(key, (byLabelKey.get(key) ?? 0) + 1);
    }
  }
  return {
    total: workers.length,
    byVersion: Object.fromEntries(byVersion),
    byLabelKey: Object.fromEntries(byLabelKey),
  };
}

const NO_RUNTIME: FingerprintRuntimeFacts = {
  team: null,
  startedAt: null,
  ready: null,
};

export class FingerprintCollector {
  constructor(private readonly ports: FingerprintCollectorPorts) {}

  async collect(
    runtime: FingerprintRuntimeFacts = NO_RUNTIME,
  ): Promise<Fingerprint> {
    const settings = this.ports.settings();
    const [datastore, vaultTypes, extensions, workers] = await Promise.all([
      this.ports.datastore(),
      this.ports.vaultTypes(),
      this.ports.extensions(),
      this.ports.workers(),
    ]);
    const deployment = resolveDeploymentMode(
      classifyDatastore(datastore),
      classifyVaults(vaultTypes),
    );
    const { platform, arch } = this.ports.platform();
    return Fingerprint.create({
      swampVersion: this.ports.buildVersion(),
      platform,
      arch,
      serveYamlVersion: this.ports.serveYamlVersion(),
      deploymentMode: deployment.mode,
      datastoreKind: datastore.customType ?? "filesystem",
      datastoreFormat: datastore.format,
      vaultKinds: [...vaultTypes],
      authMode: settings.authMode,
      tls: !!settings.certFile,
      remoteOnly: settings.remoteOnly,
      loopbackOnly: isLoopbackHost(settings.host),
      federationRole: this.ports.federationRole(),
      extensions: extensions.map(({ name, version }) => ({ name, version })),
      settingsHash: computeSettingsHash(settings),
      workers: countWorkers(workers),
      ...runtime,
    });
  }
}
