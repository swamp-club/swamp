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
 * Synthetic Swampify items for tests, the integration test and screenshots.
 * Every label, excerpt, model and name here is made up. Ids have the
 * contract's shapes but are written out, since the id helpers are async;
 * option ids are not the hash of their candidates, which only the writer
 * derives.
 */

import type {
  SwampifyCandidate,
  SwampifyCandidateSet,
  SwampifyComparison,
  SwampifyOffer,
  SwampifyOfferState,
  SwampifyRange,
} from "../../lib/agent_sessions/swampify.ts";
import { fixtureSessions } from "../agent_sessions/fixtures.ts";

const [edits, long, , headless] = fixtureSessions();

/** A session ref with no record on the page. */
export const MISSING_SESSION_REF = {
  harness: "codex",
  sessionId: "9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4",
} as const;

export const CANDIDATE_IDS = [
  "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
  "1b2c3d4e5f60718293a4b5c6d7e8f90a",
  "2c3d4e5f60718293a4b5c6d7e8f90a1b",
  "3d4e5f60718293a4b5c6d7e8f90a1b2c",
  "4e5f60718293a4b5c6d7e8f90a1b2c3d",
  "5f60718293a4b5c6d7e8f90a1b2c3d4e",
] as const;

export const OPTION_IDS = ["a1b2c3d4e5f60718", "b2c3d4e5f60718a9"] as const;

/** A candidate id no fixture set holds. */
export const UNKNOWN_CANDIDATE_ID = "ffffffffffffffffffffffffffffffff";

export const SET_GENERATED_AT = "2026-11-10T09:00:00.000Z";

function range(min: number, median: number, max: number): SwampifyRange {
  return { min, median, max };
}

function cost(scale: number) {
  return {
    tokens: {
      input: range(800 * scale, 2_400 * scale, 9_000 * scale),
      output: range(300 * scale, 1_100 * scale, 4_200 * scale),
      cacheRead: range(20_000 * scale, 61_000 * scale, 240_000 * scale),
      cacheWrite: range(1_500 * scale, 5_200 * scale, 18_000 * scale),
    },
    weightedTokens: range(4_600 * scale, 14_800 * scale, 55_200 * scale),
    toolCalls: range(3 * scale, 9 * scale, 31 * scale),
    activeMs: range(40_000 * scale, 150_000 * scale, 610_000 * scale),
  };
}

const refs = {
  edits: { harness: edits.harness, sessionId: edits.id },
  long: { harness: long.harness, sessionId: long.id },
  headless: { harness: headless.harness, sessionId: headless.id },
};

function candidates(): SwampifyCandidate[] {
  return [
    {
      id: CANDIDATE_IDS[0],
      kind: "prompt-repeat",
      invocation: "interactive",
      label: "release the docs site and post the changelog",
      score: 412_000,
      rank: 1,
      occurrences: 18,
      sessions: 14,
      directories: 3,
      firstSeen: "2026-10-12T08:14:00.000Z",
      lastSeen: "2026-11-09T16:40:00.000Z",
      perOccurrence: cost(3),
      failureRate: 0.22,
      sessionRefs: [refs.long, refs.edits, MISSING_SESSION_REF],
      excerpts: [
        {
          source: "prompt",
          session: refs.long,
          text: "release the docs site and post the changelog to the team",
        },
        {
          source: "prompt",
          session: refs.edits,
          text: "release the docs site again, the last build failed",
        },
      ],
    },
    {
      id: CANDIDATE_IDS[1],
      kind: "headless-job",
      invocation: "headless",
      label: "summarise yesterday's failed builds",
      score: 288_000,
      rank: 2,
      occurrences: 29,
      sessions: 29,
      directories: 1,
      firstSeen: "2026-10-11T03:00:00.000Z",
      lastSeen: "2026-11-09T03:00:00.000Z",
      perOccurrence: cost(1),
      failureRate: 0,
      sessionRefs: [refs.headless],
      excerpts: [
        {
          source: "prompt",
          session: refs.headless,
          text: "summarise yesterday's failed builds and open an issue for",
          truncated: true,
        },
      ],
    },
    {
      id: CANDIDATE_IDS[2],
      kind: "call-sequence",
      invocation: "interactive",
      label: "make lint → make test → git push",
      score: 120_500,
      rank: 3,
      occurrences: 41,
      sessions: 12,
      directories: 4,
      firstSeen: "2026-10-13T10:02:00.000Z",
      lastSeen: "2026-11-08T18:22:00.000Z",
      perOccurrence: cost(0.5),
      failureRate: 0.12,
      sessionRefs: [refs.edits],
      steps: ["make lint", "make test", "git push"],
      excerpts: [
        { source: "call", session: refs.edits, text: "make lint && make test" },
      ],
    },
    {
      id: CANDIDATE_IDS[3],
      kind: "covered-cli",
      invocation: "interactive",
      label: "kubectl run directly",
      score: 61_000,
      rank: 4,
      occurrences: 23,
      sessions: 9,
      directories: 2,
      firstSeen: "2026-10-15T11:30:00.000Z",
      lastSeen: "2026-11-07T15:05:00.000Z",
      perOccurrence: cost(0.3),
      failureRate: 0.35,
      sessionRefs: [refs.long],
      program: "kubectl",
      excerpts: [
        { source: "call", session: refs.long, text: "kubectl get pods -n web" },
      ],
    },
    {
      id: CANDIDATE_IDS[4],
      kind: "prompt-repeat",
      invocation: "interactive",
      label: "publish the docs and announce it",
      score: 40_000,
      rank: 5,
      occurrences: 6,
      sessions: 5,
      directories: 1,
      firstSeen: "2026-10-20T09:00:00.000Z",
      lastSeen: "2026-11-02T09:00:00.000Z",
      perOccurrence: cost(2),
      failureRate: 0.17,
      sessionRefs: [],
      excerpts: [],
    },
    {
      id: CANDIDATE_IDS[5],
      kind: "prompt-repeat",
      invocation: "interactive",
      label: "what does this error mean",
      score: 12_000,
      rank: 6,
      occurrences: 9,
      sessions: 7,
      directories: 5,
      firstSeen: "2026-10-18T13:00:00.000Z",
      lastSeen: "2026-11-06T17:00:00.000Z",
      perOccurrence: cost(0.2),
      failureRate: 0,
      sessionRefs: [],
      excerpts: [],
    },
  ];
}

/** A populated set of six candidates, one of each kind and more. */
export function fixtureCandidateSet(
  overrides: Partial<SwampifyCandidateSet> = {},
): SwampifyCandidateSet {
  return {
    schemaVersion: 2,
    generatedAt: SET_GENERATED_AT,
    importerVersion: "2026.11.10.1",
    window: {
      since: "2026-10-11T00:00:00.000Z",
      until: "2026-11-09T23:59:00.000Z",
    },
    scope: {
      harnesses: ["claude-code", "codex"],
      all: true,
      include: [],
      exclude: ["~/private"],
    },
    candidates: candidates(),
    ...overrides,
  };
}

/** A thin set: fewer than three candidates. */
export function thinCandidateSet(): SwampifyCandidateSet {
  return fixtureCandidateSet({ candidates: candidates().slice(0, 2) });
}

/** An empty set: nothing repeated. */
export function emptyCandidateSet(): SwampifyCandidateSet {
  return fixtureCandidateSet({ candidates: [] });
}

/**
 * A set whose text tries to be markup and links; the panel must show every
 * piece of it as text.
 */
export const HOSTILE_TEXT = {
  label: '<img src=x onerror="alert(1)"> [docs](javascript:alert(2))',
  excerpt:
    '<script>alert(3)</script> <a href="javascript:alert(4)">x</a> https://evil.example/path',
  step: "<b>bold</b>",
} as const;

export function hostileCandidateSet(): SwampifyCandidateSet {
  const [first, , sequence] = candidates();
  return fixtureCandidateSet({
    candidates: [
      {
        ...first,
        label: HOSTILE_TEXT.label,
        excerpts: [{
          source: "prompt",
          session: refs.long,
          text: HOSTILE_TEXT.excerpt,
        }],
      },
      {
        ...sequence,
        rank: 2,
        steps: [HOSTILE_TEXT.step, "git push"],
      },
    ],
  });
}

const PICKED_AT = "2026-11-10T09:20:00.000Z";

/** An offer in each state the contract allows. */
export function fixtureOffer(
  state: SwampifyOfferState["kind"] = "built",
): SwampifyOffer {
  const states: Record<SwampifyOfferState["kind"], SwampifyOfferState> = {
    offered: { kind: "offered" },
    picked: { kind: "picked", optionId: OPTION_IDS[0], pickedAt: PICKED_AT },
    built: {
      kind: "built",
      optionId: OPTION_IDS[0],
      pickedAt: PICKED_AT,
      target: { kind: "workflow", name: "release-docs" },
      builtAt: "2026-11-10T09:50:00.000Z",
    },
    declined: { kind: "declined", declinedAt: PICKED_AT },
  };
  return {
    schemaVersion: 1,
    createdAt: "2026-11-10T09:10:00.000Z",
    updatedAt: "2026-11-10T09:55:00.000Z",
    writerVersion: "2026.11.10.1",
    candidateSet: { generatedAt: SET_GENERATED_AT },
    reading: {
      harness: "claude-code",
      model: "claude-sonnet-5-5",
      candidates: 6,
      sessions: 18,
    },
    options: [
      {
        id: OPTION_IDS[0],
        name: "Release the docs site",
        why: "You do it most weeks, by hand, and one in five runs fails.",
        becomes: "workflow",
        outline: ["build the site", "publish it", "post the changelog"],
        candidateIds: [CANDIDATE_IDS[0], CANDIDATE_IDS[2]],
      },
      {
        id: OPTION_IDS[1],
        name: "Nightly failed-build summary",
        why: "A headless job that already runs every night through the agent.",
        becomes: "behavior",
        registryType: "@acme/ci-report",
        candidateIds: [CANDIDATE_IDS[1]],
      },
    ],
    considered: [
      { candidateId: CANDIDATE_IDS[3], reason: "low-value" },
      {
        candidateId: CANDIDATE_IDS[4],
        reason: "merged",
        into: CANDIDATE_IDS[0],
      },
      { candidateId: CANDIDATE_IDS[5], reason: "not-a-chore" },
    ],
    state: states[state],
  };
}

/** The comparison for the built option. */
export function fixtureComparison(
  overrides: Partial<SwampifyComparison> = {},
): SwampifyComparison {
  const chore = cost(1);
  const whole = cost(3);
  const strip = ({ weightedTokens: _, ...rest }: typeof chore) => rest;
  return {
    schemaVersion: 2,
    generatedAt: "2026-11-10T10:30:00.000Z",
    importerVersion: "2026.11.10.1",
    optionId: OPTION_IDS[0],
    candidateIds: [CANDIDATE_IDS[0], CANDIDATE_IDS[2]],
    target: { kind: "workflow", name: "release-docs" },
    build: {
      tokens: {
        input: 52_000,
        output: 18_000,
        cacheRead: 900_000,
        cacheWrite: 61_000,
      },
      activeMs: 1_260_000,
    },
    history: {
      occurrences: 59,
      perOccurrence: { chore: strip(chore), wholeTurns: strip(whole) },
    },
    swampRun: {
      wallMs: 48_000,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      outcome: "succeeded",
    },
    forward: {
      since: "2026-11-10T10:00:00.000Z",
      raw: { occurrences: 0 },
      swamp: { occurrences: 0 },
    },
    breakEven: { low: 4, high: 11 },
    estimatedUsd: { build: 3.1, swampRun: 0 },
    ...overrides,
  };
}
