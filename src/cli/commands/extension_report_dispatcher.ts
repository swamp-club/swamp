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

import { join, resolve } from "@std/path";
import type { Logger } from "@logtape/logtape";
import { UserError } from "../../domain/errors.ts";
import {
  isSwampCollective,
  loadInstalledExtensionManifest,
  readInstalledExtensionVersion,
  validateExtensionName,
} from "../../domain/extensions/installed_extension_lookup.ts";
import {
  buildGithubAdvisoryUrl,
  buildGithubNewIssueUrl,
  buildGithubSecuritySettingsUrl,
  buildGitlabNewIssueUrl,
  type ParsedRepositoryUrl,
  parseRepositoryUrl,
  swampClubExtensionUrl,
} from "../../domain/extensions/repository_url.ts";
import {
  assembleExtensionReportBody,
  type ReporterContext,
} from "../../domain/extensions/reporter_context.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import { readSwampSources } from "../../infrastructure/persistence/swamp_sources_repository.ts";
import {
  checkGithubPvrEnabled,
  createGithubIssueViaGh,
  type GhCliRunner,
  isGhCliAvailable,
} from "../../infrastructure/process/gh_cli.ts";
import { openBrowser } from "../../infrastructure/process/browser.ts";

/** Issue type (re-exported for the dispatcher API). */
export type ReportType = "bug" | "feature" | "security";

/** Output mode, mirrors CommandContext.outputMode. */
export type OutputMode = "log" | "json";

/** Refusal reasons the dispatcher can emit. */
export type RefusalReason =
  | "not-pulled"
  | "no-repository"
  | "pvr-disabled";

/** Result of {@link resolveExtensionTarget}. */
export type ExtensionTarget =
  | {
    kind: "swamp-lab";
    extensionName: string;
    extensionVersion: string;
    repositoryUrl?: string;
  }
  | {
    kind: "repository";
    extensionName: string;
    extensionVersion: string;
    repositoryUrl: string;
    parsed: ParsedRepositoryUrl;
  }
  | {
    kind: "refused";
    extensionName: string;
    reason: RefusalReason;
    guidance: string;
  };

/** Result of {@link dispatchRepositoryReport}. */
export type RepositoryDispatchResult =
  | {
    kind: "handoff";
    method: "gh" | "browser";
    variant: "issue" | "advisory";
    url: string;
    number?: number;
    preparedTitle: string;
    preparedBody: string;
    fallbackIssueUrl?: string;
    /** True when a PVR check was attempted and failed (timeout / auth). */
    pvrCheckFailed?: boolean;
    /** True when no PVR check was attempted (gh unavailable). */
    pvrCheckSkipped?: boolean;
    /** True for security with PVR confirmed disabled (rare path — never). */
    nonGithubWarning?: string;
  }
  | {
    kind: "refused";
    reason: RefusalReason;
    guidance: string;
  };

/** Injectable dependencies for the dispatcher — tests pass fakes. */
export interface DispatcherDeps {
  ghRunner?: GhCliRunner;
  env?: { get(key: string): string | undefined };
  /** openBrowser replacement. No-op returning success is a valid test stub. */
  openBrowser?: (url: string) => Promise<void>;
  /** Optional logger used for the default writeLog when tests don't inject one. */
  logger?: Logger;
  /**
   * Log-mode stdout sink for the prepared title/body. Default writes to
   * the logger at info level. Tests pass a collector.
   */
  writeLog?: (text: string) => void;
}

/**
 * Resolves the CLI-side target for a report against `extensionName`.
 *
 * Does not talk to the network — repository-side checks (e.g. PVR) are
 * the dispatcher's job and happen later. Refusals produced here are the
 * "local" variety (not installed, no repo declared).
 */
export async function resolveExtensionTarget(
  repoDir: string,
  extensionName: string,
): Promise<ExtensionTarget> {
  validateExtensionName(extensionName);

  // Verify this is actually a swamp repo before touching the pulled-extensions
  // subtree — otherwise a missing manifest is indistinguishable from a user
  // running from the wrong directory, and we'd send them chasing the wrong fix.
  const markerRepo = new RepoMarkerRepository();
  const repoPath = RepoPath.create(repoDir);
  const marker = await markerRepo.read(repoPath);
  if (marker === null) {
    throw new UserError(
      `No swamp repository found at \`${repoDir}\`. ` +
        `Run \`swamp issue ...\` from inside a swamp repo, or pass ` +
        `\`--repo-dir <path>\` / set SWAMP_REPO_DIR.`,
    );
  }

  const pulledExtRoot = swampPath(repoDir, "pulled-extensions");
  const manifest = await loadInstalledExtensionManifest(
    pulledExtRoot,
    extensionName,
  );

  if (manifest === null) {
    const guidance = await buildNotPulledGuidance(repoDir, extensionName);
    return {
      kind: "refused",
      extensionName,
      reason: "not-pulled",
      guidance,
    };
  }

  const modelsDir = resolveModelsDir(marker);
  const lockfilePath = join(
    resolve(repoDir, modelsDir),
    "upstream_extensions.json",
  );
  const extensionVersion =
    (await readInstalledExtensionVersion(lockfilePath, extensionName)) ??
      manifest.version;

  if (isSwampCollective(extensionName)) {
    return {
      kind: "swamp-lab",
      extensionName,
      extensionVersion,
      repositoryUrl: manifest.repository,
    };
  }

  if (!manifest.repository) {
    return {
      kind: "refused",
      extensionName,
      reason: "no-repository",
      guidance: [
        `The extension \`${extensionName}\` does not declare a repository ` +
        `URL, so swamp can't route reports anywhere.`,
        ``,
        `For reporters:`,
        `  Contact the publisher via ${swampClubExtensionUrl(extensionName)}.`,
        ``,
        `For publishers:`,
        `  Add a \`repository:\` field to your extension's manifest.yaml ` +
        `so users can file issues against it.`,
      ].join("\n"),
    };
  }

  const parsed = parseRepositoryUrl(manifest.repository);
  return {
    kind: "repository",
    extensionName,
    extensionVersion,
    repositoryUrl: manifest.repository,
    parsed,
  };
}

export interface DispatchRepositoryReportInput {
  type: ReportType;
  title: string;
  body: string;
  reporterContext: ReporterContext;
  outputMode: OutputMode;
  labels?: string[];
}

/**
 * Dispatches a report against a third-party (non-@swamp) extension to
 * the publisher's declared repository. Owns the gh/browser selection,
 * the security-specific PVR routing, and the PVR-disabled refusal.
 *
 * Key invariant: when `type === "security"` and PVR is confirmed
 * DISABLED, this function returns a refusal — it MUST NOT create a
 * public issue. That would silently publish a vulnerability.
 */
export async function dispatchRepositoryReport(
  target: Extract<ExtensionTarget, { kind: "repository" }>,
  input: DispatchRepositoryReportInput,
  deps: DispatcherDeps = {},
): Promise<RepositoryDispatchResult> {
  const openBrowserFn = deps.openBrowser ?? openBrowser;
  const writeLog = deps.writeLog ?? ((text) => {
    if (deps.logger) deps.logger.info(text);
    else console.log(text); // fallback, tests should always pass writeLog
  });

  const preparedBody = assembleExtensionReportBody(
    input.body,
    target.repositoryUrl,
    input.reporterContext,
  );
  const preparedTitle = input.title;

  if (input.type === "security") {
    return await dispatchSecurity(
      target,
      preparedTitle,
      preparedBody,
      input,
      deps,
      openBrowserFn,
      writeLog,
    );
  }

  return await dispatchBugOrFeature(
    target,
    preparedTitle,
    preparedBody,
    input,
    deps,
    openBrowserFn,
    writeLog,
  );
}

async function dispatchBugOrFeature(
  target: Extract<ExtensionTarget, { kind: "repository" }>,
  preparedTitle: string,
  preparedBody: string,
  input: DispatchRepositoryReportInput,
  deps: DispatcherDeps,
  openBrowserFn: (url: string) => Promise<void>,
  writeLog: (text: string) => void,
): Promise<RepositoryDispatchResult> {
  const { parsed } = target;

  if (parsed.provider === "github") {
    const ghAvailable = await isGhCliAvailable(deps.ghRunner, deps.env);
    if (ghAvailable) {
      const created = await createGithubIssueViaGh(
        {
          ownerRepo: parsed.ownerRepo!,
          title: preparedTitle,
          body: preparedBody,
          labels: input.labels,
        },
        deps.ghRunner,
      );
      return {
        kind: "handoff",
        method: "gh",
        variant: "issue",
        url: created.url,
        number: created.number,
        preparedTitle,
        preparedBody,
      };
    }
    const url = buildGithubNewIssueUrl(
      parsed.ownerRepo!,
      preparedTitle,
      preparedBody,
      input.labels,
    );
    printHandoffStdout(
      writeLog,
      input.outputMode,
      preparedTitle,
      preparedBody,
    );
    await openBrowserFn(url);
    return {
      kind: "handoff",
      method: "browser",
      variant: "issue",
      url,
      preparedTitle,
      preparedBody,
    };
  }

  if (parsed.provider === "gitlab" && parsed.ownerRepo) {
    const url = buildGitlabNewIssueUrl(
      parsed.url,
      preparedTitle,
      preparedBody,
    );
    printHandoffStdout(
      writeLog,
      input.outputMode,
      preparedTitle,
      preparedBody,
    );
    await openBrowserFn(url);
    return {
      kind: "handoff",
      method: "browser",
      variant: "issue",
      url,
      preparedTitle,
      preparedBody,
    };
  }

  // "other" provider (self-hosted, Bitbucket, Gitea, etc.) — open the repo
  // root and rely on the printed body for manual paste.
  printHandoffStdout(writeLog, input.outputMode, preparedTitle, preparedBody);
  await openBrowserFn(parsed.url);
  return {
    kind: "handoff",
    method: "browser",
    variant: "issue",
    url: parsed.url,
    preparedTitle,
    preparedBody,
  };
}

async function dispatchSecurity(
  target: Extract<ExtensionTarget, { kind: "repository" }>,
  preparedTitle: string,
  preparedBody: string,
  input: DispatchRepositoryReportInput,
  deps: DispatcherDeps,
  openBrowserFn: (url: string) => Promise<void>,
  writeLog: (text: string) => void,
): Promise<RepositoryDispatchResult> {
  const { parsed } = target;

  // GitHub: PVR-aware routing. Never silently publishes a vuln.
  if (parsed.provider === "github" && parsed.ownerRepo) {
    const ghAvailable = await isGhCliAvailable(deps.ghRunner, deps.env);
    const advisoryUrl = buildGithubAdvisoryUrl(parsed.ownerRepo);
    const fallbackIssueUrl = buildGithubNewIssueUrl(
      parsed.ownerRepo,
      preparedTitle,
      preparedBody,
      input.labels,
    );

    if (!ghAvailable) {
      printHandoffStdout(
        writeLog,
        input.outputMode,
        preparedTitle,
        preparedBody,
      );
      await openBrowserFn(advisoryUrl);
      return {
        kind: "handoff",
        method: "browser",
        variant: "advisory",
        url: advisoryUrl,
        preparedTitle,
        preparedBody,
        fallbackIssueUrl,
        pvrCheckSkipped: true,
      };
    }

    const pvr = await checkGithubPvrEnabled(
      parsed.ownerRepo,
      deps.ghRunner,
    );

    if (pvr === false) {
      // SECURITY GUARDRAIL: never fall back to a public issue when PVR
      // is confirmed disabled. Users may forward this message to the
      // publisher — include both the reporter action (contact publisher)
      // and the publisher action (enable PVR).
      return {
        kind: "refused",
        reason: "pvr-disabled",
        guidance: [
          `The repository \`${parsed.ownerRepo}\` does not have GitHub's ` +
          `private vulnerability reporting enabled, so swamp can't file a ` +
          `private report. To avoid publishing the vulnerability, the CLI ` +
          `will NOT file a public issue on your behalf.`,
          ``,
          `For reporters:`,
          `  Contact the publisher privately via ` +
          `${swampClubExtensionUrl(target.extensionName)}.`,
          ``,
          `For publishers:`,
          `  Enable private vulnerability reporting at ` +
          `${buildGithubSecuritySettingsUrl(parsed.ownerRepo)}.`,
        ].join("\n"),
      };
    }

    // PVR enabled or check failed: route to the advisory form. When the
    // check failed, the fallbackIssueUrl lets the user decide after
    // GitHub responds; don't auto-file a public issue under any path.
    printHandoffStdout(
      writeLog,
      input.outputMode,
      preparedTitle,
      preparedBody,
    );
    await openBrowserFn(advisoryUrl);
    return {
      kind: "handoff",
      method: "browser",
      variant: "advisory",
      url: advisoryUrl,
      preparedTitle,
      preparedBody,
      fallbackIssueUrl,
      pvrCheckFailed: pvr === null,
    };
  }

  // Non-GitHub provider: route to the normal issue form and warn the
  // user to toggle the provider's private/confidential option.
  const nonGithubWarning =
    `Security reports against \`${parsed.host}\` must be filed with the ` +
    `provider's private/confidential option if the platform supports one. ` +
    `Confirm the report is marked private before submitting.`;

  const url = parsed.provider === "gitlab" && parsed.ownerRepo
    ? buildGitlabNewIssueUrl(parsed.url, preparedTitle, preparedBody)
    : parsed.url;
  printHandoffStdout(writeLog, input.outputMode, preparedTitle, preparedBody);
  await openBrowserFn(url);
  return {
    kind: "handoff",
    method: "browser",
    variant: "issue",
    url,
    preparedTitle,
    preparedBody,
    nonGithubWarning,
  };
}

function printHandoffStdout(
  writeLog: (text: string) => void,
  outputMode: OutputMode,
  title: string,
  body: string,
): void {
  // JSON mode: the renderer embeds title/body in the payload. Printing
  // freeform markdown to stdout would corrupt the structured output.
  if (outputMode === "json") return;
  writeLog(
    [
      "Preparing report — you can copy this if the handoff fails:",
      "---",
      `Title: ${title}`,
      "",
      body,
      "---",
    ].join("\n"),
  );
}

async function buildNotPulledGuidance(
  repoDir: string,
  extensionName: string,
): Promise<string> {
  const lines: string[] = [
    `Extension \`${extensionName}\` is not installed. Pull it first with:`,
    `  swamp extension pull ${extensionName}`,
  ];
  try {
    const sources = await readSwampSources(repoDir);
    if (sources && sources.sources.length > 0) {
      lines.push(
        ``,
        `If you're running \`${extensionName}\` via \`.swamp-sources.yaml\` ` +
          `(locally sourced), reports against locally-sourced extensions are ` +
          `not supported in this release — pull from the registry or contact ` +
          `the publisher directly.`,
      );
    }
  } catch {
    // Best-effort: if swamp-sources can't be read, just omit the hint.
  }
  return lines.join("\n");
}
