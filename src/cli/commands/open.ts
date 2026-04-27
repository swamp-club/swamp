// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { join, resolve } from "@std/path";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { driverTypeRegistry } from "../../domain/drivers/driver_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { openBrowser } from "../../infrastructure/process/browser.ts";
import {
  handleOpenRequest,
  type OpenServerState,
} from "../../serve/open/http.ts";
import {
  createLibSwampContext,
  createModelCreateDeps,
  detectLocalEditsForExtension,
  LocalEditsError,
  modelCreate,
} from "../../libswamp/mod.ts";
import { pullExtension } from "./extension_pull.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import {
  configureExtensionAutoResolver,
  configureExtensionLoaders,
  type DeferredWarning,
} from "../mod.ts";
import { resolveSkillsDir } from "../../domain/repo/skill_dirs.ts";
import { VERSION } from "./version.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const logger = getSwampLogger(["open"]);

function forceExtensionCatalogRescan(repoDir: string): void {
  try {
    const dbPath = swampPath(repoDir, "_extension_catalog.db");
    const catalog = new ExtensionCatalogStore(dbPath);
    try {
      catalog.invalidate("model");
      catalog.invalidate("vault");
      catalog.invalidate("driver");
      catalog.invalidate("datastore");
      catalog.invalidate("report");
    } finally {
      catalog.close();
    }
  } catch {
    // Best-effort — the loader will bootstrap a fresh catalog if this fails.
  }
}

async function reloadExtensionRegistries(): Promise<void> {
  // Force the registries to re-run their loaders so newly pulled
  // extensions are picked up without restarting the server.
  modelRegistry.resetLoadedFlag();
  vaultTypeRegistry.resetLoadedFlag();
  driverTypeRegistry.resetLoadedFlag();
  reportRegistry.resetLoadedFlag();
  await Promise.all([
    modelRegistry.ensureLoaded(),
    vaultTypeRegistry.ensureLoaded(),
    driverTypeRegistry.ensureLoaded(),
    reportRegistry.ensureLoaded(),
  ]);
}

async function loadRepoIntoState(
  state: OpenServerState,
  repoDir: string,
  outputMode: "log" | "json",
): Promise<void> {
  const result = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode,
  });
  state.repoDir = result.repoDir;
  state.repoContext = result.repoContext;
  state.datastoreConfig = result.datastoreConfig;
  state.syncService = result.syncService ?? null;

  // Reconfigure the extension loaders/auto-resolver for this repo — the CLI
  // bootstrap wired them to whatever directory the binary was launched from,
  // which may not be the repo the user picked in the UI.
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(RepoPath.create(result.repoDir));
  const deferred: DeferredWarning[] = [];
  await configureExtensionLoaders(result.repoDir, marker, [], deferred);
  configureExtensionAutoResolver(result.repoDir, marker, undefined, outputMode);
  forceExtensionCatalogRescan(result.repoDir);
  await reloadExtensionRegistries();
}

export const openCommand = new Command()
  .name("open")
  .description(
    "Start a local web UI for browsing extensions, workflows, vaults, and reports",
  )
  .example("Open the current repo", "swamp open")
  .example(
    "Browse without a repo (picker mode)",
    "cd /tmp && swamp open",
  )
  .example("Point at a specific repo", "swamp open --repo-dir /path/to/repo")
  .example("Custom port", "swamp open --port 9192")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--port <port:number>", "Port to listen on", { default: 9191 })
  .option("--no-open", "Do not auto-open the browser")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["open"]);
    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const port = options.port as number;
    const isJson = ctx.outputMode === "json";

    await Promise.all([
      modelRegistry.ensureLoaded(),
      vaultTypeRegistry.ensureLoaded(),
      driverTypeRegistry.ensureLoaded(),
      reportRegistry.ensureLoaded(),
    ]);

    const extClient = new ExtensionApiClient(
      Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL,
    );

    const state: OpenServerState = {
      repoDir: null,
      repoContext: null,
      datastoreConfig: null,
      syncService: null,
      extClient,
      version: VERSION,
      initializeRepo: async (path: string) => {
        await loadRepoIntoState(state, path, ctx.outputMode);
      },
      installExtension: async (name: string) => {
        if (!state.repoDir) throw new Error("Repository not initialized");
        const repoDir = state.repoDir;
        const repoPath = RepoPath.create(repoDir);
        const markerRepo = new RepoMarkerRepository();
        const marker = await markerRepo.read(repoPath);
        const modelsDir = resolveModelsDir(marker);
        const absoluteModelsDir = resolve(repoDir, modelsDir);
        const lockfilePath = join(
          absoluteModelsDir,
          "upstream_extensions.json",
        );
        // Refuse to silently overwrite local edits. The web UI install path
        // runs with force:true (no stdin for the "overwrite?" prompt), so
        // the force-pull is the only thing protecting user edits from
        // silent loss (swamp-club#129, sibling of #121/#126). The check
        // covers only the top-level extension the user clicked; dependency
        // re-install is already short-circuited in installExtension when a
        // dep is present in upstream_extensions.json, so dependency edits
        // are not at risk through this surface.
        const editsStatus = await detectLocalEditsForExtension(
          repoDir,
          name,
          lockfilePath,
        );
        if (editsStatus === "mismatch") {
          throw new LocalEditsError(name);
        }
        await pullExtension(
          { name, version: null },
          {
            getExtension: (n) => extClient.getExtension(n),
            downloadArchive: (n, v) => extClient.downloadArchive(n, v),
            getChecksum: (n, v) => extClient.getChecksum(n, v),
            logger: ctx.logger,
            lockfilePath,
            skillsDir: resolveSkillsDir(repoDir, marker?.tool ?? "claude"),
            repoDir,
            // Force overwrite — the web UI has no stdin to answer the
            // "overwrite existing files?" prompt, so we always install
            // non-interactively. Local-edits protection runs above.
            force: true,
            outputMode: ctx.outputMode,
            alreadyPulled: new Set(),
            depth: 0,
          },
        );
        await reloadExtensionRegistries();
      },
      createDefinition: async (type, name, globalArguments) => {
        if (!state.repoDir) throw new Error("Repository not initialized");
        const deps = await createModelCreateDeps(state.repoDir);
        const libCtx = createLibSwampContext();
        for await (
          const event of modelCreate(libCtx, deps, {
            typeArg: type,
            name,
            globalArguments,
          })
        ) {
          if (event.kind === "completed") {
            return {
              id: event.data.id,
              name: event.data.name,
              type: event.data.type,
            };
          }
          if (event.kind === "error") {
            throw new Error(event.error.message);
          }
        }
        throw new Error("Model create did not complete");
      },
      listDefinitionsByType: async (typeArg: string) => {
        if (!state.repoContext) throw new Error("Repository not initialized");
        const modelType = ModelType.create(typeArg);
        const defs = await state.repoContext.definitionRepo.findAll(modelType);
        return defs.map((d) => ({
          id: d.id,
          name: d.name,
          type: modelType.normalized,
        }));
      },
    };

    try {
      await loadRepoIntoState(state, repoDir, ctx.outputMode);
      ctx.logger.info`Loaded repository at ${state.repoDir}`;
    } catch (e) {
      ctx.logger
        .info`No initialized repository found — starting in picker mode (${
        e instanceof Error ? e.message : String(e)
      })`;
    }

    const ac = new AbortController();
    const server = Deno.serve(
      {
        port,
        hostname: "127.0.0.1",
        signal: ac.signal,
        onListen({ hostname, port: listenPort }) {
          const url = `http://${hostname}:${listenPort}`;
          if (isJson) {
            console.log(JSON.stringify({
              status: "listening",
              host: hostname,
              port: listenPort,
              url,
            }));
          } else {
            logger.info("swamp open listening on {url}", { url });
          }
          if (options.open !== false) {
            openBrowser(url).catch((e) => {
              logger.warn("Failed to open browser: {error}", {
                error: e instanceof Error ? e.message : String(e),
              });
            });
          }
        },
      },
      (req) => handleOpenRequest(req, state),
    );

    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (isJson) {
        console.log(JSON.stringify({ status: "stopping" }));
      }
      logger.info("Shutting down...");
      ac.abort();
      if (isJson) {
        console.log(JSON.stringify({ status: "stopped" }));
      }
    };
    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);

    await server.finished;
    if (state.repoContext) {
      state.repoContext.catalogStore.close();
    }
  });
