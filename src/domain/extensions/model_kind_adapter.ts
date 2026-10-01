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

import { z } from "zod";
import { dirname, join, resolve } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { isZodSchemaLike } from "../zod_compat.ts";
import { bundleExtension } from "../models/bundle.ts";
import { ModelType } from "../models/model_type.ts";
import { CalVer } from "../models/calver.ts";
import {
  type CheckDefinition,
  type CheckResult,
  type DataHandle,
  type ExtensionMemberSet,
  FileOutputSpecSchema,
  type MethodContext,
  type MethodDefinition,
  type MethodKind,
  type MethodResult,
  type ModelDefinition,
  modelRegistry,
  type ResourceOutputSpec,
  ResourceOutputSpecSchema,
  type VersionUpgrade,
} from "../models/model.ts";
import type {
  ExtensionCatalogStore,
  ExtensionTypeRow,
} from "../../infrastructure/persistence/extension_catalog_store.ts";
import {
  bundleNamespace,
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import type {
  ExtensionLoadResult,
  KindAdapter,
  RegistrationContext,
  ValidationResult,
} from "./kind_adapter.ts";
import {
  declaresExport,
  EXPORT_DECLARATION_PATTERNS,
  sourceFromExportDeclaration,
} from "./export_declaration.ts";
import { emitExtensionLoadWarning } from "../../infrastructure/logging/extension_load_warnings.ts";
import { parseExtensionManifest } from "./extension_manifest.ts";
import {
  compareExtensionPrecedence,
  contributorTier,
  type ExtensionContributor,
} from "./extension_precedence.ts";
import { evictRemovedBundles } from "./bundle_eviction.ts";
import { realCanonicalPath } from "../../infrastructure/persistence/canonicalize_path.ts";
import { markErrorPaths } from "../errors.ts";

const logger = getLogger(["swamp", "models", "loader"]);

/**
 * The extension rows targeting `typeNormalized` whose source still exists.
 * Rows whose source is gone are deleted, along with their bundles: a
 * surviving bundle would attach old code, and a missing one fails with
 * ENOENT when it is rebuilt (swamp-club#2490).
 */
function liveExtensionRows(
  catalog: ExtensionCatalogStore,
  typeNormalized: string,
): ExtensionTypeRow[] {
  const live: ExtensionTypeRow[] = [];
  const removed: ExtensionTypeRow[] = [];
  for (const row of catalog.findExtensionsForType(typeNormalized)) {
    try {
      Deno.statSync(row.source_path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        catalog.removeByRawSourcePath(row.source_path);
        removed.push(row);
        continue;
      }
    }
    live.push(row);
  }
  evictRemovedBundles(removed, catalog);
  return live;
}

const attachedExtensions: Map<string, Map<string, string>> = new Map();

/** The kind of member an extension adds to a model type. */
export type ExtensionMemberKind = "method" | "check" | "resource";

/**
 * Which extension contributed a member, and the exact definition object it
 * contributed. The definition reference tells an extension member apart
 * from a base-model member that happens to share its name: a member whose
 * current registry definition is not the recorded one did not come from
 * the recorded extension (swamp-club#2562).
 */
interface MemberProvenance {
  readonly contributor: ExtensionContributor;
  readonly definition: unknown;
}

/** type -> `${kind}:${name}` -> provenance. */
const memberProvenance: Map<string, Map<string, MemberProvenance>> = new Map();

/**
 * A member name that more than one source provides for one model type, as
 * currently resolved. `winner` is the winning extension's canonical source
 * path, or null when a base-model member wins.
 */
export interface ExtensionMemberCollision {
  readonly type: string;
  readonly memberKind: ExtensionMemberKind;
  readonly name: string;
  readonly winner: string | null;
  readonly losers: readonly string[];
}

interface CollisionState {
  winner: string | null;
  losers: Set<string>;
}

/** type -> `${kind}:${name}` -> current collision state. */
const memberCollisions: Map<string, Map<string, CollisionState>> = new Map();

export function clearAttachedExtensions(): void {
  attachedExtensions.clear();
  memberProvenance.clear();
  memberCollisions.clear();
}

export function removeAttachedExtensionsForType(
  typeNormalized: string,
): void {
  attachedExtensions.delete(typeNormalized);
  memberProvenance.delete(typeNormalized);
  memberCollisions.delete(typeNormalized);
}

/**
 * Detaches from one model type the members that removed extension
 * sources added, leaving the base type and every other extension's
 * members in place (swamp-club#2745). A member a removed source had won
 * from another extension is freed: that extension loses its attached
 * mark, so the next attach pass processes it again and claims the name.
 *
 * `isRemoved` is asked about both spellings of a source: the catalog's
 * (attach marks) and the symlink-resolved one (member provenance and
 * collisions).
 *
 * @returns true when anything was detached or unmarked
 */
export function detachExtensionSources(
  typeNormalized: string,
  isRemoved: (sourcePath: string) => boolean,
): boolean {
  let changed = false;

  const provenance = memberProvenance.get(typeNormalized);
  if (provenance) {
    const members: ExtensionMemberSet = {};
    const sets: Record<ExtensionMemberKind, keyof ExtensionMemberSet> = {
      method: "methods",
      check: "checks",
      resource: "resources",
    };
    for (const [key, prov] of provenance) {
      if (!isRemoved(prov.contributor.sourcePath)) continue;
      const sep = key.indexOf(":");
      const set = sets[key.slice(0, sep) as ExtensionMemberKind];
      const bucket = (members[set] ??= {}) as Record<string, unknown>;
      bucket[key.slice(sep + 1)] = prov.definition;
      provenance.delete(key);
      changed = true;
    }
    modelRegistry.removeExtensionMembers(typeNormalized, members);
  }

  const freedLosers = new Set<string>();
  const collisions = memberCollisions.get(typeNormalized);
  if (collisions) {
    for (const [key, state] of collisions) {
      for (const loser of state.losers) {
        if (!isRemoved(loser)) continue;
        state.losers.delete(loser);
        changed = true;
      }
      if (state.winner !== null && isRemoved(state.winner)) {
        for (const loser of state.losers) freedLosers.add(loser);
        collisions.delete(key);
        changed = true;
      } else if (state.losers.size === 0) {
        collisions.delete(key);
      }
    }
  }

  const attached = attachedExtensions.get(typeNormalized);
  if (attached) {
    for (const sourcePath of [...attached.keys()]) {
      if (
        isRemoved(sourcePath) ||
        freedLosers.has(realCanonicalPath(sourcePath))
      ) {
        attached.delete(sourcePath);
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Every extension-member collision as currently resolved, sorted by type,
 * kind and name. Read by `swamp doctor extensions`; reflects attach state,
 * so it does not depend on warnings being re-emitted.
 */
export function getExtensionMemberCollisions(): ExtensionMemberCollision[] {
  const out: ExtensionMemberCollision[] = [];
  for (const [type, members] of memberCollisions) {
    for (const [key, state] of members) {
      if (state.losers.size === 0) continue;
      const sep = key.indexOf(":");
      out.push({
        type,
        memberKind: key.slice(0, sep) as ExtensionMemberKind,
        name: key.slice(sep + 1),
        winner: state.winner,
        losers: [...state.losers].sort(),
      });
    }
  }
  // Code-unit order, like compareExtensionPrecedence, so the listing is the
  // same on every host and locale.
  const byCodeUnit = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
  return out.sort((a, b) =>
    byCodeUnit(a.type, b.type) ||
    byCodeUnit(a.memberKind, b.memberKind) ||
    byCodeUnit(a.name, b.name)
  );
}

function collisionState(type: string, key: string): CollisionState {
  let members = memberCollisions.get(type);
  if (!members) {
    members = new Map();
    memberCollisions.set(type, members);
  }
  let state = members.get(key);
  if (!state) {
    state = { winner: null, losers: new Set() };
    members.set(key, state);
  }
  return state;
}

function recordCollision(
  type: string,
  key: string,
  winner: string | null,
  loser: string,
): void {
  const state = collisionState(type, key);
  if (state.winner !== null && state.winner !== winner) {
    state.losers.add(state.winner);
  }
  state.winner = winner;
  state.losers.add(loser);
  if (winner !== null) state.losers.delete(winner);
}

function precedenceReason(
  winner: ExtensionContributor,
  loser: ExtensionContributor,
): string {
  return winner.pulled !== loser.pulled
    ? `${contributorTier(winner)} beats ${contributorTier(loser)}`
    : "same origin; the alphabetically first path wins";
}

type MemberResolution =
  | { readonly action: "add" }
  | { readonly action: "base" }
  | { readonly action: "replace-self" }
  | { readonly action: "override"; readonly prior: ExtensionContributor }
  | { readonly action: "refuse"; readonly winner: ExtensionContributor };

/**
 * Decides what happens to one incoming member. Base-model members always
 * win; between extensions {@link compareExtensionPrecedence} decides, so
 * the outcome does not depend on attach order.
 */
function resolveMember(
  type: string,
  key: string,
  existing: unknown,
  contributor: ExtensionContributor,
): MemberResolution {
  if (existing === undefined) return { action: "add" };
  const prov = memberProvenance.get(type)?.get(key);
  if (!prov || prov.definition !== existing) return { action: "base" };
  if (prov.contributor.sourcePath === contributor.sourcePath) {
    return { action: "replace-self" };
  }
  if (compareExtensionPrecedence(contributor, prov.contributor) < 0) {
    return { action: "override", prior: prov.contributor };
  }
  return { action: "refuse", winner: prov.contributor };
}

function markExtensionAttached(
  typeNormalized: string,
  sourcePath: string,
  fingerprint: string,
): void {
  let paths = attachedExtensions.get(typeNormalized);
  if (!paths) {
    paths = new Map();
    attachedExtensions.set(typeNormalized, paths);
  }
  paths.set(sourcePath, fingerprint);
}

/**
 * Which catalog source an attach pass processed. `sourcePath` is the path
 * as the catalog spells it — the key `attachPendingExtensionsForType`
 * looks up — which can differ from the contributor's symlink-resolved
 * identity.
 */
export interface AttachRecord {
  readonly sourcePath: string;
  readonly fingerprint: string;
}

/**
 * Records that an extension file has been processed for a type: it goes
 * into `result.extended`, and — when the attach record is known — into
 * the attach map, so a later attach pass does not import it again.
 */
function recordAttached(
  result: ExtensionLoadResult,
  file: string,
  typeNormalized: string,
  attach: AttachRecord | undefined,
): void {
  result.extended.push(file);
  if (attach !== undefined) {
    markExtensionAttached(
      typeNormalized,
      attach.sourcePath,
      attach.fingerprint,
    );
  }
}

/**
 * Pairs catalog extension rows with their contributors, sorted winner
 * first by {@link compareExtensionPrecedence}.
 */
export function sortByPrecedence(
  rows: readonly ExtensionTypeRow[],
  contributorFor: (sourcePath: string) => ExtensionContributor,
): Array<{ entry: ExtensionTypeRow; contributor: ExtensionContributor }> {
  return rows
    .map((entry) => ({ entry, contributor: contributorFor(entry.source_path) }))
    .sort((a, b) => compareExtensionPrecedence(a.contributor, b.contributor));
}

function isExtensionAttached(
  typeNormalized: string,
  sourcePath: string,
  fingerprint: string | undefined,
): boolean {
  const recorded = attachedExtensions.get(typeNormalized)?.get(sourcePath);
  if (recorded === undefined) return false;
  if (fingerprint === undefined) return true;
  return recorded === fingerprint;
}

interface UserMethodResult {
  dataHandles?: DataHandle[];
  [key: string]: unknown;
}

type UserExecuteFn = (
  args: Record<string, unknown>,
  context: MethodContext,
) => Promise<UserMethodResult>;

const MethodKindSchema = z.enum([
  "create",
  "read",
  "update",
  "delete",
  "list",
  "action",
]);

const UserMethodSchema = z.object({
  description: z.string(),
  kind: MethodKindSchema.optional(),
  arguments: z.custom<z.ZodTypeAny>(isZodSchemaLike),
  execute: z.custom<UserExecuteFn>((val) => typeof val === "function"),
}).passthrough();

const UserUpgradeSchema = z.object({
  toVersion: z.string().refine(CalVer.isValid, {
    message: "toVersion must be valid CalVer (YYYY.MM.DD.MICRO)",
  }),
  description: z.string(),
  upgradeAttributes: z.custom<
    (old: Record<string, unknown>) => Record<string, unknown>
  >((val) => typeof val === "function"),
});

const UserCheckSchema = z.object({
  description: z.string(),
  labels: z.array(z.string()).optional(),
  appliesTo: z.array(z.string()).optional(),
  execute: z.custom<(context: MethodContext) => Promise<CheckResult>>(
    (val) => typeof val === "function",
  ),
});

const UserModelSchema = z.object({
  type: z.string(),
  version: z.string().refine(CalVer.isValid, {
    message: "version must be valid CalVer (YYYY.MM.DD.MICRO)",
  }),
  globalArguments: z.custom<z.ZodTypeAny>(isZodSchemaLike).optional(),
  resources: z.record(z.string(), ResourceOutputSpecSchema).optional(),
  files: z.record(z.string(), FileOutputSpecSchema).optional(),
  methods: z.record(z.string(), UserMethodSchema),
  checks: z.record(z.string(), UserCheckSchema).optional(),
  upgrades: z.array(UserUpgradeSchema).optional(),
  reports: z.array(z.string()).optional(),
}).superRefine((model, ctx) => {
  if (!model.upgrades || model.upgrades.length === 0) return;
  const last = model.upgrades[model.upgrades.length - 1];
  if (last.toVersion !== model.version) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `Last upgrade toVersion "${last.toVersion}" does not match model ` +
        `version "${model.version}". ` +
        `The upgrade chain must terminate at the current version.`,
    });
  }
});

const UserExtensionSchema = z.object({
  type: z.string(),
  resources: z.record(z.string(), ResourceOutputSpecSchema).optional(),
  methods: z.array(z.record(z.string(), UserMethodSchema)),
  checks: z.array(z.record(z.string(), UserCheckSchema)).optional(),
});

function formatUserModelError(error: z.ZodError): string {
  const issues = error.issues;

  const dataOutputSpecsIssue = issues.find(
    (i) => i.path[0] === "dataOutputSpecs" && i.code === "invalid_type",
  );
  if (dataOutputSpecsIssue) {
    return (
      "Missing required 'dataOutputSpecs' field. " +
      "Add dataOutputSpecs to declare what data your model produces.\n\n" +
      "Example:\n" +
      "  dataOutputSpecs: {\n" +
      "    result: {\n" +
      '      specType: "result",\n' +
      '      contentType: "application/json",\n' +
      '      lifetime: { type: "persistent" },\n' +
      '      garbageCollection: { type: "keep_latest", count: 10 },\n' +
      "      tags: {},\n" +
      "    },\n" +
      "  },"
    );
  }

  const methodArgsIssue = issues.find(
    (i) =>
      i.path[0] === "methods" && i.path.length >= 3 &&
      String(i.path[i.path.length - 1]) === "arguments",
  );
  if (methodArgsIssue) {
    const methodName = String(
      methodArgsIssue.path[methodArgsIssue.path.length - 2],
    );
    return (
      `Missing or invalid 'arguments' on method '${methodName}'. ` +
      "Add a Zod schema to validate method arguments.\n\n" +
      "Example:\n" +
      "  arguments: z.object({\n" +
      '    name: z.string().describe("Resource name"),\n' +
      "  }),"
    );
  }

  const methodExecuteIssue = issues.find(
    (i) =>
      i.path[0] === "methods" && i.path.length >= 3 &&
      String(i.path[i.path.length - 1]) === "execute",
  );
  if (methodExecuteIssue) {
    const methodName = String(
      methodExecuteIssue.path[methodExecuteIssue.path.length - 2],
    );
    return (
      `Missing or invalid 'execute' on method '${methodName}'. ` +
      "'execute' must be an async function.\n\n" +
      "Example:\n" +
      "  execute: async (args, context) => {\n" +
      "    // Your logic here\n" +
      "    return { dataHandles: [] };\n" +
      "  },"
    );
  }

  const methodKindIssue = issues.find(
    (i) =>
      i.path[0] === "methods" && i.path.length >= 3 &&
      String(i.path[i.path.length - 1]) === "kind",
  );
  if (methodKindIssue) {
    const methodName = String(
      methodKindIssue.path[methodKindIssue.path.length - 2],
    );
    return (
      `Invalid 'kind' value on method '${methodName}'. ` +
      "Allowed values: create, read, update, delete, list, action."
    );
  }

  const methodDescriptionIssue = issues.find(
    (i) =>
      i.path[0] === "methods" && i.path.length >= 3 &&
      String(i.path[i.path.length - 1]) === "description",
  );
  if (methodDescriptionIssue) {
    const methodName = String(
      methodDescriptionIssue.path[methodDescriptionIssue.path.length - 2],
    );
    return (
      `Missing 'description' on method '${methodName}'. ` +
      "Every method must have a description string.\n\n" +
      "Example:\n" +
      '  description: "Execute the model",'
    );
  }

  const typeIssue = issues.find((i) => i.path[0] === "type");
  if (typeIssue) {
    return (
      "Missing required 'type' field. " +
      "Add a namespaced type identifier.\n\n" +
      "Example:\n" +
      '  type: "@myorg/my-model",'
    );
  }

  const versionIssue = issues.find((i) => i.path[0] === "version");
  if (versionIssue) {
    return (
      "Missing or invalid 'version' field. " +
      "Use CalVer format: YYYY.MM.DD.MICRO.\n\n" +
      "Example:\n" +
      '  version: "2026.02.10.1",'
    );
  }

  const methodsMissingIssue = issues.find(
    (i) => i.path[0] === "methods" && i.path.length === 1,
  );
  if (methodsMissingIssue) {
    return (
      "Missing required 'methods' field. " +
      "Add at least one method to your model.\n\n" +
      "Example:\n" +
      "  methods: {\n" +
      "    run: {\n" +
      '      description: "Execute the model",\n' +
      "      arguments: z.object({}),\n" +
      "      execute: async (args, context) => {\n" +
      "        // Your logic here\n" +
      "        return { dataHandles: [] };\n" +
      "      },\n" +
      "    },\n" +
      "  },"
    );
  }

  const methodSubFieldIssue = issues.find(
    (i) => i.path[0] === "methods" && i.path.length > 1,
  );
  if (methodSubFieldIssue) {
    return `${
      methodSubFieldIssue.path.join(".")
    }: ${methodSubFieldIssue.message}`;
  }

  return issues
    .map((i) => {
      if (i.path.length === 0) return i.message;
      return `${i.path.join(".")}: ${i.message}`;
    })
    .join("; ");
}

function wrapUserExecute(
  userExecuteFn: UserExecuteFn,
): (
  args: Record<string, unknown>,
  context: MethodContext,
) => Promise<MethodResult> {
  return async (args, context): Promise<MethodResult> => {
    const userResult = await userExecuteFn(args, context);
    return { dataHandles: userResult.dataHandles };
  };
}

function convertToModelDefinition(
  userModel: z.infer<typeof UserModelSchema>,
): ModelDefinition {
  const modelType = ModelType.create(userModel.type);

  const methods: Record<string, MethodDefinition> = {};
  for (const [name, method] of Object.entries(userModel.methods)) {
    methods[name] = {
      description: method.description,
      ...(method.kind ? { kind: method.kind as MethodKind } : {}),
      ...(method.rollbackOnFailure != null
        ? { rollbackOnFailure: Boolean(method.rollbackOnFailure) }
        : {}),
      arguments: method.arguments,
      execute: wrapUserExecute(method.execute),
    };
  }

  const upgrades: VersionUpgrade[] | undefined = userModel.upgrades?.map(
    (u) => ({
      toVersion: u.toVersion,
      description: u.description,
      upgradeAttributes: u.upgradeAttributes,
    }),
  );

  const checks: Record<string, CheckDefinition> | undefined = userModel.checks
    ? Object.fromEntries(
      Object.entries(userModel.checks).map(([name, check]) => [
        name,
        {
          description: check.description,
          labels: check.labels,
          appliesTo: check.appliesTo,
          execute: check.execute,
        },
      ]),
    )
    : undefined;

  return {
    type: modelType,
    version: userModel.version,
    globalArguments: userModel.globalArguments,
    resources: userModel.resources,
    files: userModel.files,
    methods,
    ...(checks ? { checks } : {}),
    ...(upgrades && upgrades.length > 0 ? { upgrades } : {}),
    ...(userModel.reports ? { reports: userModel.reports } : {}),
  };
}

function validateUserCollective(rawType: string): string | undefined {
  const normalized = ModelType.create(rawType).normalized;
  const segmentCount = ModelType.getSegmentCount(normalized);
  if (segmentCount < 2) {
    return `Model type '${rawType}' must have at least 2 segments. Expected format: @<collective>/<name> or <collective>/<name> (e.g., @myorg/my-model or myorg/my-model)`;
  }
  return undefined;
}

interface ExtensionAssets {
  filesRoot: string;
  additionalFiles: string[];
}

const extensionAssetsCache = new Map<string, ExtensionAssets | undefined>();

function resolveExtensionAssets(
  sourcePath: string,
  repoDir: string | null,
): ExtensionAssets | undefined {
  let currentDir = dirname(sourcePath);
  const root = resolve("/");
  while (true) {
    const cached = extensionAssetsCache.get(currentDir);
    if (cached !== undefined) return cached;

    const manifestPath = join(currentDir, "manifest.yaml");
    try {
      Deno.lstatSync(manifestPath);
      const normalized = currentDir.replace(/\\/g, "/");
      const isPulled = normalized.includes(
        `/${SWAMP_DATA_DIR}/pulled-extensions/`,
      ) || normalized.includes(
        `/${SWAMP_DATA_DIR}/config/pulled-extensions/`,
      );
      const filesRoot = isPulled ? join(currentDir, "files") : currentDir;

      let additionalFiles: string[] = [];
      try {
        const content = Deno.readTextFileSync(manifestPath);
        const manifest = parseExtensionManifest(content);
        additionalFiles = manifest.additionalFiles;
      } catch {
        logger
          .warn`Failed to parse manifest at ${manifestPath} for additionalFiles; defaulting to empty`;
      }

      const result: ExtensionAssets = { filesRoot, additionalFiles };
      extensionAssetsCache.set(currentDir, result);
      return result;
    } catch {
      // Not here; walk up.
    }

    if (repoDir && resolve(currentDir) === resolve(repoDir)) break;
    const parent = dirname(currentDir);
    if (parent === currentDir || parent === root) return undefined;
    currentDir = parent;
  }
  return undefined;
}

function findNearestDenoConfig(
  absolutePath: string,
  repoDir: string | null,
): string | undefined {
  let dir = dirname(absolutePath);
  const root = resolve("/");
  while (dir !== root) {
    if (repoDir && resolve(dir) === resolve(repoDir)) break;

    for (const name of ["deno.json", "deno.jsonc"]) {
      const candidate = join(dir, name);
      try {
        Deno.statSync(candidate);
        return candidate;
      } catch {
        // Not found — keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export const modelKindAdapter: KindAdapter = {
  kind: "model",
  bundleSubdir: SWAMP_SUBDIRS.bundles,
  catalogKinds: ["model", "extension"],
  primaryExportKey: "model",
  secondaryExportKey: "extension",
  exportRegex: EXPORT_DECLARATION_PATTERNS.model,
  useResolver: true,

  validatePrimaryExport(exported: unknown): ValidationResult {
    const result = UserModelSchema.safeParse(exported);
    if (result.success) {
      return { success: true, data: result.data as Record<string, unknown> };
    }
    return { success: false, error: result.error };
  },

  validateSecondaryExport(exported: unknown): ValidationResult {
    const result = UserExtensionSchema.safeParse(exported);
    if (result.success) {
      return { success: true, data: result.data as Record<string, unknown> };
    }
    return { success: false, error: result.error };
  },

  formatValidationError: formatUserModelError,

  normalizeType(validated: Record<string, unknown>): string {
    return ModelType.create(String(validated.type)).normalized;
  },

  extractTypeFromSource(source: string) {
    const declaration = sourceFromExportDeclaration(
      source,
      EXPORT_DECLARATION_PATTERNS.model,
    );
    if (declaration === null) return null;
    const modelMatch = declaresExport(source, /export\s+const\s+model\s*[=:]/);
    const extensionMatch = declaresExport(
      source,
      /export\s+const\s+extension\s*[=:]/,
    );

    const typeMatch = declaration.match(
      /export\s+const\s+(?:model|extension)\b[\s\S]*?=\s*\{[\s\S]*?type\s*:\s*["']([^"']+)["']/,
    );
    if (!typeMatch) return null;

    const typeNormalized = ModelType.create(typeMatch[1]).normalized;
    const versionMatch = declaration.match(
      /export\s+const\s+(?:model|extension)\b[\s\S]*?=\s*\{[\s\S]*?version\s*:\s*["']([^"']+)["']/,
    );

    return {
      typeNormalized,
      version: versionMatch?.[1] ?? "",
      kind: extensionMatch && !modelMatch
        ? "extension" as const
        : "model" as const,
      extendsType: extensionMatch && !modelMatch ? typeNormalized : "",
    };
  },

  validateNamespace: validateUserCollective,

  register(
    _typeNormalized: string,
    validated: Record<string, unknown>,
    _module: Record<string, unknown>,
    context: RegistrationContext,
  ): void {
    const userModel = validated as z.infer<typeof UserModelSchema>;
    const modelDef = convertToModelDefinition(userModel);
    const assets = resolveExtensionAssets(
      context.absolutePath,
      context.repoDir,
    );
    modelDef.extensionFilesRoot = assets?.filesRoot;
    modelDef.extensionAdditionalFiles = assets?.additionalFiles;
    modelDef.extensionName = context.extensionName;
    modelDef.sourceFingerprint = context.sourceFingerprint;

    let bundlePromise: Promise<string> | undefined;
    modelDef.bundleSourceFactory = () => {
      bundlePromise ??= (async () => {
        const denoPath = await context.denoRuntime.ensureDeno();
        return bundleExtension(
          context.absolutePath,
          denoPath,
          { selfContained: true, env: context.denoRuntime.getDenoEnv() },
        );
      })().catch((error) => {
        bundlePromise = undefined;
        logger
          .warn`Failed to create self-contained bundle for ${context.absolutePath}: ${error}`;
        throw error;
      });
      return bundlePromise;
    };

    modelRegistry.register(modelDef);
  },

  registerLazy(entry: ExtensionTypeRow): void {
    modelRegistry.registerLazy({
      type: ModelType.create(entry.type_normalized),
      bundlePath: entry.bundle_path,
      sourcePath: entry.source_path,
      version: entry.version,
      sourceFingerprint: entry.source_fingerprint,
    });
  },

  updateSourceFingerprint(typeNormalized: string, fingerprint: string): void {
    const modelDef = modelRegistry.get(typeNormalized);
    if (modelDef) {
      modelDef.sourceFingerprint = fingerprint;
    }
  },

  promoteFromLazy(
    _typeNormalized: string,
    validated: Record<string, unknown>,
    _module: Record<string, unknown>,
    context: RegistrationContext,
  ): void {
    const userModel = validated as z.infer<typeof UserModelSchema>;
    const modelDef = convertToModelDefinition(userModel);
    const assets = resolveExtensionAssets(
      context.absolutePath,
      context.repoDir,
    );
    modelDef.extensionFilesRoot = assets?.filesRoot;
    modelDef.extensionAdditionalFiles = assets?.additionalFiles;
    modelDef.extensionName = context.extensionName;
    modelDef.sourceFingerprint = context.sourceFingerprint;

    let bundlePromise: Promise<string> | undefined;
    modelDef.bundleSourceFactory = () => {
      bundlePromise ??= (async () => {
        const denoPath = await context.denoRuntime.ensureDeno();
        return bundleExtension(
          context.absolutePath,
          denoPath,
          { selfContained: true, env: context.denoRuntime.getDenoEnv() },
        );
      })().catch((error) => {
        bundlePromise = undefined;
        logger
          .warn`Failed to create self-contained bundle for ${context.absolutePath}: ${error}`;
        throw error;
      });
      return bundlePromise;
    };

    modelRegistry.promoteFromLazy(modelDef);
  },

  hasType(typeNormalized: string): boolean {
    return modelRegistry.has(typeNormalized);
  },

  isFullyLoaded(typeNormalized: string): boolean {
    return modelRegistry.get(typeNormalized) !== undefined;
  },

  processSecondaryExport(
    file: string,
    exported: unknown,
    result: ExtensionLoadResult,
    contributor: ExtensionContributor,
    attach?: AttachRecord,
  ): void {
    const parsed = UserExtensionSchema.safeParse(exported);
    if (!parsed.success) {
      result.failed.push({ file, error: parsed.error.message });
      return;
    }

    const ext = parsed.data;

    const flatMethods: Record<string, z.infer<typeof UserMethodSchema>> = {};
    for (const methodRecord of ext.methods) {
      for (const [name, method] of Object.entries(methodRecord)) {
        if (Object.hasOwn(flatMethods, name)) {
          result.failed.push({
            file,
            error:
              `Duplicate method name '${name}' within extension methods array`,
          });
          return;
        }
        flatMethods[name] = method;
      }
    }

    const targetModel = modelRegistry.get(ext.type);
    if (!targetModel) {
      result.failed.push({
        file,
        error: `Cannot extend unregistered model type: ${ext.type}`,
      });
      return;
    }

    const typeKey = ModelType.create(ext.type).normalized;

    const incomingMethods: Record<string, MethodDefinition> = {};
    for (const [name, method] of Object.entries(flatMethods)) {
      incomingMethods[name] = {
        description: method.description,
        ...(method.kind ? { kind: method.kind as MethodKind } : {}),
        ...(method.rollbackOnFailure != null
          ? { rollbackOnFailure: Boolean(method.rollbackOnFailure) }
          : {}),
        arguments: method.arguments,
        execute: wrapUserExecute(method.execute),
      };
    }

    const incomingChecks: Record<string, CheckDefinition> = {};
    if (ext.checks && ext.checks.length > 0) {
      for (const checkRecord of ext.checks) {
        for (const [name, check] of Object.entries(checkRecord)) {
          if (Object.hasOwn(incomingChecks, name)) {
            result.failed.push({
              file,
              error:
                `Duplicate check name '${name}' within extension checks array`,
            });
            return;
          }
          incomingChecks[name] = {
            description: check.description,
            labels: check.labels,
            appliesTo: check.appliesTo,
            execute: check.execute,
          };
        }
      }
    }

    const incomingResources: Record<string, ResourceOutputSpec> = {
      ...(ext.resources ?? {}),
    };

    // Resolve every incoming member against what the type holds now, then
    // apply additions and overrides in one registry merge. Refused members
    // are recorded as they are resolved — they are not registered whatever
    // the merge does. Provenance, and the collisions an override creates,
    // change only after the merge succeeds.
    const additions: ExtensionMemberSet = {};
    const overrides: ExtensionMemberSet = {};
    const claimed: Array<{ key: string; definition: unknown }> = [];
    const overridden: Array<{
      key: string;
      label: string;
      name: string;
      prior: ExtensionContributor;
    }> = [];
    let collided = false;

    const sections: Array<{
      kind: ExtensionMemberKind;
      set: keyof ExtensionMemberSet;
      incoming: Record<string, unknown>;
      existing: Record<string, unknown>;
    }> = [
      {
        kind: "method",
        set: "methods",
        incoming: incomingMethods,
        existing: targetModel.methods,
      },
      {
        kind: "check",
        set: "checks",
        incoming: incomingChecks,
        existing: targetModel.checks ?? {},
      },
      {
        kind: "resource",
        set: "resources",
        incoming: incomingResources,
        existing: targetModel.resources ?? {},
      },
    ];

    for (const section of sections) {
      for (const [name, definition] of Object.entries(section.incoming)) {
        const key = `${section.kind}:${name}`;
        const resolution = resolveMember(
          typeKey,
          key,
          Object.hasOwn(section.existing, name)
            ? section.existing[name]
            : undefined,
          contributor,
        );
        const addTo = (target: ExtensionMemberSet) => {
          const bucket = (target[section.set] ??= {}) as Record<
            string,
            unknown
          >;
          bucket[name] = definition;
          claimed.push({ key, definition });
        };
        switch (resolution.action) {
          case "add":
            addTo(additions);
            break;
          case "replace-self":
            addTo(overrides);
            break;
          case "override":
            addTo(overrides);
            overridden.push({
              key,
              label: section.kind,
              name,
              prior: resolution.prior,
            });
            break;
          case "base":
            collided = true;
            recordCollision(typeKey, key, null, contributor.sourcePath);
            emitExtensionLoadWarning({
              kind: "extension",
              file: contributor.sourcePath,
              error:
                `${section.kind} '${name}' already exists on '${ext.type}' as a base model ${section.kind}, which wins; ${section.kind} not registered`,
              category: "MemberCollision",
            });
            break;
          case "refuse":
            collided = true;
            recordCollision(
              typeKey,
              key,
              resolution.winner.sourcePath,
              contributor.sourcePath,
            );
            emitExtensionLoadWarning({
              kind: "extension",
              file: contributor.sourcePath,
              error:
                `${section.kind} '${name}' on '${ext.type}' is also provided by ${resolution.winner.sourcePath}, which wins (${
                  precedenceReason(resolution.winner, contributor)
                }); ${section.kind} not registered`,
              category: "MemberCollision",
            });
            break;
        }
      }
    }

    if (claimed.length === 0) {
      if (collided) {
        recordAttached(result, file, typeKey, attach);
      } else if (attach !== undefined) {
        // Nothing to add, but the file was processed: mark it so later
        // attach passes do not import it again.
        markExtensionAttached(typeKey, attach.sourcePath, attach.fingerprint);
      }
      return;
    }

    try {
      modelRegistry.applyExtensionMembers(ext.type, additions, overrides);
    } catch (error) {
      result.failed.push({ file, error: String(error) });
      return;
    }

    let provenance = memberProvenance.get(typeKey);
    if (!provenance) {
      provenance = new Map();
      memberProvenance.set(typeKey, provenance);
    }
    for (const { key, definition } of claimed) {
      provenance.set(key, { contributor, definition });
    }
    for (const { key, label, name, prior } of overridden) {
      recordCollision(typeKey, key, contributor.sourcePath, prior.sourcePath);
      emitExtensionLoadWarning({
        kind: "extension",
        file: contributor.sourcePath,
        error:
          `${label} '${name}' on '${ext.type}' overrides the one from ${prior.sourcePath} (${
            precedenceReason(contributor, prior)
          })`,
        category: "MemberCollision",
      });
    }
    recordAttached(result, file, typeKey, attach);
  },

  findExtensionsForType(
    catalog: ExtensionCatalogStore,
    typeNormalized: string,
  ): ExtensionTypeRow[] {
    return liveExtensionRows(catalog, typeNormalized);
  },

  async importAndExtendBundle(
    entry: ExtensionTypeRow,
    importFn: (
      paths: {
        bundlePath: string;
        sourcePath: string;
        sourceFingerprint?: string;
      },
    ) => Promise<Record<string, unknown>>,
    result: ExtensionLoadResult,
    contributor: ExtensionContributor,
  ): Promise<void> {
    const module = await importFn({
      bundlePath: entry.bundle_path,
      sourcePath: entry.source_path,
      sourceFingerprint: entry.source_fingerprint || undefined,
    });

    if (!module.extension) {
      if (module.model) {
        logger
          .warn`Skipping standalone model bundle cataloged as extension: ${entry.bundle_path}`;
        // Mark it so every later attach pass does not re-import and re-warn.
        if (entry.extends_type) {
          markExtensionAttached(
            entry.extends_type,
            entry.source_path,
            entry.source_fingerprint ?? "",
          );
        }
        return;
      }
      throw markErrorPaths(
        new Error(
          `Bundle has no extension export: ${entry.bundle_path}`,
        ),
        [entry.bundle_path],
      );
    }

    modelKindAdapter.processSecondaryExport!(
      entry.source_path,
      module.extension,
      result,
      contributor,
      {
        sourcePath: entry.source_path,
        fingerprint: entry.source_fingerprint ?? "",
      },
    );

    for (const failure of result.failed) {
      logger
        .warn`Failed to extend model from ${failure.file}: ${failure.error}`;
    }
  },

  async attachPendingExtensionsForType(
    typeNormalized: string,
    catalog: ExtensionCatalogStore,
    importFn: (
      paths: {
        bundlePath: string;
        sourcePath: string;
        sourceFingerprint?: string;
      },
    ) => Promise<Record<string, unknown>>,
    contributorFor: (sourcePath: string) => ExtensionContributor,
  ): Promise<void> {
    const base = modelRegistry.get(typeNormalized);
    if (!base) return;

    // Attach the likely winner first so the common case needs no override.
    // The outcome does not depend on this order (swamp-club#2562).
    const extensions = sortByPrecedence(
      liveExtensionRows(catalog, typeNormalized),
      contributorFor,
    );
    for (const { entry, contributor } of extensions) {
      if (
        isExtensionAttached(
          typeNormalized,
          entry.source_path,
          entry.source_fingerprint,
        )
      ) continue;
      const result: ExtensionLoadResult = {
        loaded: [],
        extended: [],
        failed: [],
      };
      // One extension that fails to import must not stop the rest from
      // attaching (swamp-club#2557). It stays unmarked, so the next attach
      // pass retries it.
      // A processed extension is marked attached by processSecondaryExport.
      try {
        await modelKindAdapter.importAndExtendBundle!(
          entry,
          importFn,
          result,
          contributor,
        );
      } catch (error) {
        logger
          .warn`Skipping extension ${entry.source_path} for ${typeNormalized}: ${error}`;
        continue;
      }
    }
  },

  migrateOldFlatBundles(repoDir: string, additionalDirs?: string[]): void {
    const bundlesDir = join(repoDir, SWAMP_DATA_DIR, SWAMP_SUBDIRS.bundles);

    const pulledDir = additionalDirs?.find((d) =>
      d.includes("pulled-extensions")
    );
    const targetNs = pulledDir
      ? bundleNamespace(pulledDir, repoDir)
      : "_migrated";

    try {
      let migrated = 0;
      for (const entry of Deno.readDirSync(bundlesDir)) {
        if (entry.isFile && entry.name.endsWith(".js")) {
          const srcPath = join(bundlesDir, entry.name);
          const destDir = join(bundlesDir, targetNs);
          const destPath = join(destDir, entry.name);
          try {
            Deno.mkdirSync(destDir, { recursive: true });
            Deno.renameSync(srcPath, destPath);
            migrated++;
          } catch {
            // Best-effort — if move fails, leave the flat file
          }
        }
      }
      if (migrated > 0) {
        logger
          .warn`Migrated ${migrated} bundle file(s) to namespaced layout`;
      }
    } catch {
      // Bundles directory doesn't exist — nothing to migrate
    }
  },

  resolveDenoConfig: findNearestDenoConfig,
};
