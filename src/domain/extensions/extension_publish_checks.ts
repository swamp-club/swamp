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
 * verdicts carry the wording a real push fails with, so a dry run matches it;
 * entitlement is the registry's to decide, so only a free plan with no or an
 * ended trial fails and other standings are not predicted
 */

import { ModelType } from "../models/model_type.ts";
import { ReleaseChannel } from "./release_channel.ts";

export type RegistryCheckName =
  | "authentication"
  | "collective-membership"
  | "reserved-collective"
  | "version-exists"
  | "private-entitlement";

/**
 * not-run means a prerequisite was missing (no credentials, failed sign-in,
 * unreachable registry); its message says which
 */
export type RegistryCheckStatus = "passed" | "failed" | "not-run";

/**
 * no-credentials and entitlement-undecided leave a dry run green: the registry
 * was not asked or its answer does not settle entitlement; other causes mean it
 * did not confirm, which a real push fails on
 */
export type RegistryCheckNotRunCause =
  | "no-credentials"
  | "authentication-failed"
  | "registry-unavailable"
  | "membership-unverified"
  | "entitlement-undecided";

export interface RegistryCheckResult {
  name: RegistryCheckName;
  status: RegistryCheckStatus;
  message: string;
  cause?: RegistryCheckNotRunCause;
  existingChannel?: string;
  requestedChannel?: string;
  existingYanked?: true;
  existingYankReason?: string;
  credential?: SignedInCredential;
}

/**
 * the fingerprint is the one swamp-club lists beside each key, never the key
 * itself
 */
export interface SignedInCredential {
  username?: string;
  collectiveToken?: true;
  collectiveSlug?: string;
  fingerprint: string;
}

export interface SignedInIdentity {
  username: string;
  collectiveToken?: boolean;
  collectiveSlug?: string;
  fingerprint: string;
}

/**
 * names the credential used: username for a personal key, collective and
 * fingerprint for an API token; never interpolates an empty name
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
 * enforce throws on the first failing check; collect (dry run) runs every check
 * and gathers verdicts; skip contacts no registry
 */
export type RegistryChecksMode = "enforce" | "collect" | "skip";

export const REGISTRY_CHECK_LABELS: Record<RegistryCheckName, string> = {
  "authentication": "authentication",
  "collective-membership": "collective membership",
  "reserved-collective": "reserved collective",
  "version-exists": "version exists",
  "private-entitlement": "private entitlement",
};

export type ApiCallService = "registry" | "osv" | "npm" | "jsr" | "other";

export type ApiCallOutcome = "ok" | "not-found" | "error";

/**
 * method and URL only, never headers, so no credential can reach the summary; a
 * retried request is listed once per attempt
 */
export interface ApiCallRecord {
  service: ApiCallService;
  method: string;
  url: string;
  outcome: ApiCallOutcome;
  status?: number;
}

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

export function collectiveOf(extensionName: string): string {
  return extensionName.slice(1, extensionName.indexOf("/"));
}

export interface CollectiveMembershipInput {
  extensionName: string;
  /** undefined when the lookup failed and the registry's answer is unknown */
  collectives: string[] | undefined;
  username: string;
}

/**
 * a reserved collective needs the registry's own membership word, so an unknown
 * list fails; otherwise the list decides, falling back to username, and with
 * neither (API token) the check does not run
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

export interface CollectiveTrial {
  state: "none" | "active" | "expired";
  endsAt: string | null;
  daysRemaining: number;
  totalDays?: number;
}

/**
 * structurally the libswamp whoami entitlement, so the domain need not import
 * the application layer; plan is absent when the registry reported none
 */
export interface CollectiveEntitlement {
  slug: string;
  plan?: string;
  planName?: string;
  trial?: CollectiveTrial | null;
  /**
   * the registry's own verdict (allowed, trial-ended or paywalled); absent from
   * older registries, and any other value is unknown to this client
   */
  privateExtensions?: string;
}

export interface PrivateEntitlementInput {
  extensionName: string;
  entitlements: CollectiveEntitlement[] | undefined;
  serverUrl: string;
}

export function collectiveBillingUrl(serverUrl: string, slug: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/o/${slug}/billing`;
}

const PAID_PLAN_REQUIRED = "Private extensions need a paid plan";

type PrivateExtensionsVerdict = "allowed" | "trial-ended" | "paywalled";

function isKnownVerdict(value: string): value is PrivateExtensionsVerdict {
  return value === "allowed" || value === "trial-ended" ||
    value === "paywalled";
}

function planLabel(entitlement: CollectiveEntitlement): string {
  return entitlement.planName ?? entitlement.plan ?? "";
}

function isPaidPlan(plan: string | undefined): boolean {
  return plan !== undefined && plan !== "free" && plan !== "personal" &&
    plan !== "admin";
}

/** never recomputed in local time: the registry's trial dates are elapsed-based */
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

type EntitlementAssessment =
  | { kind: "allowed"; sentence: string }
  | { kind: "refused"; sentence: string }
  | { kind: "undecided"; reason: string };

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
 * the registry's verdict decides when present, since it applies rules plan and
 * trial cannot show; an unknown verdict is undecided; with none, a paid plan or
 * active trial is allowed and anything else refused
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

function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

/**
 * states the registry's report as a report, never the cause; the upgrade
 * pointer comes only with a refusal the registry had already reported
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

export interface PublishedVersion {
  version: string;
  channel: string;
  yank?: { reason: string | null };
}

/**
 * only lower-channel can be promoted; the registry moves a version forward
 * (beta, rc, stable) and never back
 */
export type ExistingVersionPlacement =
  | "same-channel"
  | "lower-channel"
  | "higher-channel";

/**
 * an unknown channel counts as the same channel, so no promotion is offered
 * that the registry has not been seen to allow
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

export function promoteCommand(
  extensionName: string,
  version: string,
  toChannel: string,
): string {
  return `swamp extension promote ${extensionName} ${version} --channel ${toChannel}`;
}

function yankReasonSuffix(reason: string | null | undefined): string {
  return reason ? ` (${reason})` : "";
}

/**
 * uses the registry's wording so the refusal reads the same whether the client
 * or the registry refuses
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
 * a version is unique across all channels, so a match on any fails; a yanked
 * version stays taken but its message never offers the promote command, which
 * the registry refuses
 */
export function evaluateVersionExists(input: {
  extensionName: string;
  version: string;
  published: PublishedVersion | null;
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

export function registryCheckNotRun(
  name: RegistryCheckName,
  cause: RegistryCheckNotRunCause,
  reason: string,
): RegistryCheckResult {
  return { name, status: "not-run", message: reason, cause };
}

/**
 * a failed check ends the run with its message; a check asked but unanswered
 * also ends it; unasked or undecided checks leave it green and the summary says
 * they did not run
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
