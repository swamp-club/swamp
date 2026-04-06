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

/**
 * Dependency audit script that checks npm packages in deno.lock for known
 * vulnerabilities using the OSV.dev API (https://osv.dev/).
 *
 * Direct dependency vulnerabilities fail the build. Transitive dependency
 * vulnerabilities are reported as warnings with their full dependency chain
 * (since they require upstream fixes).
 *
 * Usage: deno run audit
 *
 * Exit codes:
 *   0 - No direct dependency vulnerabilities found
 *   1 - Direct dependency vulnerabilities found
 */

interface NpmEntry {
  integrity: string;
  dependencies?: string[];
}

interface DenoLock {
  version: string;
  specifiers?: Record<string, string>;
  npm?: Record<string, NpmEntry>;
}

interface NpmLockPackageEntry {
  version?: string;
  resolved?: string;
  dependencies?: Record<string, string>;
  link?: boolean;
}

interface NpmLockfile {
  lockfileVersion: number;
  packages: Record<string, NpmLockPackageEntry>;
}

interface OsvVulnerability {
  id: string;
  summary?: string;
  severity?: Array<{ type: string; score: string }>;
  aliases?: string[];
}

interface OsvResult {
  vulns?: OsvVulnerability[];
}

interface OsvBatchResponse {
  results: OsvResult[];
}

interface PackageInfo {
  name: string;
  version: string;
  isDirect: boolean;
}

interface VulnFinding {
  pkg: PackageInfo;
  vulns: OsvVulnerability[];
  chain: string[];
}

/**
 * Build a map from package name to the full key(s) in the npm section.
 * e.g. "jws" -> "jws@3.2.2"
 */
function buildNameToKeyMap(
  npm: Record<string, NpmEntry>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const key of Object.keys(npm)) {
    const lastAt = key.lastIndexOf("@");
    if (lastAt <= 0) continue;
    const name = key.substring(0, lastAt);
    const existing = map.get(name) ?? [];
    existing.push(key);
    map.set(name, existing);
  }
  return map;
}

/**
 * Build a reverse dependency graph: for each package key, which other
 * package keys depend on it?
 */
function buildReverseDeps(
  npm: Record<string, NpmEntry>,
  nameToKeys: Map<string, string[]>,
): Map<string, string[]> {
  const reverseDeps = new Map<string, string[]>();

  for (const [parentKey, entry] of Object.entries(npm)) {
    for (const depName of entry.dependencies ?? []) {
      const depKeys = nameToKeys.get(depName) ?? [];
      for (const depKey of depKeys) {
        const parents = reverseDeps.get(depKey) ?? [];
        parents.push(parentKey);
        reverseDeps.set(depKey, parents);
      }
    }
  }

  return reverseDeps;
}

/**
 * Trace the dependency chain from a vulnerable package back to a direct
 * dependency using BFS on the reverse dependency graph.
 */
function traceDependencyChain(
  targetKey: string,
  reverseDeps: Map<string, string[]>,
  directNames: Set<string>,
): string[] {
  // BFS from target to find path to a direct dependency
  const visited = new Set<string>();
  const queue: Array<{ key: string; path: string[] }> = [
    { key: targetKey, path: [targetKey] },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.key)) continue;
    visited.add(current.key);

    const lastAt = current.key.lastIndexOf("@");
    if (lastAt > 0) {
      const name = current.key.substring(0, lastAt);
      if (directNames.has(name) && current.path.length > 1) {
        // Found a direct dependency — return the chain reversed
        // (from direct dep down to vulnerable package)
        return current.path.reverse();
      }
    }

    const parents = reverseDeps.get(current.key) ?? [];
    for (const parent of parents) {
      if (!visited.has(parent)) {
        queue.push({ key: parent, path: [...current.path, parent] });
      }
    }
  }

  // No direct dependency found (orphan transitive)
  return [targetKey];
}

function parseNpmPackages(
  lockData: DenoLock,
): { packages: PackageInfo[]; directNames: Set<string> } {
  const npm = lockData.npm;
  if (!npm) return { packages: [], directNames: new Set() };

  // Build set of direct npm dependency names from specifiers
  const directNames = new Set<string>();
  for (const key of Object.keys(lockData.specifiers ?? {})) {
    if (key.startsWith("npm:")) {
      // specifier keys look like "npm:@aws-sdk/client-cloudcontrol@^3.993.0"
      const withoutPrefix = key.substring(4);
      const lastAt = withoutPrefix.lastIndexOf("@");
      if (lastAt > 0) {
        directNames.add(withoutPrefix.substring(0, lastAt));
      }
    }
  }

  const packages: PackageInfo[] = [];
  for (const key of Object.keys(npm)) {
    // npm keys look like "@aws-sdk/client-cloudcontrol@3.993.0"
    const lastAt = key.lastIndexOf("@");
    if (lastAt <= 0) continue;

    const name = key.substring(0, lastAt);
    // Version may have suffixes like "4.10.0_@azure+core-rest-pipeline@1.22.2"
    const rawVersion = key.substring(lastAt + 1);
    const version = rawVersion.split("_")[0];

    packages.push({ name, version, isDirect: directNames.has(name) });
  }

  return { packages, directNames };
}

async function queryOsv(
  packages: PackageInfo[],
): Promise<OsvBatchResponse> {
  const queries = packages.map((pkg) => ({
    package: { name: pkg.name, ecosystem: "npm" },
    version: pkg.version,
  }));

  const response = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries }),
  });

  if (!response.ok) {
    throw new Error(
      `OSV API returned ${response.status}: ${await response.text()}`,
    );
  }

  return await response.json() as OsvBatchResponse;
}

function formatVuln(vuln: OsvVulnerability): string {
  const aliases = vuln.aliases?.filter((a) => a.startsWith("CVE-")) ?? [];
  const cve = aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
  const summary = vuln.summary ?? "No description available";
  return `${vuln.id}${cve}: ${summary}`;
}

function formatChain(chain: string[]): string {
  if (chain.length <= 1) return "";
  return chain.join(" → ");
}

async function writeGitHubSummary(
  direct: VulnFinding[],
  transitive: VulnFinding[],
): Promise<void> {
  const summaryFile = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (!summaryFile) return;

  const lines: string[] = ["## Dependency Audit Results\n"];

  if (direct.length > 0) {
    lines.push("### Direct Dependency Vulnerabilities\n");
    lines.push(
      "These are in packages you directly depend on and **must be resolved**.\n",
    );
    for (const { pkg, vulns } of direct) {
      lines.push(`#### \`${pkg.name}@${pkg.version}\`\n`);
      for (const vuln of vulns) {
        lines.push(`- ${formatVuln(vuln)}`);
      }
      lines.push("");
    }
  }

  if (transitive.length > 0) {
    lines.push("### Transitive Dependency Vulnerabilities\n");
    lines.push(
      "> **Warning**: These are in upstream transitive dependencies. ",
    );
    lines.push(
      "They require fixes from upstream maintainers and do not block this build.\n",
    );
    for (const { pkg, vulns, chain } of transitive) {
      lines.push(`#### \`${pkg.name}@${pkg.version}\`\n`);
      if (chain.length > 1) {
        lines.push(`Dependency chain: \`${formatChain(chain)}\`\n`);
      }
      for (const vuln of vulns) {
        lines.push(`- ${formatVuln(vuln)}`);
      }
      lines.push("");
    }
  }

  if (direct.length === 0 && transitive.length === 0) {
    lines.push("No known vulnerabilities found.");
  }

  await Deno.writeTextFile(summaryFile, lines.join("\n"));
}

/**
 * Parse packages from an npm package-lock.json (lockfileVersion 3).
 * Keys look like "node_modules/@foo/bar" with a version field.
 * Direct dependencies are read from the root entry's dependencies.
 */
function parseNpmLockfile(
  lockData: NpmLockfile,
  label: string,
): { packages: PackageInfo[]; directNames: Set<string> } {
  const rootEntry = lockData.packages[""];
  const directNames = new Set<string>(
    Object.keys(rootEntry?.dependencies ?? {}),
  );

  const packages: PackageInfo[] = [];
  for (const [key, entry] of Object.entries(lockData.packages)) {
    if (key === "" || entry.link) continue;
    if (!entry.version) continue;

    // key is "node_modules/@scope/pkg" or "node_modules/pkg"
    const name = key.replace(/^node_modules\//, "");
    packages.push({
      name,
      version: entry.version,
      isDirect: directNames.has(name),
    });
  }

  console.log(
    `Found ${packages.length} npm packages in ${label}`,
  );
  return { packages, directNames };
}

async function main(): Promise<void> {
  // Read deno.lock
  let lockContent: string;
  try {
    lockContent = await Deno.readTextFile("deno.lock");
  } catch {
    console.error("Error: deno.lock not found. Run 'deno install' first.");
    Deno.exit(1);
  }

  const lockData = JSON.parse(lockContent) as DenoLock;
  const { packages, directNames } = parseNpmPackages(lockData);

  // Also scan npm lockfiles (e.g. evals/promptfoo/package-lock.json)
  const npmLockfiles = ["evals/promptfoo/package-lock.json"];
  for (const lockPath of npmLockfiles) {
    try {
      const content = await Deno.readTextFile(lockPath);
      const npmLock = JSON.parse(content) as NpmLockfile;
      const parsed = parseNpmLockfile(npmLock, lockPath);
      // Merge packages, deduplicating by name@version
      const existing = new Set(packages.map((p) => `${p.name}@${p.version}`));
      for (const pkg of parsed.packages) {
        const key = `${pkg.name}@${pkg.version}`;
        if (!existing.has(key)) {
          packages.push(pkg);
          existing.add(key);
        }
      }
    } catch {
      console.warn(`Warning: could not read ${lockPath}, skipping`);
    }
  }

  if (packages.length === 0) {
    console.log("No npm packages found in lockfiles");
    Deno.exit(0);
  }

  console.log(
    `Scanning ${packages.length} npm packages for vulnerabilities…`,
  );

  // Build dependency graph for chain tracing (deno.lock only — npm lockfile
  // packages without chains are reported with just the package name)
  const npm = lockData.npm ?? {};
  const nameToKeys = buildNameToKeyMap(npm);
  const reverseDeps = buildReverseDeps(npm, nameToKeys);

  // Query OSV API in batches of 1000 (API limit)
  const batchSize = 1000;
  const direct: VulnFinding[] = [];
  const transitive: VulnFinding[] = [];

  for (let i = 0; i < packages.length; i += batchSize) {
    const batch = packages.slice(i, i + batchSize);
    const response = await queryOsv(batch);

    for (let j = 0; j < response.results.length; j++) {
      const result = response.results[j];
      if (result.vulns && result.vulns.length > 0) {
        const pkg = batch[j];
        const targetKey = `${pkg.name}@${pkg.version}`;
        const chain = pkg.isDirect
          ? [targetKey]
          : traceDependencyChain(targetKey, reverseDeps, directNames);
        const finding = { pkg, vulns: result.vulns, chain };

        if (pkg.isDirect) {
          direct.push(finding);
        } else {
          transitive.push(finding);
        }
      }
    }
  }

  // Write GitHub Actions job summary
  await writeGitHubSummary(direct, transitive);

  if (direct.length === 0 && transitive.length === 0) {
    console.log("No known vulnerabilities found.");
    Deno.exit(0);
  }

  // Report direct vulnerabilities (these fail the build)
  if (direct.length > 0) {
    console.error(
      `\nDirect dependency vulnerabilities (${direct.length} package(s)):\n`,
    );
    for (const { pkg, vulns } of direct) {
      console.error(`  ${pkg.name}@${pkg.version}`);
      for (const vuln of vulns) {
        console.error(`    - ${formatVuln(vuln)}`);
      }
      console.error("");
    }
  }

  // Report transitive vulnerabilities (warnings only)
  if (transitive.length > 0) {
    const label = transitive.length === 1 ? "package" : "packages";
    console.warn(
      `\nTransitive dependency vulnerabilities (${transitive.length} ${label} — warning only):\n`,
    );
    for (const { pkg, vulns, chain } of transitive) {
      console.warn(`  ${pkg.name}@${pkg.version}`);
      if (chain.length > 1) {
        console.warn(`    chain: ${formatChain(chain)}`);
      }
      for (const vuln of vulns) {
        console.warn(`    - ${formatVuln(vuln)}`);
      }
      console.warn("");
    }
    if (direct.length === 0) {
      console.warn(
        "Transitive vulnerabilities require upstream fixes and do not fail this check.",
      );
    }
  }

  // Only fail on direct dependency vulnerabilities
  Deno.exit(direct.length > 0 ? 1 : 0);
}

main();
