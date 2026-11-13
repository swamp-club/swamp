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
 * What the Swampify page shows, joined from the items as they are. Nothing
 * here computes a figure: the page shows the ranges, counts and rates the
 * writers stored, and only formats them.
 */

import {
  SWAMPIFY_THIN_BELOW,
  type SwampifyCandidate,
  type SwampifyCandidateSet,
  type SwampifyCandidateSetSummary,
  type SwampifyOffer,
  type SwampifyOfferOption,
  type SwampifyRange,
} from "./agent_sessions/swampify.ts";
import { formatCompactCount, formatDuration } from "./format.ts";

export type SwampifyConsidered = SwampifyOffer["considered"][number];

/** An option's candidate as the shown set knows it. */
export type OptionCandidate =
  | { readonly state: "found"; readonly candidate: SwampifyCandidate }
  | { readonly state: "missing"; readonly id: string }
  | { readonly state: "unreadable"; readonly id: string };

export interface OptionView {
  readonly option: SwampifyOfferOption;
  readonly candidates: readonly OptionCandidate[];
  readonly picked: boolean;
}

export interface OfferView {
  readonly offer: SwampifyOffer;
  /**
   * The offer names a candidate set other than the one shown: a later
   * assessment replaced the set it was built from.
   */
  readonly earlier: boolean;
  readonly options: readonly OptionView[];
}

function sameInstant(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return !Number.isNaN(x) && x === y;
}

/**
 * Joins the offer to the shown set. `set` is null when the set did not read,
 * and its candidates are then unreadable rather than missing;
 * `setGeneratedAt` is the shown set's tag, known even when its body is not.
 */
export function offerView(
  offer: SwampifyOffer,
  set: SwampifyCandidateSet | null,
  setGeneratedAt: string | undefined,
): OfferView {
  const byId = new Map(set?.candidates.map((c) => [c.id, c]) ?? []);
  const pickedId = offer.state.kind === "picked" ||
      offer.state.kind === "built"
    ? offer.state.optionId
    : undefined;
  return {
    offer,
    earlier: setGeneratedAt !== undefined &&
      !sameInstant(offer.candidateSet.generatedAt, setGeneratedAt),
    options: offer.options.map((option) => ({
      option,
      picked: option.id === pickedId,
      candidates: option.candidateIds.map((id): OptionCandidate => {
        if (set === null) return { state: "unreadable", id };
        const candidate = byId.get(id);
        return candidate
          ? { state: "found", candidate }
          : { state: "missing", id };
      }),
    })),
  };
}

/** Why the offer left each considered candidate out, by candidate id. */
export function consideredById(
  offer: SwampifyOffer | null,
): ReadonlyMap<string, SwampifyConsidered> {
  return new Map(offer?.considered.map((c) => [c.candidateId, c]) ?? []);
}

/** The option each offered candidate belongs to, by candidate id. */
export function optionByCandidate(
  offer: SwampifyOffer | null,
): ReadonlyMap<string, SwampifyOfferOption> {
  const map = new Map<string, SwampifyOfferOption>();
  for (const option of offer?.options ?? []) {
    for (const id of option.candidateIds) map.set(id, option);
  }
  return map;
}

export type SetFullness = "empty" | "thin" | "full";

/** From the summary's `thin` when it reads, else the contract's threshold. */
export function setFullness(
  set: SwampifyCandidateSet,
  summary: SwampifyCandidateSetSummary | undefined,
): SetFullness {
  if (set.candidates.length === 0) return "empty";
  const thin = summary?.thin ?? set.candidates.length < SWAMPIFY_THIN_BELOW;
  return thin ? "thin" : "full";
}

export const KIND_LABEL: Readonly<Record<SwampifyCandidate["kind"], string>> = {
  "prompt-repeat": "Repeated prompt",
  "call-sequence": "Call sequence",
  "covered-cli": "CLI run directly",
  "headless-job": "Headless job",
};

export const CONSIDERED_LABEL: Readonly<
  Record<SwampifyConsidered["reason"], string>
> = {
  "not-a-chore": "Not a chore",
  "merged": "Merged",
  "low-value": "Low value",
};

/** The UTC date of an ISO time, as "2026-11-10". */
export function formatDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

const SHORT_DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** The UTC date of an ISO time, as "Nov 10". */
export function formatShortDay(iso: string): string {
  return SHORT_DAY.format(new Date(iso));
}

const HARNESS_NAME: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

const START_HARNESS: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  codex: "codex",
};

/** The agent `swamp start` launches for a session harness, or null. */
export function startHarnessId(harness: string): string | null {
  return START_HARNESS[harness] ?? null;
}

/** Hands a start task to the local hub, which opens the agent on it. */
export type SwampifyLauncher = (
  text: string,
  harness: string,
) => Promise<{ readonly opened: boolean; readonly command: string }>;

/** A harness id as people say it; an unknown one as stored. */
export function harnessName(harness: string): string {
  return HARNESS_NAME[harness] ?? harness;
}

/** A stored share from 0 to 1, as a whole percent. */
export function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** "min – max" of a stored range, in the given format. */
export function formatSpread(
  range: SwampifyRange,
  format: (n: number) => string = formatCompactCount,
): string {
  return range.min === range.max
    ? format(range.min)
    : `${format(range.min)} – ${format(range.max)}`;
}

export function formatTokens(n: number): string {
  return formatCompactCount(Math.round(n));
}

export { formatDuration };

/** Break-even as stored: a count or a span of counts, or never. */
export function formatBreakEven(
  breakEven: { readonly low: number | null; readonly high: number | null },
): string {
  if (breakEven.low === null) return "Never pays back";
  // low is against whole turns and high against the chore's own calls
  if (breakEven.high === null) {
    return `After ${
      formatCompactCount(breakEven.low)
    } runs against whole turns; never against the chore's own calls`;
  }
  if (breakEven.high === breakEven.low) {
    return `After ${formatCompactCount(breakEven.low)} runs`;
  }
  return `After ${formatCompactCount(breakEven.low)} – ${
    formatCompactCount(breakEven.high)
  } runs`;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export function formatUsd(amount: number): string {
  return USD.format(amount);
}
