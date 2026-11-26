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
import { FEDERATION_GATE_VARIABLE } from "../src/domain/serve/federation_gate.ts";
import { ControlPlaneVaultProvider } from "../src/domain/vaults/control_plane_vault_provider.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { resolveDatastoreForRepo } from "../src/cli/repo_context.ts";
import { buildServeFederationMember } from "../src/cli/commands/serve_federation_member.ts";
import {
  loadServeConfig,
  mergeServeOptions,
} from "../src/serve/serve_config.ts";
import type { ProcessHost } from "./process_host.ts";

export type MemberHostRequest =
  | {
    readonly kind: "start";
    readonly repoDir: string;
    readonly gate: boolean;
    /** test-only cap on the hub's interval, so a check-in takes milliseconds */
    readonly maxIntervalSeconds: number;
  }
  | { readonly kind: "stop" };

export type MemberHostMessage =
  | {
    readonly kind: "started";
    readonly built: boolean;
    readonly instanceId: string;
  }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly error: string };

/**
 * one member serve process: its own objects over the repo it is given, the
 * member services serve builds, and real HTTP to the hub serve.yaml names
 */
export const startMemberHost: ProcessHost<
  MemberHostRequest,
  MemberHostMessage
> = (post) => {
  let stop: (() => Promise<void>) | undefined;
  return (request) => {
    if (request.kind === "stop") {
      const stopping = stop ?? (() => Promise.resolve());
      stop = undefined;
      stopping().then(
        () => post({ kind: "stopped" }),
        (error) => post({ kind: "failed", error: String(error) }),
      );
      return;
    }
    // serve reads the gate from its env while it loads serve.yaml and runs
    withMockedEnv(
      { [FEDERATION_GATE_VARIABLE]: request.gate ? "1" : undefined },
      () => start(request),
    ).then(
      (started) => {
        stop = started.stop;
        post({
          kind: "started",
          built: started.built,
          instanceId: started.instanceId,
        });
      },
      (error) => post({ kind: "failed", error: String(error) }),
    );
  };
};

async function start(
  request: Extract<MemberHostRequest, { kind: "start" }>,
): Promise<{ built: boolean; instanceId: string; stop: () => Promise<void> }> {
  await initializeLogging({});
  const env = (name: string) =>
    name === FEDERATION_GATE_VARIABLE
      ? (request.gate ? "1" : undefined)
      : undefined;
  const repoDir = request.repoDir;
  const merged = mergeServeOptions(
    loadServeConfig(undefined, repoDir),
    {},
    new Set(),
    env,
  );
  const repoContext = createRepositoryContext({ repoDir });
  const resolution = await resolveDatastoreForRepo(repoDir);
  const store = new FileSystemControlPlaneStore(swampPath(repoDir));
  const vault = new ControlPlaneVaultProvider(store, { migrate: false });
  await vault.initialize();
  const instanceId = crypto.randomUUID();
  const member = buildServeFederationMember({
    env,
    merged,
    serveYamlVersion: 2,
    repoDir,
    repoContext,
    store,
    tokenSecrets: vault,
    datastoreConfig: resolution.datastoreConfig,
    datastoreEngine: resolution.engine,
    lockfilePath: join(repoDir, "upstream_extensions.json"),
    settings: () => merged,
    instanceId,
    startedAt: new Date().toISOString(),
    teamMode: "local",
    team: () => Promise.resolve({ role: "single", nodes: 1 }),
    liveWorkers: () => [],
    ready: () => true,
    schedule: {
      intervalBounds: {
        minSeconds: 0.01,
        maxSeconds: request.maxIntervalSeconds,
      },
      maxBackoffMs: 400,
      livenessMs: 50,
      joinWaitMs: 50,
    },
  });
  member?.service.start();
  return {
    built: member !== undefined,
    instanceId,
    stop: async () => {
      await member?.service.stop();
      repoContext.catalogStore.close();
    },
  };
}
