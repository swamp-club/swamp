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
 * Usage: deno run audit
 *
 * Exit codes:
 *   0 - No vulnerabilities found
 *   1 - Vulnerabilities found
 */

interface DenoLock {
  version: string;
  npm?: Record<string, unknown>;
}

interface OsvQuery {
  package: { name: string; ecosystem: string };
  version: string;
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

function parseNpmPackages(
  lockData: DenoLock,
): Array<{ name: string; version: string }> {
  const packages: Array<{ name: string; version: string }> = [];
  const npm = lockData.npm;
  if (!npm) return packages;

  for (const key of Object.keys(npm)) {
    // npm keys in deno.lock look like "@aws-sdk/client-cloudcontrol@3.993.0"
    // or "react@18.3.1" — split on last @
    const lastAt = key.lastIndexOf("@");
    if (lastAt <= 0) continue;

    const name = key.substring(0, lastAt);
    // Version may contain suffixes like "4.10.0_@azure+core-rest-pipeline@1.22.2"
    const rawVersion = key.substring(lastAt + 1);
    const version = rawVersion.split("_")[0];

    packages.push({ name, version });
  }

  return packages;
}

async function queryOsv(
  packages: Array<{ name: string; version: string }>,
): Promise<OsvBatchResponse> {
  const queries: Array<{ package: OsvQuery["package"]; version: string }> =
    packages.map((pkg) => ({
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

  console.log(`Scanning ${packages.length} npm packages for vulnerabilities…`);

  // Query OSV API in batches of 1000 (API limit)
  const batchSize = 1000;
  const vulnerabilities: Array<{
    pkg: { name: string; version: string };
    vulns: OsvVulnerability[];
  }> = [];

  for (let i = 0; i < packages.length; i += batchSize) {
    const batch = packages.slice(i, i + batchSize);
    const response = await queryOsv(batch);

    for (let j = 0; j < response.results.length; j++) {
      const result = response.results[j];
      if (result.vulns && result.vulns.length > 0) {
        vulnerabilities.push({ pkg: batch[j], vulns: result.vulns });
      }
    }
  }

  if (vulnerabilities.length === 0) {
    console.log("No known vulnerabilities found.");
    Deno.exit(0);
  }

  // Report vulnerabilities
  console.error(
    `\nFound vulnerabilities in ${vulnerabilities.length} package(s):\n`,
  );

  for (const { pkg, vulns } of vulnerabilities) {
    console.error(`  ${pkg.name}@${pkg.version}`);
    for (const vuln of vulns) {
      const aliases = vuln.aliases?.filter((a) => a.startsWith("CVE-")) ?? [];
      const cve = aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
      const summary = vuln.summary ?? "No description available";
      console.error(`    - ${vuln.id}${cve}: ${summary}`);
    }
    console.error("");
  }

  Deno.exit(1);
}

main();
