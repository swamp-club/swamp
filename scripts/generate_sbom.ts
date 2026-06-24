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

/**
 * CycloneDX SBOM generator for the swamp CLI.
 *
 * Produces a CycloneDX 1.6 JSON Software Bill of Materials describing every
 * npm and JSR dependency resolved for `main.ts`, with an SPDX license for each
 * component. Intended for license-compliance scanning (Trivy, FOSSA, etc.).
 *
 * Dependency discovery uses `deno info --json main.ts` — the authoritative
 * resolved graph (npm packages with their local cache paths, plus every
 * jsr.io module specifier).
 *
 * License resolution:
 *   - npm  → read `license` from the package's cached `package.json` (offline);
 *            fall back to the npm registry if the package isn't cached.
 *   - jsr  → the JSR per-version API (`api.jsr.io`), persisted to an on-disk
 *            cache (`scripts/jsr_license_cache.json`) so repeat runs and CI are
 *            offline and deterministic. `@std/*` packages that declare no
 *            license resolve to MIT (the Deno standard library license).
 *
 * Usage:
 *   deno run sbom                 # writes sbom.cdx.json
 *   deno run sbom --output -      # writes to stdout
 *   deno run sbom --offline       # cache only, never hit the network
 *
 * Exit codes:
 *   0 - SBOM generated (every component has a resolved license)
 *   1 - SBOM generated but one or more components have no resolvable license
 */

import { parseArgs } from "@std/cli";
import { dirname, fromFileUrl, join } from "@std/path";

const CYCLONEDX_SPEC_VERSION = "1.6";
const JSR_API = "https://api.jsr.io";
const NPM_REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 15_000;
const NOASSERTION = "NOASSERTION";
/** Author recorded as the BOM creator (CycloneDX metadata.authors). */
const SBOM_AUTHOR = "Elder Swamp Club, Inc.";

const JSR_LICENSE_CACHE_PATH = join(
  dirname(fromFileUrl(import.meta.url)),
  "jsr_license_cache.json",
);

// --- deno info --json shapes (only the fields we read) ---------------------

interface DenoInfoNpmPackage {
  name: string;
  version: string;
  dependencies?: string[];
  registryUrl?: string;
  localPath?: string;
}

interface DenoInfoModuleDep {
  specifier?: string;
}

interface DenoInfoModule {
  specifier?: string;
  dependencies?: DenoInfoModuleDep[];
}

interface DenoInfo {
  npmPackages?: Record<string, DenoInfoNpmPackage>;
  modules?: DenoInfoModule[];
  /** Resolution map from a jsr range specifier to a concrete name@version. */
  packages?: Record<string, string>;
}

// --- internal component model ----------------------------------------------

interface Component {
  ecosystem: "npm" | "jsr";
  name: string;
  version: string;
  /** name@version key used to wire dependency edges. */
  key: string;
  /** Stable CycloneDX bom-ref. */
  bomRef: string;
  /** Package URL (pkg:npm/… or pkg:jsr/…). */
  purl: string;
  /** Resolved SPDX expression/id, or NOASSERTION. */
  license: string;
  /** Supplier/publisher name (npm author or jsr scope). */
  supplier: string;
  /** Dependency keys (name@version) for the dependency graph. */
  dependsOn: string[];
}

// --- CycloneDX shapes ------------------------------------------------------

type CdxLicenseChoice =
  | { license: { id: string } }
  | { license: { name: string } }
  | { expression: string };

interface CdxComponent {
  type: "library";
  "bom-ref": string;
  name: string;
  version: string;
  purl: string;
  supplier: { name: string };
  licenses: CdxLicenseChoice[];
  externalReferences?: Array<{ type: string; url: string }>;
}

interface CdxBom {
  bomFormat: "CycloneDX";
  specVersion: string;
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    authors: Array<{ name: string }>;
    tools: { components: Array<{ type: string; name: string }> };
    component: {
      type: "application";
      "bom-ref": string;
      name: string;
      version: string;
      licenses: CdxLicenseChoice[];
    };
  };
  components: CdxComponent[];
  dependencies: Array<{ ref: string; dependsOn: string[] }>;
}

// --- license helpers -------------------------------------------------------

/** Map an SPDX string (or null) to CycloneDX license choices. */
export function licenseToCdx(spdx: string | null): CdxLicenseChoice[] {
  if (!spdx || spdx === NOASSERTION) {
    return [{ license: { name: NOASSERTION } }];
  }
  // Compound SPDX expressions (AND/OR/WITH or parenthesised) use `expression`;
  // a bare identifier uses `license.id`.
  if (/\s|\(/.test(spdx)) {
    return [{ expression: spdx }];
  }
  return [{ license: { id: spdx } }];
}

/**
 * Normalize the many shapes of an npm `license`/`licenses` field to a single
 * SPDX string. Returns null when no license is declared.
 */
export function normalizeNpmLicense(
  pkg: { license?: unknown; licenses?: unknown },
): string | null {
  const { license, licenses } = pkg;
  if (typeof license === "string" && license.trim() !== "") {
    return license.trim();
  }
  // Deprecated object form: { type: "MIT", url: "..." }.
  if (
    license && typeof license === "object" &&
    typeof (license as { type?: unknown }).type === "string"
  ) {
    return (license as { type: string }).type;
  }
  // Deprecated array form: [{ type: "MIT" }, { type: "Apache-2.0" }].
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((
        l,
      ) => (l && typeof l === "object"
        ? (l as { type?: string }).type
        : undefined)
      )
      .filter((t): t is string => typeof t === "string" && t.trim() !== "");
    if (types.length === 1) return types[0];
    if (types.length > 1) return `(${types.join(" OR ")})`;
  }
  return null;
}

// --- fetch helper ----------------------------------------------------------

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status}`);
  }
  return await res.json();
}

// --- JSR license cache -----------------------------------------------------

export class JsrLicenseCache {
  #entries: Record<string, string>;
  #dirty = false;

  private constructor(entries: Record<string, string>) {
    this.#entries = entries;
  }

  static async load(path: string): Promise<JsrLicenseCache> {
    try {
      const text = await Deno.readTextFile(path);
      return new JsrLicenseCache(JSON.parse(text) as Record<string, string>);
    } catch {
      return new JsrLicenseCache({});
    }
  }

  get(key: string): string | undefined {
    return this.#entries[key];
  }

  set(key: string, license: string): void {
    if (this.#entries[key] !== license) {
      this.#entries[key] = license;
      this.#dirty = true;
    }
  }

  async save(path: string): Promise<void> {
    if (!this.#dirty) return;
    const sorted = Object.fromEntries(
      Object.entries(this.#entries).sort(([a], [b]) => a.localeCompare(b)),
    );
    await Deno.writeTextFile(path, JSON.stringify(sorted, null, 2) + "\n");
    this.#dirty = false;
  }
}

/**
 * Resolve a JSR package's license, consulting the cache first. `@std/*`
 * packages with no declared license resolve to MIT (the Deno std license).
 */
export async function resolveJsrLicense(
  scope: string,
  name: string,
  version: string,
  cache: JsrLicenseCache,
  offline: boolean,
): Promise<string> {
  const key = `@${scope}/${name}@${version}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let license: string | null = null;
  if (!offline) {
    try {
      const meta = await fetchJson(
        `${JSR_API}/scopes/${scope}/packages/${name}/versions/${version}`,
      ) as { license?: string | null };
      license = meta.license ?? null;
    } catch (err) {
      console.error(`  warning: JSR lookup failed for ${key}: ${errMsg(err)}`);
    }
  }
  // The Deno standard library is uniformly MIT even when an older published
  // version didn't declare a license field.
  if (!license && scope === "std") license = "MIT";

  const resolved = license ?? NOASSERTION;
  if (resolved !== NOASSERTION) cache.set(key, resolved);
  return resolved;
}

/** Extract a supplier name from an npm `author` field (string or object). */
export function parseNpmAuthor(author: unknown): string | null {
  if (typeof author === "string") {
    // "Name <email> (url)" → "Name"
    const name = author.split(/[<(]/)[0].trim();
    return name || null;
  }
  if (
    author && typeof author === "object" &&
    typeof (author as { name?: unknown }).name === "string"
  ) {
    const name = (author as { name: string }).name.trim();
    return name || null;
  }
  return null;
}

/** Supplier fallback when no author is declared: the scope, else "npm". */
function npmSupplierFallback(name: string): string {
  return name.startsWith("@") ? name.slice(0, name.indexOf("/")) : "npm";
}

interface NpmResolution {
  license: string;
  supplier: string;
}

async function resolveNpm(
  pkg: DenoInfoNpmPackage,
  offline: boolean,
): Promise<NpmResolution> {
  let license: string | null = null;
  let supplier: string | null = null;

  // Prefer the offline cached package.json.
  if (pkg.localPath) {
    try {
      const text = await Deno.readTextFile(join(pkg.localPath, "package.json"));
      const json = JSON.parse(text) as {
        license?: unknown;
        licenses?: unknown;
        author?: unknown;
      };
      license = normalizeNpmLicense(json);
      supplier = parseNpmAuthor(json.author);
    } catch {
      // fall through to registry
    }
  }
  if ((!license || !supplier) && !offline) {
    try {
      const registry = pkg.registryUrl ?? NPM_REGISTRY;
      const meta = await fetchJson(
        `${registry.replace(/\/$/, "")}/${pkg.name}/${pkg.version}`,
      ) as { author?: unknown };
      license ??= normalizeNpmLicense(meta as Record<string, unknown>);
      supplier ??= parseNpmAuthor(meta.author);
    } catch (err) {
      console.error(
        `  warning: npm lookup failed for ${pkg.name}@${pkg.version}: ${
          errMsg(err)
        }`,
      );
    }
  }
  return {
    license: license ?? NOASSERTION,
    supplier: supplier ?? npmSupplierFallback(pkg.name),
  };
}

// --- component extraction --------------------------------------------------

/** percent-encode the leading @ of a scoped npm name for a purl. */
function npmPurl(name: string, version: string): string {
  const encoded = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

export function extractNpmComponents(info: DenoInfo): Component[] {
  const components: Component[] = [];
  for (const pkg of Object.values(info.npmPackages ?? {})) {
    const key = `${pkg.name}@${pkg.version}`;
    components.push({
      ecosystem: "npm",
      name: pkg.name,
      version: pkg.version,
      key,
      bomRef: npmPurl(pkg.name, pkg.version),
      purl: npmPurl(pkg.name, pkg.version),
      license: NOASSERTION,
      // Supplier is resolved later from the package's author field.
      supplier: "",
      dependsOn: pkg.dependencies ?? [],
    });
  }
  return components;
}

const JSR_SPECIFIER = /^https:\/\/jsr\.io\/(@[^/]+\/[^/]+)\/([^/]+)\//;

export function extractJsrComponents(info: DenoInfo): Component[] {
  const resolve = info.packages ?? {};
  const seen = new Map<string, Component>();
  // First pass: discover every jsr package from its module specifiers.
  for (const mod of info.modules ?? []) {
    const match = mod.specifier?.match(JSR_SPECIFIER);
    if (!match) continue;
    const [, nameWithScope, version] = match;
    const key = `${nameWithScope}@${version}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      ecosystem: "jsr",
      name: nameWithScope,
      version,
      key,
      bomRef: `jsr:${key}`,
      // pkg:jsr is the de-facto purl type for jsr.io packages.
      purl: `pkg:jsr/${nameWithScope}@${version}`,
      license: NOASSERTION,
      // The jsr scope (e.g. "@std") is the package's publisher/supplier.
      supplier: nameWithScope.slice(0, nameWithScope.indexOf("/")),
      dependsOn: [],
    });
  }
  // Second pass: jsr→jsr edges. Module deps appear as `jsr:@scope/name@range`
  // and resolve to a concrete version via the `packages` map.
  const edges = new Map<string, Set<string>>();
  for (const mod of info.modules ?? []) {
    const match = mod.specifier?.match(JSR_SPECIFIER);
    if (!match) continue;
    const srcKey = `${match[1]}@${match[2]}`;
    for (const dep of mod.dependencies ?? []) {
      const spec = dep.specifier ?? "";
      if (!spec.startsWith("jsr:")) continue;
      const target = resolve[spec.slice(4)];
      if (!target || target === srcKey || !seen.has(target)) continue;
      let targets = edges.get(srcKey);
      if (!targets) {
        targets = new Set();
        edges.set(srcKey, targets);
      }
      targets.add(target);
    }
  }
  for (const [key, component] of seen) {
    const targets = edges.get(key);
    if (targets) component.dependsOn = [...targets];
  }
  return [...seen.values()];
}

// --- SBOM assembly ---------------------------------------------------------

interface RootMeta {
  name: string;
  version: string;
  license: string;
}

export function buildSbom(
  root: RootMeta,
  components: Component[],
  timestamp: string,
  serialNumber: string,
): CdxBom {
  const sorted = [...components].sort((a, b) =>
    `${a.ecosystem}:${a.key}`.localeCompare(`${b.ecosystem}:${b.key}`)
  );
  const refByKey = new Map(sorted.map((c) => [c.key, c.bomRef]));
  const rootRef = `${root.name}@${root.version}`;

  const cdxComponents: CdxComponent[] = sorted.map((c) => {
    const component: CdxComponent = {
      type: "library",
      "bom-ref": c.bomRef,
      name: c.name,
      version: c.version,
      purl: c.purl,
      supplier: { name: c.supplier },
      licenses: licenseToCdx(c.license),
    };
    if (c.ecosystem === "jsr") {
      component.externalReferences = [{
        type: "distribution",
        url: `https://jsr.io/${c.name}@${c.version}`,
      }];
    }
    return component;
  });

  // Emit a relationship entry for every component (leaves get an empty
  // `dependsOn`, which asserts "analyzed, no dependencies") so the graph
  // covers the full component set.
  const dependencies = sorted.map((c) => ({
    ref: c.bomRef,
    dependsOn: c.dependsOn
      .map((k) => refByKey.get(k))
      .filter((ref): ref is string => ref !== undefined),
  }));

  return {
    bomFormat: "CycloneDX",
    specVersion: CYCLONEDX_SPEC_VERSION,
    serialNumber,
    version: 1,
    metadata: {
      timestamp,
      authors: [{ name: SBOM_AUTHOR }],
      tools: {
        components: [{ type: "application", name: "swamp-sbom-generator" }],
      },
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: root.name,
        version: root.version,
        licenses: licenseToCdx(root.license),
      },
    },
    components: cdxComponents,
    dependencies,
  };
}

// --- driver ----------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readRootMeta(): Promise<RootMeta> {
  const text = await Deno.readTextFile("deno.json");
  const json = JSON.parse(text) as {
    name?: string;
    version?: string;
    license?: string;
  };
  return {
    name: json.name ?? "swamp",
    version: json.version ?? "0.0.0",
    license: json.license ?? NOASSERTION,
  };
}

async function runDenoInfo(): Promise<DenoInfo> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", "main.ts"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(`deno info failed: ${new TextDecoder().decode(stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(stdout)) as DenoInfo;
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["output"],
    boolean: ["offline"],
    default: { output: "sbom.cdx.json", offline: false },
  });
  const offline = args.offline;

  const [root, info] = await Promise.all([readRootMeta(), runDenoInfo()]);

  const components = [
    ...extractNpmComponents(info),
    ...extractJsrComponents(info),
  ];
  console.error(
    `Resolving licenses for ${components.length} components ` +
      `(${components.filter((c) => c.ecosystem === "npm").length} npm, ` +
      `${components.filter((c) => c.ecosystem === "jsr").length} jsr)…`,
  );

  const cache = await JsrLicenseCache.load(JSR_LICENSE_CACHE_PATH);
  for (const component of components) {
    if (component.ecosystem === "npm") {
      const pkg = info.npmPackages?.[component.key] ??
        Object.values(info.npmPackages ?? {}).find(
          (p) => `${p.name}@${p.version}` === component.key,
        );
      if (pkg) {
        const { license, supplier } = await resolveNpm(pkg, offline);
        component.license = license;
        component.supplier = supplier;
      } else {
        component.supplier = npmSupplierFallback(component.name);
      }
    } else {
      const at = component.name.indexOf("/");
      const scope = component.name.slice(1, at); // strip leading @
      const name = component.name.slice(at + 1);
      component.license = await resolveJsrLicense(
        scope,
        name,
        component.version,
        cache,
        offline,
      );
    }
  }
  await cache.save(JSR_LICENSE_CACHE_PATH);

  const timestamp = new Date().toISOString();
  const serialNumber = `urn:uuid:${crypto.randomUUID()}`;
  const bom = buildSbom(root, components, timestamp, serialNumber);
  const json = JSON.stringify(bom, null, 2) + "\n";

  if (args.output === "-") {
    console.log(json.trimEnd());
  } else {
    await Deno.writeTextFile(args.output, json);
    console.error(`Wrote ${components.length} components to ${args.output}`);
  }

  const unlicensed = components.filter((c) => c.license === NOASSERTION);
  if (unlicensed.length > 0) {
    console.error(
      `\n${unlicensed.length} component(s) with no resolvable license:`,
    );
    for (const c of unlicensed) {
      console.error(`  ${c.ecosystem}: ${c.key}`);
    }
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
