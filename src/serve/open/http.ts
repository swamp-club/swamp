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

import { dirname, isAbsolute, join, resolve } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import {
  createAuthDeps,
  createExtensionListDeps,
  createLibSwampContext,
  createModelDeleteDeps,
  createRepoInitDeps,
  createVaultCreateDeps,
  createVaultListKeysDeps,
  createVaultPutDeps,
  extensionList,
  extensionSearch,
  type ExtensionSearchDeps,
  LocalEditsError,
  modelDelete,
  modelMethodDescribe,
  modelMethodRun,
  type ModelMethodRunDeps,
  repoInit,
  vaultCreate,
  vaultListKeys,
  vaultPut,
  vaultSearch,
  type VaultSearchDeps,
  whoami as authWhoami,
  workflowRun,
  type WorkflowRunDeps,
  workflowSearch,
  type WorkflowSearchDeps,
  zodToJsonSchema,
} from "../../libswamp/mod.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import type {
  JobRun,
  StepRun,
  WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import { WorkflowExecutionService } from "../../domain/workflows/execution_service.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { DefaultMethodExecutionService } from "../../domain/models/method_execution_service.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import { SecretRedactor } from "../../domain/secrets/mod.ts";
import type { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { createRepoMarkerLoader } from "../../infrastructure/persistence/repo_marker_loader.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { runFileSink } from "../../infrastructure/logging/logger.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { acquireModelLocks } from "../../cli/repo_context.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { OPEN_UI_HTML } from "./ui.ts";
import { FAVICON_SVG } from "./favicon.ts";

const logger = getSwampLogger(["serve", "open"]);

export interface DefinitionSummary {
  id: string;
  name: string;
  type: string;
}

export interface OpenServerState {
  repoDir: string | null;
  repoContext: RepositoryContext | null;
  datastoreConfig: DatastoreConfig | null;
  extClient: ExtensionApiClient;
  version: string;
  initializeRepo: (repoDir: string) => Promise<void>;
  installExtension: (name: string) => Promise<void>;
  createDefinition: (
    type: string,
    name: string,
    globalArguments?: Record<string, unknown>,
  ) => Promise<DefinitionSummary>;
  listDefinitionsByType: (type: string) => Promise<DefinitionSummary[]>;
}

interface InitializedDeps {
  repoDir: string;
  repoContext: RepositoryContext;
  datastoreConfig: DatastoreConfig;
  extClient: ExtensionApiClient;
}

function requireRepo(state: OpenServerState): InitializedDeps | null {
  if (!state.repoDir || !state.repoContext || !state.datastoreConfig) {
    return null;
  }
  return {
    repoDir: state.repoDir,
    repoContext: state.repoContext,
    datastoreConfig: state.datastoreConfig,
    extClient: state.extClient,
  };
}

function notInitializedResponse(): Response {
  return Response.json(
    { error: { message: "Repository not initialized" } },
    { status: 412 },
  );
}

/**
 * Rejects requests whose Origin header points at anywhere other than the
 * server itself. Defense in depth against DNS rebinding and a malicious
 * website in the user's browser making cross-origin `fetch` calls against
 * http://127.0.0.1:9191/api/*. The server already binds to 127.0.0.1 only,
 * but the CORS check adds another layer for mutating methods and any route
 * that can leak filesystem or repo data.
 */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  // Same-origin requests (navigations, favicon fetches) have no Origin
  // header — allow those through unconditionally.
  if (!origin) return true;
  try {
    const requestUrl = new URL(req.url);
    const originUrl = new URL(origin);
    return originUrl.host === requestUrl.host;
  } catch {
    return false;
  }
}

export async function handleOpenRequest(
  req: Request,
  state: OpenServerState,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (!originAllowed(req)) {
    return Response.json(
      { error: { message: "Cross-origin request rejected" } },
      { status: 403 },
    );
  }

  try {
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return new Response(OPEN_UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (req.method === "GET" && path === "/favicon.svg") {
      return new Response(FAVICON_SVG, {
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    if (req.method === "GET" && path === "/api/whoami") {
      return await handleWhoami();
    }

    if (req.method === "GET" && path === "/api/repo/status") {
      return Response.json({
        initialized: requireRepo(state) !== null,
        path: state.repoDir,
      });
    }

    if (req.method === "GET" && path === "/api/fs/list") {
      return await handleFsList(url.searchParams.get("path"));
    }

    if (req.method === "GET" && path === "/api/repo/discover") {
      return await handleRepoDiscover(url.searchParams.get("root"));
    }

    if (req.method === "PUT" && path === "/api/repo/meta") {
      return await handleRepoMetaPut(req);
    }

    if (req.method === "POST" && path === "/api/repo/init") {
      return await handleRepoInit(state, req);
    }

    if (req.method === "POST" && path === "/api/repo/use") {
      const body = await req.json() as { path?: string };
      if (!body.path || !isAbsolute(body.path)) {
        return Response.json(
          { error: { message: "Absolute path required" } },
          { status: 400 },
        );
      }
      try {
        await state.initializeRepo(body.path);
      } catch (e) {
        return Response.json(
          { error: { message: e instanceof Error ? e.message : String(e) } },
          { status: 400 },
        );
      }
      return Response.json({ ok: true, path: body.path });
    }

    if (req.method === "GET" && path === "/api/vault-types") {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return handleVaultTypeList();
    }
    const vaultTypeSchemaMatch = path.match(
      /^\/api\/vault-types\/(.+)\/schema$/,
    );
    if (req.method === "GET" && vaultTypeSchemaMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleVaultTypeSchema(
        decodeURIComponent(vaultTypeSchemaMatch[1]),
      );
    }
    if (req.method === "GET" && path === "/api/vault-types/registry") {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleVaultTypeRegistrySearch(state);
    }

    if (req.method === "GET" && path === "/api/vaults") {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleVaultList(deps);
    }
    if (req.method === "POST" && path === "/api/vaults") {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleVaultCreate(deps, req);
    }
    const vaultKeysMatch = path.match(/^\/api\/vaults\/([^/]+)\/keys$/);
    if (req.method === "POST" && vaultKeysMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleVaultPut(
        deps,
        decodeURIComponent(vaultKeysMatch[1]),
        req,
      );
    }

    if (req.method === "POST" && path === "/api/extensions/install") {
      if (!requireRepo(state)) return notInitializedResponse();
      return await handleExtensionInstall(state, req);
    }

    if (req.method === "GET" && path === "/api/types") {
      return await handleTypeList(url.searchParams.get("prefix"));
    }

    const typeDescribeMatch = path.match(/^\/api\/types\/([^/]+)\/describe$/);
    if (req.method === "GET" && typeDescribeMatch) {
      return await handleTypeDescribe(
        decodeURIComponent(typeDescribeMatch[1]),
      );
    }

    if (req.method === "GET" && path === "/api/definitions") {
      if (!requireRepo(state)) return notInitializedResponse();
      const type = url.searchParams.get("type");
      if (!type) {
        return Response.json(
          { error: { message: "type query parameter required" } },
          { status: 400 },
        );
      }
      const defs = await state.listDefinitionsByType(type);
      return Response.json({ definitions: defs });
    }

    if (req.method === "POST" && path === "/api/definitions") {
      if (!requireRepo(state)) return notInitializedResponse();
      return await handleDefinitionCreate(state, req);
    }

    const defByNameMatch = path.match(/^\/api\/definitions\/([^/]+)$/);
    if (req.method === "GET" && defByNameMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleDefinitionGet(
        deps,
        decodeURIComponent(defByNameMatch[1]),
      );
    }
    if (req.method === "PUT" && defByNameMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleDefinitionUpdate(
        deps,
        decodeURIComponent(defByNameMatch[1]),
        req,
      );
    }
    if (req.method === "DELETE" && defByNameMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleDefinitionDelete(
        deps,
        decodeURIComponent(defByNameMatch[1]),
      );
    }

    // Extension browse endpoints need a repo (installed extensions are per-repo)
    if (req.method === "GET" && path === "/api/extensions/installed") {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleInstalled(deps);
    }
    if (req.method === "GET" && path === "/api/extensions/search") {
      return await handleSearch(state, url.searchParams.get("q") ?? "");
    }
    const extDetailMatch = path.match(/^\/api\/extensions\/([^/]+)$/);
    if (req.method === "GET" && extDetailMatch) {
      return await handleExtensionDetail(
        state,
        decodeURIComponent(extDetailMatch[1]),
      );
    }

    const methodsMatch = path.match(/^\/api\/models\/([^/]+)\/methods$/);
    if (req.method === "GET" && methodsMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleListMethods(deps, decodeURIComponent(methodsMatch[1]));
    }

    const describeMatch = path.match(
      /^\/api\/models\/([^/]+)\/methods\/([^/]+)\/describe$/,
    );
    if (req.method === "GET" && describeMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleDescribe(
        deps,
        decodeURIComponent(describeMatch[1]),
        decodeURIComponent(describeMatch[2]),
      );
    }

    const historyMatch = path.match(/^\/api\/models\/([^/]+)\/history$/);
    if (req.method === "GET" && historyMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleHistory(deps, decodeURIComponent(historyMatch[1]));
    }

    const outputMatch = path.match(
      /^\/api\/models\/([^/]+)\/outputs\/([^/]+)$/,
    );
    if (req.method === "GET" && outputMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleOutputGet(
        deps,
        decodeURIComponent(outputMatch[1]),
        decodeURIComponent(outputMatch[2]),
      );
    }

    // ---- Workflows ----
    if (req.method === "GET" && path === "/api/workflows") {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleWorkflowList(deps);
    }
    const workflowGetMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
    if (req.method === "GET" && workflowGetMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleWorkflowGet(
        deps,
        decodeURIComponent(workflowGetMatch[1]),
      );
    }
    const workflowRunMatch = path.match(/^\/api\/workflows\/([^/]+)\/run$/);
    if (req.method === "POST" && workflowRunMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleWorkflowRun(
        deps,
        decodeURIComponent(workflowRunMatch[1]),
        req,
      );
    }
    const workflowHistoryMatch = path.match(
      /^\/api\/workflows\/([^/]+)\/history$/,
    );
    if (req.method === "GET" && workflowHistoryMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleWorkflowHistory(
        deps,
        decodeURIComponent(workflowHistoryMatch[1]),
      );
    }
    const workflowRunGetMatch = path.match(
      /^\/api\/workflows\/([^/]+)\/runs\/([^/]+)$/,
    );
    if (req.method === "GET" && workflowRunGetMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleWorkflowRunGet(
        deps,
        decodeURIComponent(workflowRunGetMatch[1]),
        decodeURIComponent(workflowRunGetMatch[2]),
      );
    }

    // ---- Reports ----
    if (req.method === "GET" && path === "/api/reports") {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return handleReportList();
    }

    const runMatch = path.match(
      /^\/api\/models\/([^/]+)\/methods\/([^/]+)\/run$/,
    );
    if (req.method === "POST" && runMatch) {
      const deps = requireRepo(state);
      if (!deps) return notInitializedResponse();
      return await handleRun(
        deps,
        decodeURIComponent(runMatch[1]),
        decodeURIComponent(runMatch[2]),
        req,
      );
    }

    return new Response("Not found", { status: 404 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error("Open request failed: {error}", { error: message });
    return Response.json({ error: { message } }, { status: 500 });
  }
}

// --- Filesystem browser ---

async function handleFsList(requestedPath: string | null): Promise<Response> {
  const base = requestedPath && requestedPath.length > 0
    ? resolve(requestedPath)
    : Deno.env.get("HOME") ?? "/";
  if (!isAbsolute(base)) {
    return Response.json(
      { error: { message: "Path must be absolute" } },
      { status: 400 },
    );
  }
  try {
    const stat = await Deno.stat(base);
    if (!stat.isDirectory) {
      return Response.json(
        { error: { message: "Not a directory" } },
        { status: 400 },
      );
    }
  } catch (e) {
    return Response.json(
      { error: { message: e instanceof Error ? e.message : String(e) } },
      { status: 400 },
    );
  }

  const markerRepo = new RepoMarkerRepository();
  const rawEntries: { name: string; isDir: boolean }[] = [];
  try {
    for await (const entry of Deno.readDir(base)) {
      if (entry.name.startsWith(".")) continue;
      rawEntries.push({ name: entry.name, isDir: entry.isDirectory });
    }
  } catch (e) {
    return Response.json(
      { error: { message: e instanceof Error ? e.message : String(e) } },
      { status: 400 },
    );
  }

  const entries = await Promise.all(rawEntries.map(async (e) => {
    let isSwamp = false;
    if (e.isDir) {
      try {
        isSwamp = await markerRepo.exists(
          RepoPath.create(resolve(base, e.name)),
        );
      } catch {
        isSwamp = false;
      }
    }
    return { ...e, isSwamp };
  }));
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  let currentIsSwamp = false;
  try {
    currentIsSwamp = await markerRepo.exists(RepoPath.create(base));
  } catch {
    currentIsSwamp = false;
  }

  const parent = dirname(base);
  return Response.json({
    path: base,
    parent: parent === base ? null : parent,
    isSwamp: currentIsSwamp,
    entries,
  });
}

const DISCOVER_SKIP = new Set([
  "node_modules",
  "Library",
  ".Trash",
  "target",
  "dist",
  "build",
  ".git",
  ".cache",
]);

interface RepoMeta {
  name?: string;
  description?: string;
  tags?: string[];
}

function repoMetaPath(repoDir: string): string {
  return join(repoDir, ".swamp", "serve_open_meta.yaml");
}

async function readRepoMeta(repoDir: string): Promise<RepoMeta> {
  try {
    const text = await Deno.readTextFile(repoMetaPath(repoDir));
    const parsed = parseYaml(text) as RepoMeta | null;
    return parsed ?? {};
  } catch {
    return {};
  }
}

async function writeRepoMeta(repoDir: string, meta: RepoMeta): Promise<void> {
  const path = repoMetaPath(repoDir);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, stringifyYaml(meta));
}

async function handleRepoMetaPut(req: Request): Promise<Response> {
  const body = await req.json() as {
    path?: string;
    name?: string;
    description?: string;
    tags?: string[];
  };
  if (!body.path || !isAbsolute(body.path)) {
    return Response.json(
      { error: { message: "Absolute path required" } },
      { status: 400 },
    );
  }
  const markerRepo = new RepoMarkerRepository();
  const isSwamp = await markerRepo.exists(RepoPath.create(body.path));
  if (!isSwamp) {
    return Response.json(
      { error: { message: "Not a swamp repository" } },
      { status: 400 },
    );
  }
  // Bound the sidecar to reasonable sizes so a runaway client can't write
  // megabyte-scale YAML into the repo metadata file.
  const META_NAME_MAX = 200;
  const META_DESC_MAX = 2000;
  const META_TAG_MAX = 64;
  const META_TAGS_MAX_COUNT = 64;

  const meta: RepoMeta = {};
  if (typeof body.name === "string" && body.name !== "") {
    meta.name = body.name.slice(0, META_NAME_MAX);
  }
  if (typeof body.description === "string" && body.description !== "") {
    meta.description = body.description.slice(0, META_DESC_MAX);
  }
  if (Array.isArray(body.tags) && body.tags.length > 0) {
    meta.tags = body.tags
      .slice(0, META_TAGS_MAX_COUNT)
      .map((t) => String(t).slice(0, META_TAG_MAX))
      .filter((t) => t.length > 0);
  }
  try {
    await writeRepoMeta(body.path, meta);
  } catch (e) {
    return Response.json(
      { error: { message: e instanceof Error ? e.message : String(e) } },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, meta });
}

async function loadConfiguredRepoPaths(): Promise<string[]> {
  // Optional user config at $XDG_CONFIG_HOME/swamp/index.yaml
  // (falls back to ~/.config/swamp/index.yaml).
  // Shape: { repos: string[] }
  const home = Deno.env.get("HOME") ?? "";
  const xdg = Deno.env.get("XDG_CONFIG_HOME") ?? join(home, ".config");
  const cfgPath = join(xdg, "swamp", "index.yaml");
  try {
    const text = await Deno.readTextFile(cfgPath);
    const parsed = parseYaml(text) as { repos?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.repos)) return [];
    return parsed.repos
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((p) => (p.startsWith("~/") ? join(home, p.slice(2)) : p))
      .map((p) => resolve(p));
  } catch {
    return [];
  }
}

async function handleRepoDiscover(root: string | null): Promise<Response> {
  const base = root && root.length > 0
    ? resolve(root)
    : Deno.env.get("HOME") ?? "/";
  const markerRepo = new RepoMarkerRepository();
  const found: { path: string; meta: RepoMeta }[] = [];
  const seenPaths = new Set<string>();
  const maxDepth = 4;

  // Seed with repos from the optional user config. These are added first
  // and deduped against the filesystem walk, so explicitly-configured repos
  // always show up even if they live outside the discover root.
  const configured = await loadConfiguredRepoPaths();
  for (const path of configured) {
    try {
      const isSwamp = await markerRepo.exists(RepoPath.create(path));
      if (!isSwamp) continue;
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      const meta = await readRepoMeta(path);
      found.push({ path, meta });
    } catch {
      // skip unreadable entries
    }
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    // Record this dir if it's a swamp — but keep descending so we can find
    // any nested swamps inside (users can have multiple sibling repos under
    // a parent that also happens to be a swamp).
    try {
      const isSwamp = await markerRepo.exists(RepoPath.create(dir));
      if (isSwamp && !seenPaths.has(dir)) {
        seenPaths.add(dir);
        const meta = await readRepoMeta(dir);
        found.push({ path: dir, meta });
      }
    } catch {
      return;
    }
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    const subdirs = entries.filter((e) =>
      e.isDirectory && !e.name.startsWith(".") && !DISCOVER_SKIP.has(e.name)
    );
    // Bound concurrency to avoid filesystem storms.
    const limit = 8;
    for (let i = 0; i < subdirs.length; i += limit) {
      await Promise.all(
        subdirs.slice(i, i + limit).map((e) =>
          walk(resolve(dir, e.name), depth + 1)
        ),
      );
    }
  }

  try {
    await walk(base, 0);
  } catch {
    // best-effort
  }
  found.sort((a, b) => a.path.localeCompare(b.path));
  return Response.json({ root: base, repos: found });
}

async function handleRepoInit(
  state: OpenServerState,
  req: Request,
): Promise<Response> {
  const body = await req.json() as { path?: string; tool?: string };
  if (!body.path || !isAbsolute(body.path)) {
    return Response.json(
      { error: { message: "Absolute path required" } },
      { status: 400 },
    );
  }

  const ctx = createLibSwampContext();
  const deps = createRepoInitDeps(state.version);
  for await (
    const event of repoInit(ctx, deps, {
      path: body.path,
      force: false,
      tool: body.tool ?? "claude",
      version: state.version,
    })
  ) {
    if (event.kind === "error") {
      return Response.json({ error: event.error }, { status: 400 });
    }
    if (event.kind === "completed") {
      try {
        await state.initializeRepo(event.data.path);
      } catch (e) {
        return Response.json(
          {
            error: {
              message: `Repo initialized but failed to load context: ${
                e instanceof Error ? e.message : String(e)
              }`,
            },
          },
          { status: 500 },
        );
      }
      return Response.json({ ok: true, path: event.data.path });
    }
  }
  return Response.json(
    { error: { message: "unexpected init outcome" } },
    { status: 500 },
  );
}

function handleVaultTypeList(): Response {
  // Fully-loaded types
  const loaded = vaultTypeRegistry.getAll().map((t) => ({
    type: t.type,
    name: t.name,
    description: t.description,
    isBuiltIn: t.isBuiltIn,
    installed: true,
  }));
  // Lazy types — indexed but not imported
  const lazy = vaultTypeRegistry.getAllLazy().map((l) => ({
    type: l.type,
    name: l.type,
    description: l.description ?? "",
    isBuiltIn: false,
    installed: true,
    lazy: true,
  }));
  const seen = new Set(loaded.map((t) => t.type));
  for (const l of lazy) if (!seen.has(l.type)) loaded.push(l);
  return Response.json({ types: loaded });
}

async function handleVaultTypeSchema(type: string): Promise<Response> {
  // Lazy-load the bundle if only indexed.
  try {
    await vaultTypeRegistry.ensureTypeLoaded(type);
  } catch { /* best-effort */ }
  const info = vaultTypeRegistry.get(type);
  if (!info) {
    return Response.json(
      { error: { message: `Unknown vault type: ${type}` } },
      { status: 404 },
    );
  }
  let schema: unknown = null;
  if (info.configSchema) {
    try {
      schema = zodToJsonSchema(info.configSchema);
    } catch (e) {
      return Response.json(
        { error: { message: e instanceof Error ? e.message : String(e) } },
        { status: 500 },
      );
    }
  }
  return Response.json({
    type: info.type,
    name: info.name,
    description: info.description,
    isBuiltIn: info.isBuiltIn,
    configSchema: schema,
  });
}

async function handleVaultTypeRegistrySearch(
  state: OpenServerState,
): Promise<Response> {
  // Search swamp-club for extensions that provide vault providers.
  const searchDeps: ExtensionSearchDeps = {
    searchExtensions: (params) =>
      state.extClient.searchExtensions({
        ...params,
        contentType: ["vaults"],
        sort: "name",
      }),
  };
  const ctx = createLibSwampContext();
  for await (
    const event of extensionSearch(ctx, searchDeps, { perPage: 100 })
  ) {
    if (event.kind === "completed") {
      return Response.json({ results: event.data.results });
    }
    if (event.kind === "error") {
      return Response.json({ error: event.error }, { status: 500 });
    }
  }
  return Response.json({ results: [] });
}

async function handleVaultList(deps: InitializedDeps): Promise<Response> {
  const ctx = createLibSwampContext();
  const configRepo = new YamlVaultConfigRepository(deps.repoDir);
  const searchDeps: VaultSearchDeps = {
    findAllVaults: async () => {
      const all = await configRepo.findAll();
      return all.map((v) => ({
        id: v.id,
        name: v.name,
        type: v.type,
        createdAt: new Date(),
      }));
    },
  };
  const vaults: { name: string; type: string; keys: string[] }[] = [];
  for await (const event of vaultSearch(ctx, searchDeps, {})) {
    if (event.kind === "completed") {
      for (const v of event.data.results) {
        let keys: string[] = [];
        try {
          const listDeps = await createVaultListKeysDeps(deps.repoDir);
          for await (
            const ev of vaultListKeys(ctx, listDeps, { vaultName: v.name })
          ) {
            if (ev.kind === "completed") keys = ev.data.secretKeys;
          }
        } catch {
          keys = [];
        }
        vaults.push({ name: v.name, type: v.type, keys });
      }
    }
    if (event.kind === "error") {
      return Response.json({ error: event.error }, { status: 500 });
    }
  }
  return Response.json({ vaults });
}

async function handleVaultCreate(
  deps: InitializedDeps,
  req: Request,
): Promise<Response> {
  const body = await req.json() as {
    name?: string;
    type?: string;
    config?: Record<string, unknown>;
  };
  if (!body.name) {
    return Response.json({
      error: { message: "name required" },
    }, { status: 400 });
  }
  const vaultType = body.type ?? "local_encryption";
  const createDeps = await createVaultCreateDeps(deps.repoDir);
  const ctx = createLibSwampContext();
  for await (
    const event of vaultCreate(ctx, createDeps, {
      vaultType,
      name: body.name,
      config: body.config,
      repoDir: deps.repoDir,
    })
  ) {
    if (event.kind === "completed") {
      return Response.json({ vault: event.data });
    }
    if (event.kind === "error") {
      return Response.json({ error: event.error }, { status: 400 });
    }
  }
  return Response.json({ error: { message: "unexpected" } }, { status: 500 });
}

async function handleVaultPut(
  deps: InitializedDeps,
  vaultName: string,
  req: Request,
): Promise<Response> {
  const body = await req.json() as {
    key?: string;
    value?: string;
    overwrite?: boolean;
  };
  if (!body.key || body.value === undefined) {
    return Response.json({
      error: { message: "key and value required" },
    }, { status: 400 });
  }
  const putDeps = createVaultPutDeps(deps.repoDir, deps.repoContext.eventBus);
  const ctx = createLibSwampContext();
  for await (
    const event of vaultPut(ctx, putDeps, {
      vaultName,
      key: body.key,
      value: body.value,
      overwritten: body.overwrite ?? false,
    })
  ) {
    if (event.kind === "completed") {
      return Response.json({ ok: true });
    }
    if (event.kind === "error") {
      return Response.json({ error: event.error }, { status: 400 });
    }
  }
  return Response.json({ error: { message: "unexpected" } }, { status: 500 });
}

function handleTypeList(prefix: string | null): Response {
  const all = modelRegistry.types().map((t) => t.normalized);
  if (!prefix) return Response.json({ types: all });
  const matches = all.filter((t) => t === prefix || t.startsWith(prefix + "/"))
    .sort();
  return Response.json({ types: matches });
}

async function handleTypeDescribe(typeArg: string): Promise<Response> {
  let modelType;
  try {
    modelType = ModelType.create(typeArg);
  } catch (e) {
    return Response.json(
      { error: { message: e instanceof Error ? e.message : String(e) } },
      { status: 400 },
    );
  }
  const modelDef = await resolveModelType(modelType, getAutoResolver());
  if (!modelDef) {
    const available = modelRegistry.types().map((t) => t.normalized);
    return Response.json({
      error: {
        message:
          `Unknown model type: ${typeArg}. Registry contains ${available.length} types: ${
            available.slice(0, 20).join(", ")
          }${available.length > 20 ? "…" : ""}`,
      },
    }, { status: 404 });
  }
  const globalArguments = modelDef.globalArguments
    ? zodToJsonSchema(modelDef.globalArguments)
    : null;
  return Response.json({
    type: modelType.normalized,
    version: modelDef.version,
    globalArguments,
    methods: Object.keys(modelDef.methods),
  });
}

async function handleExtensionDetail(
  state: OpenServerState,
  name: string,
): Promise<Response> {
  try {
    // Basic metadata is anonymous — always available.
    const info = await state.extClient.getExtension(name);
    if (!info) {
      return Response.json({
        error: { message: `Extension not found: ${name}` },
      }, { status: 404 });
    }

    // Try to enrich with the `latest` version detail (which contains
    // the content metadata: models, workflows, vaults, reports, skills,
    // etc). This endpoint requires auth; fall back gracefully if the
    // user isn't logged in.
    let latestDetail: unknown = null;
    try {
      const auth = await new AuthRepository().load();
      if (auth) {
        const serverUrl = auth.serverUrl;
        const res = await fetch(
          new URL(
            `/api/v1/extensions/${encodeURIComponent(name)}/latest`,
            serverUrl,
          ),
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${auth.apiKey}`,
              "Accept": "application/json",
            },
            // CLAUDE.md requires outbound network calls to pass an
            // AbortSignal with a timeout.
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (res.ok) {
          const body = await res.json();
          latestDetail = body.latestVersionDetail ?? null;
        } else {
          await res.body?.cancel();
        }
      }
    } catch { /* keep anonymous fallback */ }

    // The ExtensionInfo type from the client only declares the minimum
    // fields; the server actually returns a richer payload (labels,
    // platforms, contentTypes, createdAt, updatedAt, author, …). Treat
    // the response as a loose record so we can forward those fields
    // to the UI without losing type safety on the known ones.
    const rich = info as unknown as Record<string, unknown>;
    return Response.json({
      ...rich,
      latestVersionDetail: latestDetail,
    });
  } catch (e) {
    return Response.json(
      { error: { message: e instanceof Error ? e.message : String(e) } },
      { status: 500 },
    );
  }
}

async function handleExtensionInstall(
  state: OpenServerState,
  req: Request,
): Promise<Response> {
  const body = await req.json() as { name?: string };
  if (!body.name) {
    return Response.json(
      { error: { message: "name required" } },
      { status: 400 },
    );
  }
  try {
    await state.installExtension(body.name);
  } catch (e) {
    // LocalEditsError → 409 Conflict so the UI can distinguish a refusal
    // (user must act: edit elsewhere or opt in via --force from the
    // terminal) from an unexpected server error. swamp-club#129.
    if (e instanceof LocalEditsError) {
      return Response.json(
        { error: { message: e.message } },
        { status: 409 },
      );
    }
    return Response.json(
      { error: { message: e instanceof Error ? e.message : String(e) } },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, restartRequired: true });
}

async function handleDefinitionGet(
  deps: InitializedDeps,
  idOrName: string,
): Promise<Response> {
  const result = await findDefinitionByIdOrName(
    deps.repoContext.definitionRepo,
    idOrName,
  );
  if (!result) {
    return Response.json({
      error: { message: `Model not found: ${idOrName}` },
    }, { status: 404 });
  }
  return Response.json({
    id: result.definition.id,
    name: result.definition.name,
    type: result.type.normalized,
    globalArguments: result.definition.globalArguments,
  });
}

async function handleDefinitionUpdate(
  deps: InitializedDeps,
  idOrName: string,
  req: Request,
): Promise<Response> {
  const body = await req.json() as {
    name?: string;
    globalArguments?: Record<string, unknown>;
  };
  if (!body.globalArguments || typeof body.globalArguments !== "object") {
    return Response.json({
      error: { message: "globalArguments required" },
    }, { status: 400 });
  }
  const result = await findDefinitionByIdOrName(
    deps.repoContext.definitionRepo,
    idOrName,
  );
  if (!result) {
    return Response.json({
      error: { message: `Model not found: ${idOrName}` },
    }, { status: 404 });
  }
  const { type } = result;
  let def = result.definition;
  const newName = body.name?.trim();
  const renamed = newName !== undefined && newName !== "" &&
    newName !== def.name;

  if (renamed) {
    // Check the new name isn't already taken by a different definition.
    const existing = await deps.repoContext.definitionRepo.findByNameGlobal(
      newName!,
    );
    if (existing && existing.definition.id !== def.id) {
      return Response.json(
        { error: { message: `Name already in use: ${newName}` } },
        { status: 409 },
      );
    }
    // Rebuild the Definition via fromData with the updated name. This
    // preserves the ID (so the YAML file stays the same on disk and run
    // history carries over) and just rewrites the name field.
    const data = def.toData();
    data.name = newName!;
    def = Definition.fromData(data);
  }

  // Clear existing globalArgs that were removed, then set new ones.
  for (const key of Object.keys(def.globalArguments)) {
    def.removeGlobalArgument(key);
  }
  for (const [key, value] of Object.entries(body.globalArguments)) {
    def.setGlobalArgument(key, value);
  }

  try {
    await deps.repoContext.definitionRepo.save(type, def);
  } catch (e) {
    return Response.json(
      { error: { message: e instanceof Error ? e.message : String(e) } },
      { status: 500 },
    );
  }
  return Response.json({
    id: def.id,
    name: def.name,
    type: type.normalized,
    globalArguments: def.globalArguments,
  });
}

async function handleDefinitionDelete(
  deps: InitializedDeps,
  idOrName: string,
): Promise<Response> {
  const deleteDeps = createModelDeleteDeps(deps.repoDir);
  const ctx = createLibSwampContext();
  for await (
    const event of modelDelete(ctx, deleteDeps, {
      modelIdOrName: idOrName,
      force: true,
    })
  ) {
    if (event.kind === "completed") {
      return Response.json({ ok: true, data: event.data });
    }
    if (event.kind === "error") {
      return Response.json({ error: event.error }, { status: 400 });
    }
  }
  return Response.json({ error: { message: "unexpected" } }, { status: 500 });
}

async function handleDefinitionCreate(
  state: OpenServerState,
  req: Request,
): Promise<Response> {
  const body = await req.json() as {
    type?: string;
    name?: string;
    globalArguments?: Record<string, unknown>;
  };
  if (!body.type || !body.name) {
    return Response.json(
      { error: { message: "type and name required" } },
      { status: 400 },
    );
  }
  try {
    const def = await state.createDefinition(
      body.type,
      body.name,
      body.globalArguments,
    );
    return Response.json({ definition: def });
  } catch (e) {
    return Response.json(
      { error: { message: e instanceof Error ? e.message : String(e) } },
      { status: 400 },
    );
  }
}

// --- Extension endpoints ---

async function handleInstalled(deps: InitializedDeps): Promise<Response> {
  const listDeps = await createExtensionListDeps(deps.repoDir);
  const ctx = createLibSwampContext();
  for await (const event of extensionList(ctx, listDeps)) {
    if (event.kind === "completed") {
      return Response.json({ extensions: event.data.extensions });
    }
    if (event.kind === "error") {
      return Response.json({ error: event.error }, { status: 500 });
    }
  }
  return Response.json({ extensions: [] });
}

async function handleSearch(
  state: OpenServerState,
  query: string,
): Promise<Response> {
  const searchDeps: ExtensionSearchDeps = {
    searchExtensions: (params) =>
      state.extClient.searchExtensions({
        ...params,
        sort: params.sort as
          | "name"
          | "relevance"
          | "new"
          | "updated"
          | undefined,
      }),
  };
  const ctx = createLibSwampContext();
  for await (
    const event of extensionSearch(ctx, searchDeps, {
      query: query || undefined,
      perPage: 50,
    })
  ) {
    if (event.kind === "completed") {
      return Response.json({ results: event.data.results });
    }
    if (event.kind === "error") {
      return Response.json({ error: event.error }, { status: 500 });
    }
  }
  return Response.json({ results: [] });
}

// --- Model endpoints ---

async function handleListMethods(
  deps: InitializedDeps,
  modelIdOrName: string,
): Promise<Response> {
  const result = await findDefinitionByIdOrName(
    deps.repoContext.definitionRepo,
    modelIdOrName,
  );
  if (!result) {
    return Response.json({
      error: { message: `Model not found: ${modelIdOrName}` },
    }, { status: 404 });
  }
  const modelDef = await resolveModelType(result.type, null);
  if (!modelDef) {
    return Response.json({
      error: { message: `Unknown model type: ${result.type.normalized}` },
    }, { status: 404 });
  }
  return Response.json({
    modelName: result.definition.name,
    modelType: result.type.normalized,
    methods: Object.keys(modelDef.methods),
  });
}

async function handleDescribe(
  deps: InitializedDeps,
  modelIdOrName: string,
  methodName: string,
): Promise<Response> {
  const ctx = createLibSwampContext();
  const describeDeps = {
    lookupDefinition: (idOrName: string) =>
      findDefinitionByIdOrName(deps.repoContext.definitionRepo, idOrName),
    resolveModelType: (type: { normalized: string }) =>
      resolveModelType(type as Parameters<typeof resolveModelType>[0], null),
  };
  for await (
    const event of modelMethodDescribe(
      ctx,
      describeDeps,
      modelIdOrName,
      methodName,
    )
  ) {
    if (event.kind === "completed") {
      return Response.json(event.data);
    }
    if (event.kind === "error") {
      return Response.json({ error: event.error }, { status: 404 });
    }
  }
  return Response.json({ error: { message: "unexpected" } }, { status: 500 });
}

async function handleHistory(
  deps: InitializedDeps,
  modelIdOrName: string,
): Promise<Response> {
  const result = await findDefinitionByIdOrName(
    deps.repoContext.definitionRepo,
    modelIdOrName,
  );
  if (!result) {
    return Response.json({
      error: { message: `Model not found: ${modelIdOrName}` },
    }, { status: 404 });
  }
  const outputs = await deps.repoContext.outputRepo.findByDefinition(
    result.type,
    result.definition.id,
  );
  const runs = outputs
    .map((o) => ({
      id: String(o.id),
      methodName: o.methodName,
      status: o.status,
      startedAt: o.startedAt.toISOString(),
      durationMs: o.durationMs,
    }))
    .sort((a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  return Response.json({ runs });
}

async function handleWhoami(): Promise<Response> {
  const ctx = createLibSwampContext();
  const deps = createAuthDeps();
  const fallbackOsUser = () =>
    Deno.env.get("USER") ?? Deno.env.get("USERNAME") ?? null;
  try {
    for await (const event of authWhoami(ctx, deps)) {
      if (event.kind === "completed") {
        return Response.json({
          authenticated: true,
          user: event.identity.username,
          name: event.identity.name,
          email: event.identity.email,
          collectives: event.identity.collectives ?? [],
        });
      }
      if (event.kind === "error") {
        return Response.json({
          authenticated: false,
          user: fallbackOsUser(),
          error: event.error.message,
        });
      }
    }
  } catch (e) {
    return Response.json({
      authenticated: false,
      user: fallbackOsUser(),
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return Response.json({ authenticated: false, user: fallbackOsUser() });
}

async function handleWorkflowList(
  deps: InitializedDeps,
): Promise<Response> {
  const ctx = createLibSwampContext();
  const searchDeps: WorkflowSearchDeps = {
    findAllWorkflows: () =>
      deps.repoContext.workflowRepo.findAll() as unknown as Promise<
        Array<{
          id: string;
          name: string;
          description?: string;
          jobs: readonly unknown[];
        }>
      >,
  };
  for await (const event of workflowSearch(ctx, searchDeps, {})) {
    if (event.kind === "completed") {
      return Response.json({ workflows: event.data.results });
    }
    if (event.kind === "error") {
      return Response.json({ error: event.error }, { status: 500 });
    }
  }
  return Response.json({ workflows: [] });
}

async function handleWorkflowGet(
  deps: InitializedDeps,
  idOrName: string,
): Promise<Response> {
  // Bypass workflowGet and read the raw Workflow object so we can include
  // per-job and per-step dependsOn (which WorkflowGetData doesn't expose).
  const repo = deps.repoContext.workflowRepo;
  const wf = (await repo.findByName(idOrName)) ??
    (await repo.findById(createWorkflowId(idOrName)));
  if (!wf) {
    return Response.json({
      error: { message: `Workflow not found: ${idOrName}` },
    }, { status: 404 });
  }
  return Response.json({
    id: wf.id,
    name: wf.name,
    description: wf.description,
    version: wf.version,
    path: repo.getPath(wf.id),
    jobs: wf.jobs.map((job) => ({
      name: job.name,
      description: job.description,
      dependsOn: (job.dependsOn ?? []).map((d) => d.job),
      steps: job.steps.map((step) => ({
        name: step.name,
        description: step.description,
        dependsOn: (step.dependsOn ?? []).map((d) => d.step),
        task: step.task.toData(),
      })),
    })),
  });
}

function workflowRunSummary(run: WorkflowRun) {
  const started = run.startedAt?.getTime() ?? null;
  const completed = run.completedAt?.getTime() ?? null;
  return {
    id: run.id,
    workflowName: run.workflowName,
    status: run.status,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    durationMs: started !== null && completed !== null
      ? completed - started
      : null,
    jobCount: run.jobs.length,
  };
}

async function handleWorkflowHistory(
  deps: InitializedDeps,
  idOrName: string,
): Promise<Response> {
  const repo = deps.repoContext.workflowRepo;
  const wf = (await repo.findByName(idOrName)) ??
    (await repo.findById(createWorkflowId(idOrName)));
  if (!wf) {
    return Response.json({
      error: { message: `Workflow not found: ${idOrName}` },
    }, { status: 404 });
  }
  const runs = await deps.repoContext.workflowRunRepo.findAllByWorkflowId(
    wf.id,
  );
  return Response.json({
    runs: runs.map((r) => workflowRunSummary(r)),
  });
}

async function handleWorkflowRunGet(
  deps: InitializedDeps,
  workflowIdOrName: string,
  runId: string,
): Promise<Response> {
  const repo = deps.repoContext.workflowRepo;
  const wf = (await repo.findByName(workflowIdOrName)) ??
    (await repo.findById(createWorkflowId(workflowIdOrName)));
  if (!wf) {
    return Response.json({
      error: { message: `Workflow not found: ${workflowIdOrName}` },
    }, { status: 404 });
  }
  const runs = await deps.repoContext.workflowRunRepo.findAllByWorkflowId(
    wf.id,
  );
  const match = runs.find((r) => String(r.id) === runId);
  if (!match) {
    return Response.json({
      error: { message: `Run not found: ${runId}` },
    }, { status: 404 });
  }
  const started = match.startedAt?.getTime() ?? null;
  const completed = match.completedAt?.getTime() ?? null;
  const jobs = match.jobs.map((job: JobRun) => {
    const jStart = job.startedAt?.getTime() ?? null;
    const jDone = job.completedAt?.getTime() ?? null;
    return {
      name: job.jobName,
      status: job.status,
      durationMs: jStart !== null && jDone !== null ? jDone - jStart : null,
      steps: job.steps.map((step: StepRun) => {
        const sStart = step.startedAt?.getTime() ?? null;
        const sDone = step.completedAt?.getTime() ?? null;
        return {
          name: step.stepName,
          status: step.status,
          error: step.error,
          durationMs: sStart !== null && sDone !== null ? sDone - sStart : null,
          dataArtifacts: step.dataArtifacts,
        };
      }),
    };
  });
  return Response.json({
    id: match.id,
    workflowName: match.workflowName,
    status: match.status,
    startedAt: match.startedAt?.toISOString() ?? null,
    completedAt: match.completedAt?.toISOString() ?? null,
    durationMs: started !== null && completed !== null
      ? completed - started
      : null,
    jobs,
  });
}

async function handleWorkflowRun(
  deps: InitializedDeps,
  idOrName: string,
  req: Request,
): Promise<Response> {
  const body = await req.json() as { inputs?: Record<string, unknown> };
  const inputs = body.inputs ?? {};

  const runDeps: WorkflowRunDeps = {
    workflowRepo: deps.repoContext.workflowRepo,
    runRepo: deps.repoContext.workflowRunRepo,
    repoDir: deps.repoDir,
    lookupWorkflow: async (repo, needle) => {
      return await repo.findByName(needle) ??
        await repo.findById(createWorkflowId(needle));
    },
    createExecutionService: (wfRepo, rnRepo, dir, catalogStore) =>
      new WorkflowExecutionService(
        wfRepo,
        rnRepo,
        dir,
        undefined,
        undefined,
        catalogStore,
      ),
    catalogStore: deps.repoContext.catalogStore,
    dataRepo: deps.repoContext.unifiedDataRepo,
    definitionRepo: deps.repoContext.definitionRepo,
  };

  const ctx = createLibSwampContext({ signal: req.signal });
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(obj)}\n\n`),
        );
      };
      try {
        for await (
          const event of workflowRun(ctx, runDeps, {
            workflowIdOrName: idOrName,
            inputs,
          })
        ) {
          send(event);
        }
      } catch (e) {
        send({
          kind: "error",
          error: { message: e instanceof Error ? e.message : String(e) },
        });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

function handleReportList(): Response {
  const reports = reportRegistry.getAll().map(({ name, report }) => ({
    name,
    description: report.description,
    scope: report.scope,
    labels: (report as unknown as { labels?: string[] }).labels ?? [],
  }));
  return Response.json({ reports });
}

async function handleOutputGet(
  deps: InitializedDeps,
  modelIdOrName: string,
  outputId: string,
): Promise<Response> {
  const result = await findDefinitionByIdOrName(
    deps.repoContext.definitionRepo,
    modelIdOrName,
  );
  if (!result) {
    return Response.json({
      error: { message: `Model not found: ${modelIdOrName}` },
    }, { status: 404 });
  }
  const outputs = await deps.repoContext.outputRepo.findByDefinition(
    result.type,
    result.definition.id,
  );
  const output = outputs.find((o) => String(o.id) === outputId);
  if (!output) {
    return Response.json({
      error: { message: `Output not found: ${outputId}` },
    }, { status: 404 });
  }
  const decoder = new TextDecoder();
  const artifacts: Array<{
    name: string;
    version: number;
    tags: Record<string, string>;
    attributes?: unknown;
    preview?: string;
    error?: string;
  }> = [];
  for (const ref of output.artifacts.dataArtifacts) {
    try {
      const content = await deps.repoContext.unifiedDataRepo.getContent(
        result.type,
        result.definition.id,
        ref.name,
        ref.version,
      );
      if (!content) {
        artifacts.push({
          name: ref.name,
          version: ref.version,
          tags: ref.tags,
          error: "content unavailable",
        });
        continue;
      }
      const text = decoder.decode(content);
      let attributes: unknown;
      try {
        attributes = JSON.parse(text);
      } catch {
        // Not JSON — fall back to raw text preview.
      }
      artifacts.push({
        name: ref.name,
        version: ref.version,
        tags: ref.tags,
        attributes,
        preview: attributes === undefined ? text.slice(0, 4000) : undefined,
      });
    } catch (e) {
      artifacts.push({
        name: ref.name,
        version: ref.version,
        tags: ref.tags,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return Response.json({
    id: String(output.id),
    methodName: output.methodName,
    status: output.status,
    startedAt: output.startedAt.toISOString(),
    completedAt: output.completedAt?.toISOString(),
    durationMs: output.durationMs,
    error: output.error ?? null,
    logFile: output.logFile ?? null,
    artifacts,
  });
}

async function handleRun(
  deps: InitializedDeps,
  modelIdOrName: string,
  methodName: string,
  req: Request,
): Promise<Response> {
  const body = await req.json() as { inputs?: Record<string, unknown> };
  const inputs = body.inputs ?? {};

  const preResult = await findDefinitionByIdOrName(
    deps.repoContext.definitionRepo,
    modelIdOrName,
  );
  if (!preResult) {
    return Response.json({
      error: { message: `Model not found: ${modelIdOrName}` },
    }, { status: 404 });
  }

  const lockResult = await acquireModelLocks(deps.datastoreConfig, [
    {
      modelType: preResult.type.normalized,
      modelId: preResult.definition.id,
    },
  ], deps.repoDir);
  if (lockResult.synced) deps.repoContext.catalogStore.invalidate();
  const flushLocks = lockResult.flush;

  const runDeps = buildRunDeps(deps);
  const ctx = createLibSwampContext({ signal: req.signal });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(obj)}\n\n`),
        );
      };
      try {
        for await (
          const event of modelMethodRun(ctx, runDeps, {
            modelIdOrName,
            methodName,
            inputs,
            lastEvaluated: false,
          })
        ) {
          send(event);
        }
      } catch (e) {
        send({
          kind: "error",
          error: { message: e instanceof Error ? e.message : String(e) },
        });
      } finally {
        try {
          await flushLocks();
        } catch (releaseError) {
          logger.warn("Failed to release locks: {error}", {
            error: releaseError instanceof Error
              ? releaseError.message
              : String(releaseError),
          });
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

function buildRunDeps(deps: InitializedDeps): ModelMethodRunDeps {
  const { repoDir, repoContext } = deps;
  const loadRepoMarker = createRepoMarkerLoader(
    new RepoMarkerRepository(),
    repoDir,
  );
  return {
    repoDir,
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(repoContext.definitionRepo, idOrName),
    getModelDef: (type) => resolveModelType(type, getAutoResolver()),
    createEvaluationService: () => {
      const dqs = new DataQueryService(
        repoContext.catalogStore,
        repoContext.unifiedDataRepo,
      );
      return new ExpressionEvaluationService(
        repoContext.definitionRepo,
        repoDir,
        {
          dataRepo: repoContext.unifiedDataRepo,
          dataQueryService: dqs,
        },
      );
    },
    loadEvaluatedDefinition: (type, name) =>
      repoContext.evaluatedDefinitionRepo.findByName(type, name),
    saveEvaluatedDefinition: (type, definition) =>
      repoContext.evaluatedDefinitionRepo.save(type, definition),
    createExecutionService: () => new DefaultMethodExecutionService(),
    createVaultService: () => VaultService.fromRepository(repoDir),
    dataRepo: repoContext.unifiedDataRepo,
    definitionRepo: repoContext.definitionRepo,
    outputRepo: repoContext.outputRepo,
    dataQueryService: new DataQueryService(
      repoContext.catalogStore,
      repoContext.unifiedDataRepo,
    ),
    loadRepoMarker,
    createRunLog: async (modelType, method, definitionId) => {
      const redactor = new SecretRedactor();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFilePath = join(
        swampPath(repoDir, SWAMP_SUBDIRS.outputs),
        modelType.normalized,
        method,
        `${definitionId}-${timestamp}.log`,
      );
      const logCategory: string[] = [];
      await runFileSink.register(
        logCategory,
        logFilePath,
        redactor,
        swampPath(repoDir),
      );
      return {
        logFilePath,
        redactor,
        cleanup: () => runFileSink.unregister(logCategory),
      };
    },
  };
}
