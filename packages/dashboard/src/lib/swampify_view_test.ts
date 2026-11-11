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

import { assertEquals } from "@std/assert";
import { agentSessionDataName } from "../../../../src/domain/agent_sessions/session_record.ts";
import {
  CANDIDATE_IDS,
  emptyCandidateSet,
  fixtureCandidateSet,
  fixtureOffer,
  MISSING_SESSION_REF,
  OPTION_IDS,
  SET_GENERATED_AT,
  thinCandidateSet,
  UNKNOWN_CANDIDATE_ID,
} from "../views/agent_sessions/swampify_fixtures.ts";
import { fixtureSessions } from "../views/agent_sessions/fixtures.ts";
import {
  consideredById,
  formatBreakEven,
  formatRate,
  formatSpread,
  offerView,
  optionByCandidate,
  sessionRefTarget,
  setFullness,
} from "./swampify_view.ts";

Deno.test("offerView: options resolve their candidates against the shown set, and the pick is marked", () => {
  const set = fixtureCandidateSet();
  const view = offerView(fixtureOffer("built"), set, SET_GENERATED_AT);
  assertEquals(view.earlier, false);
  assertEquals(view.options.map((o) => o.picked), [true, false]);
  assertEquals(
    view.options[0].candidates.map((c) =>
      c.state === "found" ? c.candidate.id : c.state
    ),
    [CANDIDATE_IDS[0], CANDIDATE_IDS[2]],
  );
});

Deno.test("offerView: an offer from an earlier assessment is marked, and its unknown candidates read as no longer found", () => {
  const offer = fixtureOffer("offered");
  offer.options[1].candidateIds = [UNKNOWN_CANDIDATE_ID];
  const view = offerView(offer, fixtureCandidateSet(), "2026-11-11T00:00:00Z");
  assertEquals(view.earlier, true);
  assertEquals(view.options[1].candidates, [
    { state: "missing", id: UNKNOWN_CANDIDATE_ID },
  ]);
  assertEquals(view.options.map((o) => o.picked), [false, false]);
});

Deno.test("offerView: the same instant written differently is the same assessment", () => {
  const view = offerView(
    fixtureOffer("offered"),
    fixtureCandidateSet(),
    "2026-11-10T09:00:00Z",
  );
  assertEquals(view.earlier, false);
});

Deno.test("offerView: with the set unread, candidates are not readable rather than missing", () => {
  const view = offerView(fixtureOffer("picked"), null, SET_GENERATED_AT);
  assertEquals(
    view.options.flatMap((o) => o.candidates.map((c) => c.state)),
    ["unreadable", "unreadable", "unreadable"],
  );
});

Deno.test("consideredById and optionByCandidate: where each candidate stands in the offer", () => {
  const offer = fixtureOffer("built");
  const considered = consideredById(offer);
  assertEquals(considered.get(CANDIDATE_IDS[4])?.into, CANDIDATE_IDS[0]);
  assertEquals(considered.get(CANDIDATE_IDS[3])?.reason, "low-value");
  const options = optionByCandidate(offer);
  assertEquals(options.get(CANDIDATE_IDS[2])?.id, OPTION_IDS[0]);
  assertEquals(options.get(CANDIDATE_IDS[1])?.id, OPTION_IDS[1]);
  assertEquals(options.has(CANDIDATE_IDS[3]), false);
  assertEquals(consideredById(null).size, 0);
});

Deno.test("setFullness: empty, thin from the summary's flag, or full", () => {
  assertEquals(setFullness(emptyCandidateSet(), undefined), "empty");
  assertEquals(setFullness(thinCandidateSet(), undefined), "thin");
  assertEquals(
    setFullness(fixtureCandidateSet(), {
      since: "",
      until: "",
      harnesses: ["claude-code"],
      candidates: 6,
      thin: false,
      interactive: 5,
      headless: 1,
      kinds: {
        "prompt-repeat": 3,
        "call-sequence": 1,
        "covered-cli": 1,
        "headless-job": 1,
      },
    }),
    "full",
  );
});

Deno.test("sessionRefTarget: links only a session the page loaded, and never throws on a ref the record refuses", () => {
  const [edits] = fixtureSessions();
  const name = agentSessionDataName(edits.harness, edits.id);
  const loaded = new Set([name]);
  assertEquals(
    sessionRefTarget({ harness: edits.harness, sessionId: edits.id }, loaded),
    name,
  );
  assertEquals(sessionRefTarget(MISSING_SESSION_REF, loaded), null);
  assertEquals(
    sessionRefTarget({ harness: "Bad_Harness", sessionId: "x" }, loaded),
    null,
  );
});

Deno.test("formatting: shows stored figures without combining them", () => {
  assertEquals(formatRate(0.22), "22%");
  assertEquals(formatSpread({ min: 3, median: 9, max: 31 }), "3 – 31");
  assertEquals(formatSpread({ min: 5, median: 5, max: 5 }), "5");
  assertEquals(formatBreakEven({ low: null, high: null }), "Never pays back");
  assertEquals(formatBreakEven({ low: 4, high: 11 }), "After 4 – 11 runs");
  assertEquals(formatBreakEven({ low: 4, high: 4 }), "After 4 runs");
  assertEquals(
    formatBreakEven({ low: 4, high: null }),
    "After 4 runs against whole turns; never against the chore's own calls",
  );
});
