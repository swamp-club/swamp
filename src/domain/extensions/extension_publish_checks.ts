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
 * repeats what the registry reported at sign-in and fails on the standings the
 * registry always refuses (a free plan with no trial, or whose trial has
 * ended: the registry never starts a trial at publish); every other standing
 * is reported as the registry's data, never as a prediction.
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
 * none for the collective, or a trial state this client does not know), so
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
  /** version-exists only: the existing version is yanked. */
  existingYanked?: true;
  /** version-exists only: why the existing version was yanked, when given. */
  existingYankReason?: string;
  /** A passed authentication only: the credential the registry accepted. */
  credential?: SignedInCredential;
}

/**
 * The credential a passed authentication check names, in the field names
 * `swamp auth whoami --json` uses. The fingerprint is the one swamp-club
 * lists beside each key, never the key itself.
 */
export interface SignedInCredential {
  username?: string;
  collectiveToken?: true;
  collectiveSlug?: string;
  fingerprint: string;
}

/** Who the registry says a key belongs to, from its whoami answer. */
export interface SignedInIdentity {
  /** The personal account's username; empty or absent for an API token. */
  username: string;
  /** True when the key is an API token for a collective. */
  collectiveToken?: boolean;
  /** The collective an API token is for. */
  collectiveSlug?: string;
  fingerprint: string;
}

/**
 * The passed authentication check, naming the credential it used: the
 * username for a personal key, or the collective and fingerprint for an API
 * token. Never interpolates an empty name.
 */
export function signedInCheck(identity: SignedInIdentity): RegistryCheckResult {
  const { fingerprint } = identity;
  if (identity.collectiveToken || !identity.username) {
    const slug = identity.collectiveToken ? identity.collectiveSlug : undefined;
    return {
      name: "authentication",
      status: "passed",
      message: slug
        ? `Signed in with an API token for @${slug} (fingerprint ${fingerprint}).`
        : `Signed in with an API token (fingerprint ${fingerprint}).`,
      credential: {
        ...(identity.collectiveToken ? { collectiveToken: true as const } : {}),
        ...(slug ? { collectiveSlug: slug } : {}),
        fingerprint,
      },
    };
  }
  return {
    name: "authentication",
    status: "passed",
    message: `Signed in as ${identity.username}.`,
    credential: { username: identity.username, fingerprint },
  };
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
export type ApiCallService = "registry" | "osv" | "npm" | "jsr" | "other";

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
  if (host === "jsr.io") return "jsr";
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
 * caller's username stands in for it; with no username either (an API
 * token), the check does not run. Failure messages are the ones a real push
 * throws.
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

  // Neither a membership list nor a username to stand in for it: nothing
  // says whether the caller belongs, so the check could not run. The cause
  // keeps a dry run red, as the push would refuse.
  if (!input.collectives && !input.username) {
    return {
      reserved,
      membership: {
        name: "collective-membership",
        status: "not-run",
        message:
          `Could not check that @${collective} is one of your collectives: ` +
          `the registry did not report your collectives, and this credential ` +
          `has no username to check against.`,
        cause: "registry-unavailable",
      },
    };
  }

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
  /** The trial's full length in days, when the registry sent it. */
  totalDays?: number;
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
  /**
   * The registry's own verdict on private extensions for the collective:
   * `allowed`, `trial-ended` or `paywalled` today. Absent from registries
   * that predate it; any other value is one this client does not know.
   */
  privateExtensions?: string;
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

const PAID_PLAN_REQUIRED = "Private extensions need a paid plan";

/** The registry's own answer on private extensions, when it is one we know. */
type PrivateExtensionsVerdict = "allowed" | "trial-ended" | "paywalled";

function isKnownVerdict(value: string): value is PrivateExtensionsVerdict {
  return value === "allowed" || value === "trial-ended" ||
    value === "paywalled";
}

/** The plan as the registry labels it, falling back to its id. */
function planLabel(entitlement: CollectiveEntitlement): string {
  return entitlement.planName ?? entitlement.plan ?? "";
}

/** A paid plan: anything but no plan, a Personal License or admin standing. */
function isPaidPlan(plan: string | undefined): boolean {
  return plan !== undefined && plan !== "free" && plan !== "personal" &&
    plan !== "admin";
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
    ? `its free trial (${days}, ends ${isoDate(trial.endsAt)})`
    : `its free trial (${days})`;
}

/**
 * What the registry reported for a collective, as one outcome: allowed or
 * refused with the sentence that says why, or undecided with the reason the
 * registry is left to decide at publish.
 */
type EntitlementAssessment =
  | { kind: "allowed"; sentence: string }
  | { kind: "refused"; sentence: string }
  | { kind: "undecided"; reason: string };

/** Why a collective is allowed, from the standing the registry reported. */
function allowedSentence(
  collective: string,
  entitlement: CollectiveEntitlement,
): string {
  const allows = "which allows private extensions.";
  if (entitlement.plan === "admin") {
    return `Collective "@${collective}" has admin standing, ${allows}`;
  }
  if (isPaidPlan(entitlement.plan)) {
    return `Collective "@${collective}" is on the ${
      planLabel(entitlement)
    } plan, ${allows}`;
  }
  const trial = entitlement.trial ?? undefined;
  if (trial?.state === "active") {
    return `Collective "@${collective}" is in ${activeTrial(trial)}, ${allows}`;
  }
  // The registry allows it although the collective's own standing does not:
  // a personal namespace covered by a collective its owner belongs to.
  return `Collective "@${collective}" is covered by a paid plan or active trial on another collective you belong to, ${allows}`;
}

/** Why a collective is refused, naming what it needs and where to get it. */
function refusedSentence(
  collective: string,
  entitlement: CollectiveEntitlement,
  verdict: "trial-ended" | "paywalled",
  serverUrl: string,
): string {
  const upgrade = `upgrade at ${collectiveBillingUrl(serverUrl, collective)}.`;
  if (verdict === "trial-ended") {
    const totalDays = entitlement.trial?.totalDays;
    const length = typeof totalDays === "number" && totalDays > 0
      ? `${totalDays}-day `
      : "";
    return `Collective "@${collective}"'s ${length}free trial has ended. ${PAID_PLAN_REQUIRED}; ${upgrade}`;
  }
  if (entitlement.plan === "personal") {
    return `Collective "@${collective}" has a Personal License, which does not include private extensions. ${PAID_PLAN_REQUIRED}; ${upgrade}`;
  }
  return `Private extensions in "@${collective}" need a paid plan; ${upgrade}`;
}

/**
 * Decides a collective's private entitlement from what the registry reported.
 *
 * The registry's `privateExtensions` verdict decides when it is present: it
 * already applies rules the plan and trial cannot show, such as a personal
 * namespace covered by another collective its owner belongs to. A verdict
 * this client does not know is undecided. A registry that sends no verdict
 * (an older or self-hosted one) is decided from plan and trial: a paid plan
 * or an active trial is allowed, an ended trial or none is refused (a trial
 * starts only when its collective is created, never at publish).
 */
function assessEntitlement(
  collective: string,
  entitlement: CollectiveEntitlement | undefined,
  serverUrl: string,
): EntitlementAssessment {
  const unreported: EntitlementAssessment = {
    kind: "undecided",
    reason: `the registry did not report entitlement for "@${collective}"`,
  };
  if (!entitlement) return unreported;
  const reported = entitlement.privateExtensions;
  let verdict: PrivateExtensionsVerdict;
  if (reported !== undefined) {
    if (!isKnownVerdict(reported)) {
      return {
        kind: "undecided",
        reason:
          `the registry reported a private-extensions verdict for "@${collective}" that this client does not know`,
      };
    }
    verdict = reported;
  } else {
    if (entitlement.plan === undefined) return unreported;
    const trial = entitlement.trial ?? undefined;
    if (entitlement.plan === "personal") {
      return {
        kind: "undecided",
        reason:
          `the registry did not say whether the Personal License on "@${collective}" includes private extensions`,
      };
    }
    if (entitlement.plan === "admin" || isPaidPlan(entitlement.plan)) {
      verdict = "allowed";
    } else if (trial?.state === "active") {
      verdict = "allowed";
    } else if (trial?.state === "expired") {
      verdict = "trial-ended";
    } else if (trial === undefined || trial.state === "none") {
      verdict = "paywalled";
    } else {
      return {
        kind: "undecided",
        reason:
          `the registry reported a trial state for "@${collective}" that this client does not know`,
      };
    }
  }
  return verdict === "allowed"
    ? { kind: "allowed", sentence: allowedSentence(collective, entitlement) }
    : {
      kind: "refused",
      sentence: refusedSentence(collective, entitlement, verdict, serverUrl),
    };
}

/**
 * Decides the private-entitlement check from what the registry reported.
 *
 * An allowed collective passes, saying why: its paid plan, its free trial,
 * admin standing, or (for a personal namespace) another collective's cover. A
 * refused one fails with the message a real push throws, naming what it
 * needs and the upgrade page; no message ever names a plan the collective is
 * not on. No entitlement for the collective is undecided and says the
 * registry did not report it, as is anything else this client cannot read.
 */
export function evaluatePrivateEntitlement(
  input: PrivateEntitlementInput,
): RegistryCheckResult {
  const collective = collectiveOf(input.extensionName);
  const name = "private-entitlement";
  const assessment = assessEntitlement(
    collective,
    input.entitlements?.find((e) => e.slug === collective),
    input.serverUrl,
  );
  switch (assessment.kind) {
    case "allowed":
      return { name, status: "passed", message: assessment.sentence };
    case "refused":
      return { name, status: "failed", message: assessment.sentence };
    case "undecided":
      return registryCheckNotRun(
        name,
        "entitlement-undecided",
        `${assessment.reason}; private publication is decided at publish`,
      );
  }
}

/** A sentence carried after "reported that", its first letter lowered. */
function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

/**
 * The registry's own refusal of a private publication, followed by what it
 * reported for the collective at sign-in. The report is stated as a report,
 * never as the cause: the registry decided, and this says what it had said
 * about the collective, in the words the entitlement check uses. The upgrade
 * pointer comes only with a refusal the registry had already reported.
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
  const assessment = assessEntitlement(
    collective,
    input.entitlement,
    input.serverUrl,
  );
  if (assessment.kind === "undecided") {
    return `${refusal} At sign-in ${assessment.reason}.`;
  }
  return `${refusal} At sign-in the registry reported that ${
    lowerFirst(assessment.sentence)
  }`;
}

/** A published version as the registry lists it. */
export interface PublishedVersion {
  version: string;
  channel: string;
  /** Present when the version is yanked; `reason` is null when none was given. */
  yank?: { reason: string | null };
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

/** A yank's reason as a parenthesis, or nothing when none was given. */
function yankReasonSuffix(reason: string | null | undefined): string {
  return reason ? ` (${reason})` : "";
}

/**
 * The refusal for promoting a yanked version, in the registry's own wording,
 * so it reads the same whether the client or the registry refuses.
 */
export function yankedVersionPromoteRefusal(
  extensionName: string,
  version: string,
  reason: string | null,
): string {
  return `Version ${version} of ${extensionName} has been yanked${
    yankReasonSuffix(reason)
  } and cannot be promoted`;
}

/**
 * Decides the version-exists check. A version is unique per extension across
 * every release channel, so a match on any channel fails the check with the
 * message a real push throws. A duplicate on the requested channel keeps the
 * plain message; a match on another channel names that channel and, when the
 * version sits on a lower one, the promote command that moves it. A yanked
 * version stays taken, so it fails too, but its message names the yank and
 * never the promote command: the registry refuses to promote it.
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
    const yank = input.published.yank;
    if (yank) {
      return {
        name: "version-exists",
        status: "failed",
        message:
          `Version ${input.version} already exists for ${input.extensionName} on channel '${existingChannel}' ` +
          `and has been yanked${yankReasonSuffix(yank.reason)}. ` +
          `A yanked version stays taken and cannot be promoted; publish a new version instead.`,
        existingChannel,
        requestedChannel,
        existingYanked: true,
        ...(yank.reason ? { existingYankReason: yank.reason } : {}),
      };
    }
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
