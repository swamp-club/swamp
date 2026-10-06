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
 * Registry-side publish checks.
 *
 * A push is refused by the registry for four reasons the client can know in
 * advance: the caller is not signed in, the extension's collective is not one
 * of the caller's, the collective is reserved and membership could not be
 * verified, or the version is already published. These rules decide each
 * check's verdict and carry the exact wording a real push fails with, so a
 * dry run reports the same outcome the push would.
 */

import { ModelType } from "../models/model_type.ts";

/** The registry checks a push runs before uploading. */
export type RegistryCheckName =
  | "authentication"
  | "collective-membership"
  | "reserved-collective"
  | "version-exists";

/**
 * How a check ended. `not-run` means a prerequisite was missing (no
 * credentials, a failed sign-in, an unreachable registry); its message says
 * which.
 */
export type RegistryCheckStatus = "passed" | "failed" | "not-run";

/**
 * Why a check could not run. `no-credentials` is the only cause a dry run
 * tolerates: the registry was never asked. The others mean the registry was
 * asked and did not confirm, which a real push would have failed on.
 */
export type RegistryCheckNotRunCause =
  | "no-credentials"
  | "authentication-failed"
  | "registry-unavailable"
  | "membership-unverified";

/** One registry check's verdict, in the wording a real push uses. */
export interface RegistryCheckResult {
  name: RegistryCheckName;
  status: RegistryCheckStatus;
  message: string;
  /** Present only when the check did not run. */
  cause?: RegistryCheckNotRunCause;
}

/**
 * What the prepare phase does with the registry checks.
 *
 * - `enforce`: a real push; the first failing check throws.
 * - `collect`: a dry run; every check runs and its verdict is collected.
 * - `skip`: packaging only (`extension quality`); nothing contacts the
 *   registry.
 */
export type RegistryChecksMode = "enforce" | "collect" | "skip";

/** Human-readable labels for the log summary. */
export const REGISTRY_CHECK_LABELS: Record<RegistryCheckName, string> = {
  "authentication": "authentication",
  "collective-membership": "collective membership",
  "reserved-collective": "reserved collective",
  "version-exists": "version exists",
};

/** The external services a push may call before uploading. */
export type ApiCallService = "registry" | "osv" | "npm" | "other";

/** How an HTTP call ended, as the summary reports it. */
export type ApiCallOutcome = "ok" | "not-found" | "error";

/**
 * One HTTP request made while preparing a push. Carries the method and URL
 * only — never headers, so no credential can reach the summary. A retried
 * request is listed once per attempt: the summary reports calls actually
 * made.
 */
export interface ApiCallRecord {
  service: ApiCallService;
  method: string;
  url: string;
  outcome: ApiCallOutcome;
  /** HTTP status when a response arrived. */
  status?: number;
}

/** Names the service behind a URL so the summary can group calls. */
export function classifyApiCallService(
  url: string,
  registryUrl: string,
): ApiCallService {
  const host = hostOf(url);
  if (host === undefined) return "other";
  if (host === hostOf(registryUrl)) return "registry";
  if (host === "api.osv.dev") return "osv";
  if (host === "registry.npmjs.org" || host === "api.npmjs.org") return "npm";
  return "other";
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** The collective part of an extension name: `@acme/tool` gives `acme`. */
export function collectiveOf(extensionName: string): string {
  return extensionName.slice(1, extensionName.indexOf("/"));
}

/** Inputs for the collective checks. */
export interface CollectiveMembershipInput {
  extensionName: string;
  /**
   * The caller's collectives as the registry reports them, or `undefined`
   * when the lookup failed and the registry's answer is unknown.
   */
  collectives: string[] | undefined;
  username: string;
}

/**
 * Decides the reserved-collective and collective-membership checks.
 *
 * A reserved collective (`@swamp`, `@si`) needs the registry's own word on
 * membership, so an unknown collectives list fails that check. For any
 * other collective the membership list decides, and when it is unknown the
 * caller's username stands in for it. Failure messages are the ones a real
 * push throws.
 */
export function evaluateCollectiveMembership(
  input: CollectiveMembershipInput,
): { reserved: RegistryCheckResult; membership: RegistryCheckResult } {
  const collective = collectiveOf(input.extensionName);
  const isReserved = ModelType.isReservedCollective(input.extensionName);

  if (isReserved && !input.collectives) {
    const message = `Extension uses reserved collective "@${collective}". ` +
      `Could not verify membership — please check your network connection and try again.`;
    return {
      reserved: { name: "reserved-collective", status: "failed", message },
      membership: {
        name: "collective-membership",
        status: "not-run",
        message:
          `membership of reserved collective "@${collective}" could not be verified`,
        cause: "membership-unverified",
      },
    };
  }

  const reserved: RegistryCheckResult = isReserved
    ? {
      name: "reserved-collective",
      status: "passed",
      message:
        `Collective "@${collective}" is reserved; membership verified by the registry.`,
    }
    : {
      name: "reserved-collective",
      status: "passed",
      message: `Collective "@${collective}" is not reserved.`,
    };

  const isAllowed = input.collectives
    ? input.collectives.includes(collective)
    : collective === input.username;
  if (!isAllowed) {
    const collectivesList = input.collectives
      ? input.collectives.map((c) => `@${c}`).join(", ")
      : `@${input.username}`;
    return {
      reserved,
      membership: {
        name: "collective-membership",
        status: "failed",
        message:
          `Extension collective "@${collective}" is not one of your collectives (${collectivesList}). ` +
          `Use one of: ${collectivesList}`,
      },
    };
  }

  return {
    reserved,
    membership: {
      name: "collective-membership",
      status: "passed",
      message: `Collective "@${collective}" is one of your collectives.`,
    },
  };
}

/** A published version as the registry lists it. */
export interface PublishedVersion {
  version: string;
  channel: string;
}

/**
 * Decides the version-exists check. A version is unique per extension across
 * every release channel, so a match on any channel fails the check with the
 * message a real push throws.
 */
export function evaluateVersionExists(input: {
  extensionName: string;
  version: string;
  published: PublishedVersion | null;
}): RegistryCheckResult {
  if (input.published && input.published.version === input.version) {
    return {
      name: "version-exists",
      status: "failed",
      message:
        `Version ${input.version} already exists for ${input.extensionName}.`,
    };
  }
  return {
    name: "version-exists",
    status: "passed",
    message:
      `Version ${input.version} is not published for ${input.extensionName}.`,
  };
}

/** A check that could not run, with the reason. */
export function registryCheckNotRun(
  name: RegistryCheckName,
  cause: RegistryCheckNotRunCause,
  reason: string,
): RegistryCheckResult {
  return { name, status: "not-run", message: reason, cause };
}

/**
 * Whether a dry run's collected checks let it end green. A failed check
 * ends it with that check's message, the one the push would fail with. A
 * check the registry was asked about but did not answer ends it too, since
 * the push would have stopped there; only checks never asked (no
 * credentials) leave the run green, and the summary says they did not run.
 */
export function registryChecksVerdict(
  checks: RegistryCheckResult[],
): { ok: true } | { ok: false; message: string } {
  const failed = checks.find((c) => c.status === "failed");
  if (failed) return { ok: false, message: failed.message };
  const unanswered = checks.find((c) =>
    c.status === "not-run" && c.cause === "registry-unavailable"
  );
  if (unanswered) {
    return {
      ok: false,
      message: `Registry check "${
        REGISTRY_CHECK_LABELS[unanswered.name]
      }" could not run: ${unanswered.message}`,
    };
  }
  return { ok: true };
}
