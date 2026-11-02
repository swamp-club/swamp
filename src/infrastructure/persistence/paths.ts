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

import { dirname, isAbsolute, join, relative, resolve } from "@std/path";

export const SWAMP_DATA_DIR = ".swamp";

export const SWAMP_MARKER_FILE = ".swamp.yaml";

export const SWAMP_SOURCES_FILE = ".swamp-sources.yaml";

export const SWAMP_CUSTOM_TOOLS_FILE = ".swamp-custom-tools.yaml";

export const SWAMP_SUBDIRS = {
  definitions: "definitions",
  definitionsEvaluated: "definitions-evaluated",
  workflows: "workflows",
  workflowsEvaluated: "workflows-evaluated",
  workflowRuns: "workflow-runs",
  outputs: "outputs",
  data: "data",
  vault: "vault",
  secrets: "secrets",
  telemetry: "telemetry",
  logs: "logs",
  files: "files",
  inputs: "inputs",
  inputsEvaluated: "inputs-evaluated",
  bundles: "bundles",
  vaultBundles: "vault-bundles",
  datastoreBundles: "datastore-bundles",
  reportBundles: "report-bundles",
  webhookBundles: "webhook-bundles",
  autoDefinitions: "auto-definitions",
  audit: "audit",
  resources: "resources",
  pulledModels: "pulled-extensions/models",
  pulledVaults: "pulled-extensions/vaults",
  pulledWorkflows: "pulled-extensions/workflows",
  pulledDatastores: "pulled-extensions/datastores",
  pulledReports: "pulled-extensions/reports",
  pulledWebhooks: "pulled-extensions/webhooks",
  pulledSkills: "pulled-extensions/skills",
} as const;

// forward slashes match lockfile paths, which the lockfile reader and writer
// convert to forward slashes
const BUNDLE_ARTIFACT_PREFIXES: readonly string[] = [
  SWAMP_SUBDIRS.bundles,
  SWAMP_SUBDIRS.vaultBundles,
  SWAMP_SUBDIRS.datastoreBundles,
  SWAMP_SUBDIRS.reportBundles,
  SWAMP_SUBDIRS.webhookBundles,
].map((subdir) => `.swamp/${subdir}/`);

export function isBundleArtifactPath(relPath: string): boolean {
  return BUNDLE_ARTIFACT_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

const PULLED_SKILLS_PREFIX = `.swamp/${SWAMP_SUBDIRS.pulledSkills}/`;

/**
 * skills land in a dir shared across extensions, so another extension shipping
 * the same skill name raises a ConflictError
 */
export function isPulledSkillPath(relPath: string): boolean {
  return relPath.startsWith(PULLED_SKILLS_PREFIX);
}

export function pulledSkillDir(relPath: string): string | undefined {
  if (!isPulledSkillPath(relPath)) return undefined;
  const skill = relPath.slice(PULLED_SKILLS_PREFIX.length).split("/")[0];
  return skill ? `${PULLED_SKILLS_PREFIX}${skill}` : undefined;
}

export function swampPath(repoDir: string, ...segments: string[]): string {
  return join(repoDir, SWAMP_DATA_DIR, ...segments);
}

interface ManagedConfigRegistration {
  base: string;
  resolved: boolean;
}

/**
 * the last resolved registration wins and a fallback never overwrites a
 * resolved one, so the base cannot move from a resolved path back to a guess
 */
const managedConfigRegistry = new Map<
  string,
  ManagedConfigRegistration | false
>();

export function registerManagedConfig(
  repoDir: string,
  active: boolean,
  configBasePath?: string,
  resolved = true,
): void {
  if (active && !configBasePath) {
    throw new Error(
      "registerManagedConfig: active is true but configBasePath is missing",
    );
  }
  const key = resolve(repoDir);
  const existing = managedConfigRegistry.get(key);
  if (active && configBasePath) {
    if (!resolved && existing && existing.resolved) return;
    managedConfigRegistry.set(key, { base: configBasePath, resolved });
  } else if (existing === undefined) {
    managedConfigRegistry.set(key, false);
  }
}

export function isManagedConfig(repoDir: string): boolean {
  return Boolean(managedConfigRegistry.get(resolve(repoDir)));
}

export function getManagedConfigBase(repoDir: string): string | undefined {
  const val = managedConfigRegistry.get(resolve(repoDir));
  return val ? val.base : undefined;
}

/**
 * a lockfile in a managed config base locks a shared sibling named .lock, which
 * datastore sync excludes; a <lockfile>.lock in a cache could be pushed and
 * block other checkouts
 */
export function lockfileAdvisoryLockPath(lockfilePath: string): string {
  const target = resolve(lockfilePath);
  for (const registration of managedConfigRegistry.values()) {
    if (!registration) continue;
    const rel = relative(resolve(registration.base), target);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      return join(dirname(lockfilePath), ".lock");
    }
  }
  return `${lockfilePath}.lock`;
}

export function isManagedConfigBaseResolved(repoDir: string): boolean {
  const val = managedConfigRegistry.get(resolve(repoDir));
  return val ? val.resolved : false;
}

const managedConfigResolutionMemo = new Map<string, Promise<boolean>>();

/**
 * single-flight per repo; a failed outcome is not cached, so a later call
 * retries once the datastore extension is on disk
 */
export function resolveManagedConfigOnce(
  repoDir: string,
  resolveOnce: () => Promise<boolean>,
): Promise<boolean> {
  const key = resolve(repoDir);
  const inFlight = managedConfigResolutionMemo.get(key);
  if (inFlight) return inFlight;
  const attempt = resolveOnce().then(
    (resolved) => {
      if (!resolved) managedConfigResolutionMemo.delete(key);
      return resolved;
    },
    (error) => {
      managedConfigResolutionMemo.delete(key);
      throw error;
    },
  );
  managedConfigResolutionMemo.set(key, attempt);
  return attempt;
}

/**
 * clears the managed config registry and resolution memo; test-only, so tests
 * stay independent under --repeats
 */
export function resetManagedConfigRegistry(): void {
  managedConfigRegistry.clear();
  managedConfigResolutionMemo.clear();
}

export function resolveEffectiveDefinitionsDir(repoDir: string): string {
  const base = getManagedConfigBase(repoDir);
  return base ? join(base, "models") : join(repoDir, "models");
}

export function resolveEffectiveWorkflowsDir(repoDir: string): string {
  const base = getManagedConfigBase(repoDir);
  return base ? join(base, "workflows") : join(repoDir, "workflows");
}

export function resolveEffectiveVaultsDir(repoDir: string): string {
  const base = getManagedConfigBase(repoDir);
  return base ? join(base, "vaults") : join(repoDir, "vaults");
}

export function resolvePulledExtensionsRoot(
  repoDir: string,
): string {
  return isManagedConfig(repoDir)
    ? swampPath(repoDir, "config", "pulled-extensions")
    : swampPath(repoDir, "pulled-extensions");
}

/**
 * unlike resolvePulledExtensionsRoot, an unregistered repo is not assumed
 * unmanaged, so callers deleting rows under the other root can skip that step
 */
export function activePulledExtensionsRoot(
  repoDir: string,
): string | undefined {
  if (!managedConfigRegistry.has(resolve(repoDir))) return undefined;
  return resolvePulledExtensionsRoot(repoDir);
}

export function managedConfigLockfilePath(repoDir: string): string {
  return join(swampPath(repoDir, "config"), "upstream_extensions.json");
}

export function swampMarkerPath(repoDir: string): string {
  return join(repoDir, SWAMP_MARKER_FILE);
}

export function swampSourcesPath(repoDir: string): string {
  return join(repoDir, SWAMP_SOURCES_FILE);
}

export function swampCustomToolsPath(repoDir: string): string {
  return join(repoDir, SWAMP_CUSTOM_TOOLS_FILE);
}

/**
 * hashes the relative path so processes agree when the repo path resolves
 * differently through symlinks (macOS /var vs /private/var)
 */
export function bundleNamespace(baseDir: string, repoDir: string): string {
  const rel = relative(repoDir, baseDir);
  let hash = 0x811c9dc5;
  for (let i = 0; i < rel.length; i++) {
    hash ^= rel.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const EXTENSION_BUNDLE_KINDS = [
  { sourceKind: "models", bundleKind: "bundles" },
  { sourceKind: "vaults", bundleKind: "vault-bundles" },
  { sourceKind: "datastores", bundleKind: "datastore-bundles" },
  { sourceKind: "reports", bundleKind: "report-bundles" },
  { sourceKind: "webhooks", bundleKind: "webhook-bundles" },
] as const;

export interface ExtensionBundleRoot {
  sourceKind: typeof EXTENSION_BUNDLE_KINDS[number]["sourceKind"];
  kindDir: string;
  live: string;
}

/**
 * the single derivation installs and crash recovery share, so a journal's paths
 * can be checked against it exactly
 */
export function extensionInstallRoots(
  repoDir: string,
  name: string,
): { extensionRoot: string; bundleRoots: ExtensionBundleRoot[] } {
  // Absolute, so an install and a later recovery that spell the repo
  // path differently still derive the same roots.
  repoDir = resolve(repoDir);
  const extensionRoot = join(resolvePulledExtensionsRoot(repoDir), name);
  return {
    extensionRoot,
    bundleRoots: EXTENSION_BUNDLE_KINDS.map(({ sourceKind, bundleKind }) => {
      const kindDir = swampPath(repoDir, bundleKind);
      return {
        sourceKind,
        kindDir,
        live: join(
          kindDir,
          bundleNamespace(join(extensionRoot, sourceKind), repoDir),
        ),
      };
    }),
  };
}

export function toRelativePath(repoDir: string, absolutePath: string): string {
  if (!isAbsolute(absolutePath)) {
    return absolutePath;
  }
  return relative(repoDir, absolutePath);
}

export function toAbsolutePath(repoDir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    return relativePath;
  }
  return join(repoDir, relativePath);
}

/**
 * throws when neither HOME nor USERPROFILE is set so callers fail loudly; sites
 * that tolerate a missing home must catch it explicitly
 */
export function homeDirectory(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error(
      "Cannot determine home directory: neither HOME nor USERPROFILE is set",
    );
  }
  return home;
}

/**
 * lets callers give an actionable message before path resolution fails deep in
 * the stack, notably the extension loaders
 */
export function homeDirectoryIsSet(): boolean {
  return Boolean(
    Deno.env.get("SWAMP_HOME") ?? Deno.env.get("HOME") ??
      Deno.env.get("USERPROFILE"),
  );
}

/**
 * SWAMP_HOME relocates the whole directory with no .swamp suffix; otherwise
 * ~/.swamp. Agent skill directories stay in the user's home directory
 */
export function getSwampDataDir(): string {
  const swampHome = Deno.env.get("SWAMP_HOME");
  if (swampHome) {
    return swampHome;
  }
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error(
      "Cannot determine home directory (HOME/USERPROFILE not set)",
    );
  }
  return join(home, ".swamp");
}

/**
 * order: SWAMP_CONFIG_DIR, SWAMP_HOME/config, XDG_CONFIG_HOME/swamp,
 * ~/.config/swamp; daemon enable sets SWAMP_CONFIG_DIR so the service reads the
 * user's credentials
 */
export function getSwampConfigDir(): string {
  const configDir = Deno.env.get("SWAMP_CONFIG_DIR");
  if (configDir) {
    return configDir;
  }

  const swampHome = Deno.env.get("SWAMP_HOME");
  if (swampHome) {
    return join(swampHome, "config");
  }

  const xdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
  if (xdgConfigHome) {
    return join(xdgConfigHome, "swamp");
  }

  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error(
      "Cannot determine config directory: neither HOME nor USERPROFILE is set",
    );
  }
  return join(home, ".config", "swamp");
}

/**
 * telemetry is global, keyed to the user identity, not repo-scoped; this is the
 * one spool
 */
export function globalTelemetryDir(): string {
  return join(getSwampConfigDir(), SWAMP_SUBDIRS.telemetry);
}
