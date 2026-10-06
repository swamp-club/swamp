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
 * A push is refused by the registry for reasons the client can know in
 * advance: the caller is not signed in, the extension's collective is not one
 * of the caller's, the collective is reserved and membership could not be
 * verified, the version is already published, or (for a private publication)
 * the collective's plan does not allow private extensions. These rules decide
 * each check's verdict and carry the exact wording a real push fails with, so
 * a dry run reports the same outcome the push would.
 *
 * Entitlement is the registry's to decide. The private-entitlement rule only
 * repeats what the registry reported at sign-in and fails on the one standing
 * the registry always refuses (a free plan whose trial has ended); every other
 * standing is reported as the registry's data, never as a prediction.
 */

import { ModelType } from "../models/model_type.ts";
import { ReleaseChannel } from "./release_channel.ts";

/** The registry checks a push runs before uploading. */
export type RegistryCheckName =
  | "authentication"
  | "collective-membership"
  | "reserved-collective"
  | "version-exists"
  | "private-entitlement";

/**
 * How a check ended. `not-run` means a prerequisite was missing (no
 * credentials, a failed sign-in, an unreachable registry); its message says
 * which.
 */
export type RegistryCheckStatus = "passed" | "failed" | "not-run";

/**
 * Why a check could not run. `no-credentials` leaves a dry run green: the
 * registry was never asked. `entitlement-undecided` does too: the registry
 * answered, but what it reported does not settle private entitlement (it sent
 * none, or a free plan with no trial, where its own gate may start one), so
 * the registry decides at publish. The others mean the registry was asked and
 * did not confirm, which a real push would have failed on.
 */
export type RegistryCheckNotRunCause =
  | "no-credentials"
  | "authentication-failed"
  | "registry-unavailable"
  | "membership-unverified"
  | "entitlement-undecided";

/** One registry check's verdict, in the wording a real push uses. */
export interface RegistryCheckResult {
  name: RegistryCheckName;
  status: RegistryCheckStatus;
  message: string;
  /** Present only when the check did not run. */
  cause?: RegistryCheckNotRunCause;
  /** version-exists only: the channel the version is already published on. */
  existingChannel?: string;
  /** version-exists only: the channel the push asked for. */
  requestedChannel?: string;
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
  "private-entitlement": "private entitlement",
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

/** A collective's trial clock as the registry reports it. */
export interface CollectiveTrial {
  state: "none" | "active" | "expired";
  /** ISO timestamp, or null when the registry sent none. */
  endsAt: string | null;
  daysRemaining: number;
}

/**
 * What one collective entitles the caller to, as the registry reported it at
 * sign-in. Structurally the libswamp whoami entitlement, so the push can hand
 * it over without the domain importing from the application layer. `plan` is
 * absent when the registry did not report entitlement for the collective.
 */
export interface CollectiveEntitlement {
  slug: string;
  plan?: string;
  planName?: string;
  trial?: CollectiveTrial | null;
}

/** Inputs for the private-entitlement check. */
export interface PrivateEntitlementInput {
  extensionName: string;
  /**
   * Per-collective entitlement as the registry reported it, or `undefined`
   * when the server sent none (an older or self-hosted swamp-club).
   */
  entitlements: CollectiveEntitlement[] | undefined;
  /** The registry's URL, for the upgrade pointer. */
  serverUrl: string;
}

/** The billing page of a collective on the registry at `serverUrl`. */
export function collectiveBillingUrl(serverUrl: string, slug: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/o/${slug}/billing`;
}

const PAID_PLAN_REQUIRED = "Private publication requires a paid plan";

/** The plan as the registry labels it, falling back to its id. */
function planLabel(entitlement: CollectiveEntitlement): string {
  return entitlement.planName ?? entitlement.plan ?? "";
}

/**
 * The date part of an ISO timestamp, as the registry sent it. Never
 * recomputed in local time: the registry's trial dates are elapsed-based.
 */
function isoDate(timestamp: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(timestamp)
    ? timestamp.slice(0, 10)
    : timestamp;
}

function activeTrial(trial: CollectiveTrial): string {
  const days = trial.daysRemaining === 1
    ? "1 day left"
    : `${trial.daysRemaining} days left`;
  return trial.endsAt
    ? `an active trial (${days}, ends ${isoDate(trial.endsAt)})`
    : `an active trial (${days})`;
}

function endedTrial(trial: CollectiveTrial): string {
  return trial.endsAt
    ? `its trial ended on ${isoDate(trial.endsAt)}`
    : "its trial has ended";
}

/**
 * Decides the private-entitlement check from what the registry reported.
 *
 * A paid plan passes, as does a free plan with an active trial, each named.
 * A free plan whose trial has ended fails with the message a real push
 * throws, naming the collective, its plan and the upgrade page. A free plan
 * with no trial is undecided: the registry may start the collective's trial
 * at publish, so the check says the registry decides. No entitlement for the
 * collective is undecided too, and says the registry did not report it.
 */
export function evaluatePrivateEntitlement(
  input: PrivateEntitlementInput,
): RegistryCheckResult {
  const collective = collectiveOf(input.extensionName);
  const entitlement = input.entitlements?.find((e) => e.slug === collective);
  const name = "private-entitlement";
  if (!entitlement || entitlement.plan === undefined) {
    return registryCheckNotRun(
      name,
      "entitlement-undecided",
      `the registry did not report entitlement for "@${collective}"; private publication is decided at publish`,
    );
  }
  const plan = planLabel(entitlement);
  if (entitlement.plan !== "free") {
    return {
      name,
      status: "passed",
      message:
        `Collective "@${collective}" is on the ${plan} plan, which allows private extensions.`,
    };
  }
  const trial = entitlement.trial ?? undefined;
  if (trial?.state === "active") {
    return {
      name,
      status: "passed",
      message: `Collective "@${collective}" is on the ${plan} plan with ${
        activeTrial(trial)
      }, which allows private extensions.`,
    };
  }
  if (trial?.state === "expired") {
    return {
      name,
      status: "failed",
      message: `Collective "@${collective}" is on the ${plan} plan and ${
        endedTrial(trial)
      }. ${PAID_PLAN_REQUIRED}; upgrade at ${
        collectiveBillingUrl(input.serverUrl, collective)
      }.`,
    };
  }
  return registryCheckNotRun(
    name,
    "entitlement-undecided",
    `Collective "@${collective}" is on the ${plan} plan with no trial reported; the registry decides private publication at publish.`,
  );
}

/**
 * The registry's own refusal of a private publication, followed by what it
 * reported for the collective at sign-in. The report is stated as a report,
 * never as the cause: the registry decided, and this says what it had said
 * about the collective. The upgrade pointer is added only when the registry
 * reported a free plan without an active trial. Nothing here names a plan the
 * registry did not send.
 */
export function explainPrivatePublishRefusal(
  serverMessage: string,
  input: {
    extensionName: string;
    entitlement: CollectiveEntitlement | undefined;
    serverUrl: string;
  },
): string {
  const collective = collectiveOf(input.extensionName);
  const refusal = /[.!?]$/.test(serverMessage.trim())
    ? serverMessage.trim()
    : `${serverMessage.trim()}.`;
  const entitlement = input.entitlement;
  if (!entitlement || entitlement.plan === undefined) {
    return `${refusal} At sign-in the registry did not report entitlement for "@${collective}".`;
  }
  const plan = planLabel(entitlement);
  const trial = entitlement.trial ?? undefined;
  if (entitlement.plan !== "free") {
    return `${refusal} At sign-in the registry reported "@${collective}" on the ${plan} plan.`;
  }
  if (trial?.state === "active") {
    return `${refusal} At sign-in the registry reported "@${collective}" on the ${plan} plan with ${
      activeTrial(trial)
    }.`;
  }
  const standing = trial?.state === "expired"
    ? `; ${endedTrial(trial)}`
    : " with no trial reported";
  return `${refusal} At sign-in the registry reported "@${collective}" on the ${plan} plan${standing}. ${PAID_PLAN_REQUIRED}; upgrade at ${
    collectiveBillingUrl(input.serverUrl, collective)
  }.`;
}

/** A published version as the registry lists it. */
export interface PublishedVersion {
  version: string;
  channel: string;
}

/**
 * Where an already-published version sits relative to the channel a push
 * asked for. Only `lower-channel` can be promoted; the registry moves a
 * version forward (beta → rc → stable) and never back.
 */
export type ExistingVersionPlacement =
  | "same-channel"
  | "lower-channel"
  | "higher-channel";

/**
 * Places an existing version's channel against the requested one. A channel
 * name this client does not know is treated as the same channel, so it never
 * offers a promotion the registry has not been seen to allow.
 */
export function placeExistingVersion(
  existingChannel: string,
  requestedChannel: string,
): ExistingVersionPlacement {
  if (
    !ReleaseChannel.isValid(existingChannel) ||
    !ReleaseChannel.isValid(requestedChannel)
  ) {
    return "same-channel";
  }
  const existing = ReleaseChannel.create(existingChannel);
  const requested = ReleaseChannel.create(requestedChannel);
  if (existing.canPromoteTo(requested)) return "lower-channel";
  if (requested.canPromoteTo(existing)) return "higher-channel";
  return "same-channel";
}

/** The promote command that moves a published version to a channel. */
export function promoteCommand(
  extensionName: string,
  version: string,
  toChannel: string,
): string {
  return `swamp extension promote ${extensionName} ${version} --channel ${toChannel}`;
}

/**
 * Decides the version-exists check. A version is unique per extension across
 * every release channel, so a match on any channel fails the check with the
 * message a real push throws. A duplicate on the requested channel keeps the
 * plain message; a match on another channel names that channel and, when the
 * version sits on a lower one, the promote command that moves it.
 */
export function evaluateVersionExists(input: {
  extensionName: string;
  version: string;
  published: PublishedVersion | null;
  /** The channel the push asked for; stable when omitted. */
  requestedChannel?: string;
}): RegistryCheckResult {
  if (input.published && input.published.version === input.version) {
    const requestedChannel = input.requestedChannel ?? "stable";
    const existingChannel = input.published.channel;
    return {
      name: "version-exists",
      status: "failed",
      message: versionExistsMessage({
        extensionName: input.extensionName,
        version: input.version,
        existingChannel,
        requestedChannel,
      }),
      existingChannel,
      requestedChannel,
    };
  }
  return {
    name: "version-exists",
    status: "passed",
    message:
      `Version ${input.version} is not published for ${input.extensionName}.`,
  };
}

function versionExistsMessage(input: {
  extensionName: string;
  version: string;
  existingChannel: string;
  requestedChannel: string;
}): string {
  const { extensionName, version, existingChannel, requestedChannel } = input;
  switch (placeExistingVersion(existingChannel, requestedChannel)) {
    case "same-channel":
      return `Version ${version} already exists for ${extensionName}.`;
    case "lower-channel":
      return `Version ${version} already exists for ${extensionName} on channel '${existingChannel}'. ` +
        `To move it to '${requestedChannel}' without re-publishing, run: ` +
        promoteCommand(extensionName, version, requestedChannel);
    case "higher-channel":
      return `Version ${version} already exists for ${extensionName} on channel '${existingChannel}', ` +
        `above '${requestedChannel}'. A version cannot move down a channel; publish a new version instead.`;
  }
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
 * the push would have stopped there; checks never asked (no credentials) and
 * ones the registry's answer left undecided leave the run green, and the
 * summary says they did not run.
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
