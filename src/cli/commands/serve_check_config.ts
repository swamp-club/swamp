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

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  buildServeAuthConfig,
  findIneffectiveAdmins,
  findIneffectiveRestrictions,
} from "../../domain/access/serve_auth_config.ts";
import { serverRequestPayloadFields } from "../../serve/connection.ts";
import {
  checkRouteFiles,
  shadowedRouteFileMessage,
} from "../../serve/webhook_route_files.ts";
import { SECRET_WITHOUT_CLIENT_ID_MESSAGE } from "../../serve/oauth_registration.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import {
  renderServeCheckConfig,
  type TokenSecretsKeyCheck,
  type WebhookRouteFileError,
  type WebhookRouteWarning,
} from "../../presentation/output/serve_check_config_output.ts";
import type { TokenSecretsKeyRef } from "../../domain/vaults/token_secrets_key.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import {
  apiKeySourceName,
  CLUB_API_KEY_FILE_FLAG,
} from "../../infrastructure/persistence/api_key_source.ts";
import { selectCheckConfigToken } from "../serve_check_config_token.ts";
import {
  loadServeConfig,
  type MergedServeOptions,
  mergeServeOptions,
  parseExplicitFlags,
  parseTokenSecretsKeyConfig,
  resolveServePath,
  SERVE_CONFIG_PATH,
} from "../../serve/serve_config.ts";
import {
  OAUTH_CLIENT_SECRET_FILE_FLAG,
  resolveOAuthClientSecret,
} from "../../serve/oauth_client_secret_source.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import type { GrantFileError } from "../../domain/access/grant_file.ts";
import {
  checkServeGrantFiles,
  checkServeGrantFileUsernames,
  readServeGrantFiles,
} from "../../domain/access/grant_file_loader.ts";
import {
  unresolvableUsernames,
  type UsernameLookup,
  usernameSubjectsNeedOAuthMessage,
} from "../../domain/access/grant_username_resolution.ts";
import {
  readConditionTypeLiterals,
  validateGrantCondition,
} from "../../infrastructure/cel/grant_condition_environment.ts";
import type { RepoMarkerData } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { webhookRouteExtensionDirs } from "./serve_startup_settings.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

async function checkWebhookRouteFiles(
  repoDir: string,
  merged: MergedServeOptions,
): Promise<{
  directoryError?: string;
  errors: WebhookRouteFileError[];
  warnings: WebhookRouteWarning[];
}> {
  let marker: RepoMarkerData | null = null;
  try {
    marker = await new RepoMarkerRepository().read(RepoPath.create(repoDir));
  } catch {
    // no marker: serve falls back to the default webhook extensions dir too
  }
  const flags = merged.webhook ?? [];
  const operator = flags.length > 0
    ? flags.map((spec) => ({
      route: spec.split(":")[0],
      source: "flag" as const,
    }))
    : (merged.webhookConfigs ?? []).map((entry) => ({
      route: entry.route,
      source: "config" as const,
    }));
  const check = await checkRouteFiles(
    resolveServePath(repoDir, merged.webhookRoutesDir),
    webhookRouteExtensionDirs(repoDir, marker),
    operator,
  );
  return {
    ...(check.directoryError !== undefined
      ? { directoryError: check.directoryError }
      : {}),
    errors: check.refused.map((refused) => ({
      file: refused.file,
      ...(refused.route !== undefined ? { route: refused.route } : {}),
      message: refused.message,
    })),
    warnings: check.shadowed.map((shadow) => ({
      route: shadow.route,
      workflow: shadow.workflow,
      reason: `shadowed by ${
        shadow.by === "flag" ? "a --webhook flag" : "the serve config"
      }`,
      message: shadowedRouteFileMessage(shadow),
    })),
  };
}

async function checkTokenSecretsKey(
  ref: TokenSecretsKeyRef | undefined,
  repoDir: string,
): Promise<TokenSecretsKeyCheck | undefined> {
  if (!ref) return undefined;
  const { resolveTokenSecretsKey } = await import(
    "../../domain/vaults/control_plane_vault_init.ts"
  );
  try {
    await resolveTokenSecretsKey(
      ref,
      await VaultService.fromRepository(repoDir),
    );
    return { vault: ref.vault, key: ref.key, status: "ok" };
  } catch (err) {
    return {
      vault: ref.vault,
      key: ref.key,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatGrantFileErrorLines(
  errors: readonly GrantFileError[],
): string {
  return errors.map((e) => {
    const loc = e.entryIndex !== undefined
      ? `${e.filename} entry ${e.entryIndex + 1}`
      : e.filename;
    return `  ${loc}: ${e.message}`;
  }).join("\n");
}

// reads no store, so a client id whose secret only the store holds still passes
export function checkOAuthClientSecret(
  secretFileFlag: string | undefined,
  clientId: string | undefined,
): string | undefined {
  let supplied: string | undefined;
  try {
    supplied = resolveOAuthClientSecret(secretFileFlag);
  } catch (err) {
    if (err instanceof UserError) return err.message;
    throw err;
  }
  if (supplied !== undefined && !clientId) {
    return SECRET_WITHOUT_CLIENT_ID_MESSAGE;
  }
  return undefined;
}

export const checkConfigCommand = new Command()
  .name("check-config")
  .description(
    "Check a serve config's auth settings and token secrets key without starting the server.\n\n" +
      "Loads the auth settings the same way 'swamp serve' does (flags, env vars, then the " +
      "config file), validates them, and in oauth mode looks up every admin and " +
      "allowed-user name on the OAuth provider. Exits non-zero if a name is unknown " +
      "or serve would refuse to start. Uses --club-api-key-file, SWAMP_API_KEY_FILE, " +
      "SWAMP_API_KEY or your 'swamp auth login' " +
      "credential, and only sends it to the provider that issued it (set SWAMP_CLUB_URL " +
      "for a custom provider). With a token-secrets block, also reads the token " +
      "secrets key from its vault and checks it is a usable 32-byte key, without " +
      "printing it. It also reads the grant files serve reads (grants/, --grants-file " +
      "and --grants-dir) and fails if serve would refuse them; grant type spellings " +
      "that match no type as written are warnings, and stored grants are reported " +
      "by serve at startup. A restricted-model-types entry without a leading " +
      "'@' that is not a built-in type is a warning, since extension types are " +
      "not loaded here: write an extension type with its '@'. In token mode an " +
      "idp-group admin is a warning, since token-mode tokens carry IdP groups " +
      "only on a hosted workspace whose root signs users in with OAuth. Apart from a " +
      "--grants-file or --grants-dir outside the repository, it reads only this " +
      "repository's files and never contacts the " +
      "datastore, so it cannot tell whether a control plane was already moved to a " +
      "key (or to a different key), and vaults whose configs arrive through the " +
      "datastore must be synced first; serve checks both at startup. Nothing is " +
      "written to the vault. Nothing is written to the repository either, except " +
      "that checking a token-secrets key loads vault extensions, which can create " +
      "or refresh swamp's extension catalog (.swamp/_extension_catalog.db) and, " +
      "when the vault's type is not installed, install its extension.",
  )
  .example("Check the repository's serve config", "swamp serve check-config")
  .example(
    "Check a config file before deploying it",
    "swamp serve check-config --config deploy/serve.yaml",
  )
  .example(
    "Check names passed as flags",
    "swamp serve check-config --auth-mode oauth --admins alice,bob --allowed-collectives eng",
  )
  .option(
    "--config <path:string>",
    "Path to serve config file (default: .swamp/serve.yaml; a relative path resolves against the repository)",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--auth-mode <mode:string>",
    "Authentication mode to check, as passed to 'swamp serve' (overrides the config file)",
  )
  .option(
    "--admins <principals:string>",
    "Comma-separated admin usernames, as passed to 'swamp serve' (overrides the config file)",
  )
  .option(
    "--allowed-users <list:string>",
    "Comma-separated allowed-user usernames, as passed to 'swamp serve' (overrides the config file)",
  )
  .option(
    "--allowed-collectives <list:string>",
    "Comma-separated collective slugs, as passed to 'swamp serve' (overrides the config file)",
  )
  .option(
    "--oauth-provider <url:string>",
    "OAuth provider URL, as passed to 'swamp serve' (overrides the config file)",
  )
  .option(
    "--grants-file <path:string>",
    "External grants YAML file to check, as passed to 'swamp serve' (overrides the config file; env: SWAMP_GRANTS_FILE)",
  )
  .option(
    "--grants-dir <path:string>",
    "Directory of grants YAML files to check, as passed to 'swamp serve' (overrides the config file; env: SWAMP_GRANTS_DIR)",
  )
  .option(
    "--webhook-routes-dir <path:string>",
    "Directory of webhook route files to check, as passed to 'swamp serve' (overrides the config file; env: SWAMP_WEBHOOK_ROUTES_DIR)",
  )
  .option(
    `${CLUB_API_KEY_FILE_FLAG} <path:string>`,
    "Path to a file containing the collective API key used to look up " +
      "usernames; overrides SWAMP_API_KEY_FILE and SWAMP_API_KEY",
  )
  .option(
    "--oauth-client-id <id:string>",
    "OAuth client ID, as passed to 'swamp serve' (overrides the config file; env: SWAMP_OAUTH_CLIENT_ID)",
  )
  .option(
    `${OAUTH_CLIENT_SECRET_FILE_FLAG} <path:string>`,
    "OAuth client secret file to check, as passed to 'swamp serve' (overrides " +
      "SWAMP_OAUTH_CLIENT_SECRET_FILE and SWAMP_OAUTH_CLIENT_SECRET)",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "check-config",
    ]);
    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const configFile = loadServeConfig(
      options.config as string | undefined,
      repoDir,
    );
    const merged = mergeServeOptions(
      configFile,
      options,
      parseExplicitFlags(Deno.args),
    );

    // judged without loading the model registry so this stays read-only and
    // offline: a bare type is checked against built-in types only, serve checks
    // all registered types at startup
    const restrictionFindings = findIneffectiveRestrictions({
      restrictedModelTypes: merged.restrictedModelTypes,
      restrictedCommands: merged.restrictedCommands,
      requestTypes: new Set(serverRequestPayloadFields().keys()),
      isBuiltInModelType: (type) => modelRegistry.isBuiltIn(type),
    });
    const restrictionWarnings = restrictionFindings.filter((finding) =>
      finding.reason !== "no-type"
    );
    // judged as serve startup judges them; stored grants live in the datastore,
    // which this command never contacts
    const checkedGrantFiles = await readServeGrantFiles(repoDir, {
      grantsFile: merged.grantsFile,
      grantsDir: merged.grantsDir,
      validateCondition: validateGrantCondition,
      readTypeLiterals: readConditionTypeLiterals,
    });
    const grantCheck = checkServeGrantFiles(checkedGrantFiles);
    const checkedMode = merged.authMode ?? "none";
    // username subjects are rejected outside OAuth mode and looked up in it, as
    // startup does
    const grantErrors = [...grantCheck.errors];
    if (checkedMode !== "oauth") {
      const issues = await checkServeGrantFileUsernames(
        checkedGrantFiles,
        unresolvableUsernames(usernameSubjectsNeedOAuthMessage(checkedMode)),
      );
      for (const issue of issues) grantErrors.push(issue);
    }
    let grantsLoad = grantErrors.length === 0;
    const grantReport = {
      grantFilesChecked: grantCheck.filesChecked,
      grantErrors,
      grantWarnings: grantCheck.warnings,
    };
    const routeFileCheck = await checkWebhookRouteFiles(repoDir, merged);
    const webhookWarnings = routeFileCheck.warnings;
    const routeFilesLoad = routeFileCheck.errors.length === 0 &&
      routeFileCheck.directoryError === undefined;
    const webhookReport = {
      ...(webhookWarnings.length > 0 ? { webhookWarnings } : {}),
      ...(routeFileCheck.errors.length > 0
        ? { webhookRouteFileErrors: routeFileCheck.errors }
        : {}),
      ...(routeFileCheck.directoryError !== undefined
        ? { webhookRoutesDirError: routeFileCheck.directoryError }
        : {}),
    };
    const unnamedType = restrictionFindings.find((finding) =>
      finding.reason === "no-type"
    );
    if (
      unnamedType !== undefined &&
      (checkedMode === "none" || checkedMode === "token" ||
        checkedMode === "oauth")
    ) {
      renderServeCheckConfig({
        passed: false,
        authMode: checkedMode,
        entries: [],
        allowedCollectives: [],
        wouldStart: false,
        refusal: unnamedType.message,
        restrictionWarnings,
        ...grantReport,
        ...webhookReport,
      }, ctx.outputMode);
      Deno.exitCode = 1;
      return;
    }

    const authConfig = buildServeAuthConfig({
      authMode: merged.authMode,
      admins: merged.admins,
      allowedCollectives: merged.allowedCollectives,
      allowedUsers: merged.allowedUsers,
      oauthProvider: merged.oauthProvider,
      oauthClientId: merged.oauthClientId,
      groupsField: merged.groupsField,
      restrictedModelTypes: merged.restrictedModelTypes,
      restrictedCommands: merged.restrictedCommands,
      approveRequiresExplicitGrant: merged.approveRequiresExplicitGrant,
      signalRequiresExplicitGrant: merged.signalRequiresExplicitGrant,
      tagRequiresExplicitGrant: merged.tagRequiresExplicitGrant,
    });

    const tokenSecretsKey = await checkTokenSecretsKey(
      parseTokenSecretsKeyConfig(
        configFile,
        options.config === undefined
          ? SERVE_CONFIG_PATH
          : resolveServePath(repoDir, options.config as string),
      ),
      repoDir,
    );
    const keyUsable = tokenSecretsKey?.status !== "failed";

    if (authConfig.mode !== "oauth") {
      const starts = keyUsable && grantsLoad;
      // check-config runs outside any host, so it cannot see a root address
      const adminWarnings = findIneffectiveAdmins({
        mode: authConfig.mode,
        admins: authConfig.admins,
        offersSignInExchange: false,
      });
      renderServeCheckConfig({
        passed: starts && routeFilesLoad,
        authMode: authConfig.mode,
        entries: [],
        allowedCollectives: [],
        wouldStart: starts,
        restrictionWarnings,
        ...(adminWarnings.length > 0 ? { adminWarnings } : {}),
        ...grantReport,
        ...webhookReport,
        ...(tokenSecretsKey ? { tokenSecretsKey } : {}),
      }, ctx.outputMode);
      if (!starts || !routeFilesLoad) Deno.exitCode = 1;
      return;
    }

    const providerUrl = authConfig.oauthProvider;
    // AuthRepository.load() returns the collective API key (issued by
    // SWAMP_CLUB_URL or the default server) when set, otherwise the stored
    // login.
    const creds = await new AuthRepository().load();
    const token = selectCheckConfigToken(
      providerUrl,
      creds
        ? {
          serverUrl: creds.serverUrl,
          apiKey: creds.apiKey,
          source: apiKeySourceName() ?? "login",
        }
        : null,
    );
    const { resolveUsername } = await import("../../serve/oauth_client.ts");
    const { checkAccessLists, findPersonalCollectives } = await import(
      "../../serve/oauth_access_list_resolution.ts"
    );
    // Looked up afresh, as the admin lists are: this command cannot read the
    // pins serve keeps, so a name serve recorded as missing may resolve here.
    const usernameIssues = await checkServeGrantFileUsernames(
      checkedGrantFiles,
      {
        resolve: async ({ names }) => {
          const answers = new Map<string, UsernameLookup>();
          for (const name of names) {
            try {
              const sub = await resolveUsername(
                providerUrl,
                name,
                token,
                AbortSignal.timeout(10_000),
              );
              answers.set(name, { status: "resolved", sub });
            } catch (err) {
              answers.set(name, {
                status: "unresolved",
                message: `${
                  err instanceof Error ? err.message : String(err)
                } (looked up with ${providerUrl}/api/auth/resolve-user)`,
              });
            }
          }
          return answers;
        },
      },
    );
    for (const issue of usernameIssues) grantErrors.push(issue);
    grantsLoad = grantErrors.length === 0;
    const check = await checkAccessLists(
      authConfig,
      (username) =>
        resolveUsername(
          providerUrl,
          username,
          token,
          AbortSignal.timeout(10_000),
        ),
      providerUrl,
    );
    const personalCollectives = await findPersonalCollectives(
      authConfig.allowedCollectives,
      authConfig.allowedUsers,
      (username) =>
        resolveUsername(
          providerUrl,
          username,
          token,
          AbortSignal.timeout(10_000),
        ),
    );
    const notFound = check.entries.filter((e) => e.status === "not-found");
    const clientSecretRefusal = checkOAuthClientSecret(
      options.oauthClientSecretFile as string | undefined,
      authConfig.oauthClientId,
    );
    const wouldStart = check.wouldStart && clientSecretRefusal === undefined;
    const passed = wouldStart && notFound.length === 0 && keyUsable &&
      grantsLoad && routeFilesLoad;

    renderServeCheckConfig({
      passed,
      authMode: authConfig.mode,
      oauthProvider: providerUrl,
      entries: check.entries,
      allowedCollectives: authConfig.allowedCollectives,
      wouldStart: wouldStart && keyUsable && grantsLoad,
      ...(personalCollectives.length > 0
        ? { personalCollectiveWarnings: personalCollectives }
        : {}),
      ...(check.refusal !== undefined
        ? { refusal: check.refusal }
        : clientSecretRefusal !== undefined
        ? { refusal: clientSecretRefusal }
        : {}),
      restrictionWarnings,
      ...grantReport,
      ...webhookReport,
      ...(tokenSecretsKey ? { tokenSecretsKey } : {}),
    }, ctx.outputMode);

    // The rendered result already says what failed; like `access can-i`,
    // report failure through the exit code rather than a second error.
    if (!passed) Deno.exitCode = 1;
  });
