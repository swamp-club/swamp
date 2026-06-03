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
 * GitHub Actions audit script that checks workflow files for outdated actions
 * and unpinned references using the GitHub API.
 *
 * Reports outdated actions as warnings and unpinned third-party actions
 * (not using a commit SHA) as errors.
 *
 * Usage: deno run audit-actions
 *
 * Exit codes:
 *   0 - Always (this is a warning-only check, never fails the build)
 */

import { parse as parseYaml } from "@std/yaml";

interface ActionRef {
  file: string;
  action: string;
  owner: string;
  repo: string;
  ref: string;
  isShaPin: boolean;
  isTrustedPublisher: boolean;
}

interface TagInfo {
  latest: string;
  latestSha: string;
}

interface AuditFinding {
  actionRef: ActionRef;
  kind: "unpinned" | "outdated";
  detail: string;
}

/** Publishers whose actions are acceptable with tag-only pins. */
const TRUSTED_PUBLISHERS = new Set([
  "actions",
  "anthropics",
  "denoland",
  "docker",
  "github",
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;

function extractActionRefs(
  filePath: string,
  content: string,
): ActionRef[] {
  const refs: ActionRef[] = [];

  let workflow: unknown;
  try {
    workflow = parseYaml(content);
  } catch {
    console.warn(`Warning: could not parse ${filePath}, skipping`);
    return refs;
  }

  if (
    !workflow || typeof workflow !== "object" ||
    !("jobs" in workflow) || typeof workflow.jobs !== "object" ||
    !workflow.jobs
  ) {
    return refs;
  }

  for (const job of Object.values(workflow.jobs)) {
    const steps = (job as Record<string, unknown>)?.steps;
    if (!Array.isArray(steps)) continue;

    for (const step of steps) {
      const uses = step?.uses;
      if (typeof uses !== "string") continue;

      // Skip Docker and local actions
      if (uses.startsWith("docker://") || uses.startsWith("./")) continue;

      // Parse owner/repo@ref
      const atIndex = uses.indexOf("@");
      if (atIndex === -1) continue;

      const actionPath = uses.substring(0, atIndex);
      const ref = uses.substring(atIndex + 1);
      const slashIndex = actionPath.indexOf("/");
      if (slashIndex === -1) continue;

      const owner = actionPath.substring(0, slashIndex);
      const repo = actionPath.substring(slashIndex + 1);

      refs.push({
        file: filePath,
        action: `${owner}/${repo}`,
        owner,
        repo,
        ref,
        isShaPin: SHA_PATTERN.test(ref),
        isTrustedPublisher: TRUSTED_PUBLISHERS.has(owner),
      });
    }
  }

  return refs;
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "swamp-audit-actions",
  };
  const token = Deno.env.get("GITHUB_TOKEN");
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/** Resolve a git ref to a commit SHA, dereferencing annotated tags if needed. */
async function resolveCommitSha(
  owner: string,
  repo: string,
  refData: { sha: string; type: string },
): Promise<string> {
  if (refData.type !== "tag") return refData.sha;

  // Annotated tag — dereference to get the underlying commit SHA
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/tags/${refData.sha}`,
      { headers: apiHeaders() },
    );
    if (response.ok) {
      const tag = await response.json();
      return tag.object?.sha ?? refData.sha;
    }
  } catch {
    // Fall back to the tag object SHA
  }
  return refData.sha;
}

async function getLatestTag(
  owner: string,
  repo: string,
): Promise<TagInfo | null> {
  // Try releases first, fall back to tags
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      { headers: apiHeaders() },
    );

    if (response.ok) {
      const release = await response.json();
      const tagName = release.tag_name;

      // Get the SHA for this tag, dereferencing annotated tags
      const tagResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/ref/tags/${tagName}`,
        { headers: apiHeaders() },
      );

      if (tagResponse.ok) {
        const tagData = await tagResponse.json();
        const commitSha = await resolveCommitSha(
          owner,
          repo,
          tagData.object,
        );
        return { latest: tagName, latestSha: commitSha };
      }

      return { latest: tagName, latestSha: "" };
    }
  } catch {
    // Fall through to tags API
  }

  // Fallback: list tags sorted by creation
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/tags?per_page=1`,
      { headers: apiHeaders() },
    );

    if (response.ok) {
      const tags = await response.json();
      if (tags.length > 0) {
        return { latest: tags[0].name, latestSha: tags[0].commit.sha };
      }
    }
  } catch {
    // Couldn't reach API
  }

  return null;
}

/** Check if a tag ref (e.g., "v3") is a major version prefix of the latest tag. */
function isSameMajor(currentRef: string, latestTag: string): boolean {
  // Strip 'v' prefix for comparison
  const current = currentRef.replace(/^v/, "");
  const latest = latestTag.replace(/^v/, "");

  const currentMajor = current.split(".")[0];
  const latestMajor = latest.split(".")[0];

  return currentMajor === latestMajor;
}

async function writeGitHubSummary(findings: AuditFinding[]): Promise<void> {
  const summaryFile = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (!summaryFile) return;

  const lines: string[] = ["## GitHub Actions Audit Results\n"];

  const unpinned = findings.filter((f) => f.kind === "unpinned");
  const outdated = findings.filter((f) => f.kind === "outdated");

  if (unpinned.length > 0) {
    lines.push("### Unpinned Third-Party Actions\n");
    lines.push(
      "These actions are not pinned to a commit SHA and could be modified without your knowledge.\n",
    );
    for (const { actionRef, detail } of unpinned) {
      lines.push(
        `- \`${actionRef.action}@${actionRef.ref}\` in \`${actionRef.file}\`: ${detail}`,
      );
    }
    lines.push("");
  }

  if (outdated.length > 0) {
    lines.push("### Outdated Actions\n");
    lines.push(
      "> **Warning**: These actions have newer versions available.\n",
    );
    for (const { actionRef, detail } of outdated) {
      lines.push(
        `- \`${actionRef.action}@${actionRef.ref}\` in \`${actionRef.file}\`: ${detail}`,
      );
    }
    lines.push("");
  }

  if (findings.length === 0) {
    lines.push("All GitHub Actions references are up to date and pinned.");
  }

  await Deno.writeTextFile(summaryFile, lines.join("\n"));
}

async function main(): Promise<void> {
  const workflowDir = ".github/workflows";
  const refs: ActionRef[] = [];

  // Collect all action references from workflow files
  try {
    for await (const entry of Deno.readDir(workflowDir)) {
      if (
        !entry.isFile ||
        (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml"))
      ) {
        continue;
      }

      const filePath = `${workflowDir}/${entry.name}`;
      const content = await Deno.readTextFile(filePath);
      refs.push(...extractActionRefs(filePath, content));
    }
  } catch {
    console.error(`Error: could not read ${workflowDir}`);
    Deno.exit(1);
  }

  if (refs.length === 0) {
    console.log("No action references found in workflow files.");
    Deno.exit(0);
  }

  // Deduplicate by action+ref for API calls
  const uniqueActions = new Map<string, ActionRef>();
  for (const ref of refs) {
    const key = `${ref.action}@${ref.ref}`;
    if (!uniqueActions.has(key)) {
      uniqueActions.set(key, ref);
    }
  }

  console.log(
    `Checking ${uniqueActions.size} unique action references across ${refs.length} usages…`,
  );

  const findings: AuditFinding[] = [];

  // Check unpinned third-party actions (no API call needed)
  for (const [, actionRef] of uniqueActions) {
    if (!actionRef.isShaPin && !actionRef.isTrustedPublisher) {
      findings.push({
        actionRef,
        kind: "unpinned",
        detail:
          `Third-party action not pinned to a commit SHA. Pin to a full SHA for supply chain security.`,
      });
    }
  }

  // Check for outdated versions in parallel
  const versionChecks = [...uniqueActions.values()].map(async (actionRef) => {
    const tagInfo = await getLatestTag(actionRef.owner, actionRef.repo);
    if (!tagInfo) return;

    if (actionRef.isShaPin) {
      if (tagInfo.latestSha && actionRef.ref !== tagInfo.latestSha) {
        findings.push({
          actionRef,
          kind: "outdated",
          detail: `Pinned SHA does not match latest release ${tagInfo.latest}`,
        });
      }
    } else {
      if (!isSameMajor(actionRef.ref, tagInfo.latest)) {
        findings.push({
          actionRef,
          kind: "outdated",
          detail: `Using ${actionRef.ref}, latest is ${tagInfo.latest}`,
        });
      }
    }
  });

  await Promise.all(versionChecks);

  // Write GitHub Actions job summary
  await writeGitHubSummary(findings);

  const unpinned = findings.filter((f) => f.kind === "unpinned");
  const outdated = findings.filter((f) => f.kind === "outdated");

  if (findings.length === 0) {
    console.log("All action references are up to date and properly pinned.");
    Deno.exit(0);
  }

  if (unpinned.length > 0) {
    console.warn(
      `\nUnpinned third-party actions (${unpinned.length}):\n`,
    );
    for (const { actionRef, detail } of unpinned) {
      console.warn(
        `  ${actionRef.action}@${actionRef.ref} (${actionRef.file})`,
      );
      console.warn(`    ${detail}`);
    }
  }

  if (outdated.length > 0) {
    const label = outdated.length === 1 ? "action" : "actions";
    console.warn(
      `\nOutdated ${label} (${outdated.length}):\n`,
    );
    for (const { actionRef, detail } of outdated) {
      console.warn(
        `  ${actionRef.action}@${actionRef.ref} (${actionRef.file})`,
      );
      console.warn(`    ${detail}`);
    }
  }

  Deno.exit(0);
}

main();
