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

import { UserError } from "../../domain/errors.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { federationMemberEnabled } from "../../serve/federation/federation_hub.ts";
import {
  type FederationMemberLink,
  HubLinkStore,
} from "../../serve/federation/hub_link_store.ts";
import { MemberCredentialVault } from "../../serve/federation/member_credential_vault.ts";
import {
  loadServeConfig,
  mergeServeOptions,
} from "../../serve/serve_config.ts";
import { initializeControlPlaneVaultForCli } from "../control_plane_vault.ts";
import {
  localAppControlPlane,
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
  resolveDatastoreForRepo,
} from "../repo_context.ts";

export interface LocalMemberOptions {
  readonly repoDir: string;
  /** the serve.yaml to read, as `swamp serve --config` takes it */
  readonly config?: string;
  readonly outputMode: OutputMode;
  /** forget runs only locally, so its refusals cannot point at --server */
  readonly forget?: boolean;
}

const env = (name: string) => Deno.env.get(name);

/** the hub serve.yaml names, or a refusal unless the gate is on and serve.yaml is a version 2 member */
async function localMemberHubUrl(options: LocalMemberOptions): Promise<string> {
  const merged = mergeServeOptions(
    loadServeConfig(options.config, options.repoDir),
    {},
    new Set(),
  );
  if (!federationMemberEnabled(env, merged.federation)) {
    throw new UserError(
      "This repository's serve is not a federation member: its serve.yaml needs " +
        "version: 2 and federation.hub." +
        (options.forget ? "" : " Pass --server to ask a running member."),
    );
  }
  const resolution = await resolveDatastoreForRepo(options.repoDir);
  if (resolution.serveUpstream !== undefined) {
    throw new UserError(
      options.forget
        ? "This checkout writes through serve, which holds the hub link. Run swamp serve hub forget in the serve's own repository."
        : "This checkout writes through serve, which holds the hub link. Pass --server to ask it.",
    );
  }
  return merged.federation!.hub!;
}

/**
 * the link records and credential in the control-plane store serve uses,
 * remote ones included; forget writes there, so this opens the repo to write
 */
async function openLocalMember(options: LocalMemberOptions): Promise<{
  readonly link: FederationMemberLink;
  readonly credentials: MemberCredentialVault;
}> {
  const configuredHubUrl = await localMemberHubUrl(options);
  const { repoDir, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({
      repoDir: options.repoDir,
      outputMode: options.outputMode,
    });
  const { provider, store } = await initializeControlPlaneVaultForCli(
    repoDir,
    syncService,
    {
      namespace: isCustomDatastoreConfig(datastoreConfig)
        ? datastoreConfig.namespace
        : undefined,
      catalogInvalidate: () => repoContext.catalogStore.invalidate(),
    },
  );
  return {
    link: { links: new HubLinkStore(store), configuredHubUrl },
    credentials: new MemberCredentialVault(provider),
  };
}

export async function openLocalHubLink(
  options: LocalMemberOptions,
): Promise<FederationMemberLink> {
  const resolution = await resolveDatastoreForRepo(options.repoDir);
  // only a v2 extension datastore's sync service reaches its remote control plane; v2 holds no writer lease
  if (
    isCustomDatastoreConfig(resolution.datastoreConfig) &&
    resolution.engine !== "v3"
  ) {
    return (await openLocalMember(options)).link;
  }
  const configuredHubUrl = await localMemberHubUrl(options);
  const { repoDir } = await requireInitializedRepoReadOnly({
    repoDir: options.repoDir,
    outputMode: options.outputMode,
  });
  return {
    links: new HubLinkStore(await localAppControlPlane(repoDir)),
    configuredHubUrl,
  };
}

export async function openLocalHubLinkForForget(
  options: LocalMemberOptions,
): Promise<{ links: HubLinkStore; credentials: MemberCredentialVault }> {
  const { link, credentials } = await openLocalMember(options);
  return { links: link.links, credentials };
}
