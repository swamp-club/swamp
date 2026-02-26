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
 * vulnerabilities are reported as warnings (since they require upstream fixes).
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
}

function parseNpmPackages(lockData: DenoLock): PackageInfo[] {
  const npm = lockData.npm;
  if (!npm) return [];

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

  return packages;
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
    for (const { pkg, vulns } of transitive) {
      lines.push(`#### \`${pkg.name}@${pkg.version}\`\n`);
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
  const packages = parseNpmPackages(lockData);

  if (packages.length === 0) {
    console.log("No npm packages found in deno.lock");
    Deno.exit(0);
  }

  console.log(
    `Scanning ${packages.length} npm packages for vulnerabilities…`,
  );

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
        const finding = { pkg: batch[j], vulns: result.vulns };
        if (batch[j].isDirect) {
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
    for (const { pkg, vulns } of transitive) {
      console.warn(`  ${pkg.name}@${pkg.version}`);
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
