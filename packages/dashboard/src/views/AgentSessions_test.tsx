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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import {
  agentSessionDataName,
  agentSessionTags,
} from "../../../../src/domain/agent_sessions/session_record.ts";
import {
  DEFAULT_SESSION_SORT,
  parseListReply,
} from "../client/agent_sessions.ts";
import {
  callKey,
  listTotals,
  mergedFindings,
  sessionTiles,
} from "../lib/agent_session_view.ts";
import { fixtureSessions } from "./agent_sessions/fixtures.ts";
import { SessionsTable } from "./agent_sessions/SessionsTable.tsx";
import {
  FilterChips,
  findingKey,
  FindingsPanel,
  ListTotalsRow,
  SessionStats,
} from "./agent_sessions/SessionOverview.tsx";
import { turnKey, TurnWaterfall } from "./agent_sessions/TurnWaterfall.tsx";
import { CallInspector } from "./agent_sessions/CallInspector.tsx";

const [edits, long, child, headless] = fixtureSessions();

function rows() {
  return parseListReply({
    projected: {
      rows: [edits, long, headless].map((s) => ({
        name: agentSessionDataName(s.harness, s.id),
        modelName: "agent-sessions",
        tags: agentSessionTags(s),
      })),
    },
  }).rows;
}

const noop = () => {};

function waterfall(
  record = long,
  open: string[] = [],
  openSubagents: string[] = [],
) {
  return renderToStaticMarkup(
    <TurnWaterfall
      record={record}
      filter={{ kind: "all" }}
      openTurns={new Set(open)}
      onToggleTurn={noop}
      selected={null}
      onSelect={noop}
      openSubagents={new Set(openSubagents)}
      onToggleSubagent={noop}
      renderSubagent={(id) => <span>subagent-{id}</span>}
    />,
  );
}

Deno.test("SessionsTable: one row per session with the prototype's columns", () => {
  const html = renderToStaticMarkup(
    <SessionsTable
      rows={rows()}
      openName={null}
      onOpen={noop}
      sort={{ key: "calls", dir: "desc" }}
      onSort={noop}
    />,
  );
  // Every column sorts; the sorted one says which way.
  assertEquals(html.split('class="as-sort"').length - 1, 11);
  assertEquals(html.split('aria-sort="descending"').length - 1, 1);
  assertEquals(html.split('aria-sort="none"').length - 1, 10);
  for (
    const column of [
      "Type",
      "Repo",
      "Harness",
      "Started",
      "Length",
      "Turns",
      "Calls",
      "swamp share",
      "Failed",
      "Tokens",
      "Findings",
    ]
  ) {
    assertStringIncludes(html, `>${column}<`);
  }
  assertEquals(html.split('class="as-row"').length - 1, 3);
  // The type icon says what it means on hover.
  assertStringIncludes(html, 'aria-label="Headless: run by automation');
  assertStringIncludes(html, 'aria-label="Interactive: a person steered');
  // Findings and subagents are counts in badges, explained on hover.
  assertStringIncludes(html, 'aria-label="2 high findings">2<');
  assertStringIncludes(html, 'aria-label="1 subagent">+1<');
});

Deno.test("SessionsTable: a row whose summary does not read still opens", () => {
  const [row] = rows();
  const html = renderToStaticMarkup(
    <SessionsTable
      rows={[{ ...row, summary: undefined }]}
      openName={null}
      onOpen={noop}
      sort={DEFAULT_SESSION_SORT}
      onSort={noop}
    />,
  );
  assertStringIncludes(html, "Summary unavailable");
  assertStringIncludes(html, 'tabindex="0"');
});

Deno.test("SessionStats: the session's type, where it ran, and the figures the table row does not show", () => {
  const html = renderToStaticMarkup(
    <SessionStats
      record={edits}
      tiles={sessionTiles(edits)}
      filter={{ kind: "label", label: "bypass" }}
      onFilter={noop}
    />,
  );
  // swamp, bypass and failed filter the turns; the active one is pressed.
  assertEquals(html.split("as-stat-button").length - 1, 3);
  assertStringIncludes(
    html,
    'class="as-stat as-stat-button as-tone-l-bypass" title="',
  );
  assertEquals(html.split('aria-pressed="true"').length - 1, 1);
  assertStringIncludes(html, 'aria-label="Interactive');
  assertStringIncludes(html, edits.repo);
  for (
    const label of [
      "swamp share",
      "bypasses",
      "failed",
      "working",
      "tokens out",
    ]
  ) {
    assertStringIncludes(html, `class="as-stat-label">${label}<`);
  }
  assertStringIncludes(html, "first in turn 2");
  assertStringIncludes(html, 'class="as-mix"');
});

Deno.test("ListTotalsRow: totals over every listed session, with findings as badges", () => {
  const listed = rows();
  const totals = listTotals(listed.map((r) => r.summary));
  const html = renderToStaticMarkup(<ListTotalsRow totals={totals} />);
  assertStringIncludes(html, "Totals across the listed sessions");
  assertStringIncludes(html, "2 interactive, 1 headless");
  assertStringIncludes(html, `/${totals.calls}`);
  const counted = totals.findings.high + totals.findings.medium +
    totals.findings.low;
  assertStringIncludes(html, `>${counted}<`);
  assertStringIncludes(
    html,
    `in ${totals.sessionsWithFindings} session`,
  );
  // The type counts show as the icons the table uses.
  assertStringIncludes(html, 'aria-label="Headless');
  for (const severity of ["high", "medium", "low"] as const) {
    if (totals.findings[severity] > 0) {
      assertStringIncludes(html, `as-sev-${severity}`);
    }
  }
});

Deno.test("TurnWaterfall: the strip and every turn's track share one scale", () => {
  const html = waterfall(edits);
  // One piece of the strip per turn, and the same piece again on each row.
  assertEquals(
    html.split('class="as-strip-turn"').length - 1,
    edits.turns.length * 2,
  );
  assertStringIncludes(html, "idle removed");
  assertStringIncludes(html, `id="as-turn-${edits.id}-1"`);
});

Deno.test("FindingsPanel: headlines only until one is opened", () => {
  const html = renderToStaticMarkup(
    <FindingsPanel
      findings={mergedFindings(long, [child])}
      unloaded={[]}
      openKey={null}
      onToggle={noop}
      onLoadSubagent={noop}
      subagentName={() => "Subagent Explore"}
    />,
  );
  assertStringIncludes(html, "What to look at");
  for (const shown of mergedFindings(long, [child])) {
    assertStringIncludes(html, shown.finding.title);
    // Details and what to tune wait until the headline is opened.
    assert(!html.includes(shown.finding.tune));
  }
  assertStringIncludes(html, "Subagent Explore");
  assertStringIncludes(html, 'aria-expanded="false"');
});

Deno.test("FindingsPanel: an opened finding shows its detail in its own colour, with no separate show button", () => {
  const findings = mergedFindings(long, [child]);
  const shown = findings[0];
  const html = renderToStaticMarkup(
    <FindingsPanel
      findings={findings}
      unloaded={[]}
      openKey={findingKey(shown)}
      onToggle={noop}
      onLoadSubagent={noop}
      subagentName={() => "Subagent Explore"}
    />,
  );
  assertStringIncludes(html, "as-finding-tune");
  assertStringIncludes(html, `as-finding-open-${shown.finding.severity}`);
  assert(!html.includes("Show these"));
});

Deno.test("TurnWaterfall: a finding's calls take the finding's colour; the rest dim", () => {
  const turn = edits.turns.find((t) => t.calls.length > 1)!;
  const [hit] = turn.calls;
  const html = renderToStaticMarkup(
    <TurnWaterfall
      record={edits}
      filter={{
        kind: "calls",
        calls: new Set([callKey(edits.id, hit.id)]),
        severity: "high",
      }}
      openTurns={new Set([turnKey(edits.id, turn.n)])}
      onToggleTurn={noop}
      selected={null}
      onSelect={noop}
      openSubagents={new Set()}
      onToggleSubagent={noop}
      renderSubagent={() => null}
    />,
  );
  assertEquals(html.split('data-sev="high"').length - 1, 1);
  assertEquals(
    html.split('data-dim="true"').length - 1,
    turn.calls.length - 1,
  );
  assertStringIncludes(html, "as-turn-count as-tone-sev-high");
});

Deno.test("FilterChips: a finding's filter shows as its own chip", () => {
  const html = renderToStaticMarkup(
    <FilterChips
      filter={{ kind: "calls", calls: new Set(["a/b"]) }}
      onChange={noop}
      findingTitle="Edited definition.yaml by hand"
      count={() => 4}
      total={32}
      withSubagents={false}
    />,
  );
  assertStringIncludes(html, "Edited definition.yaml by hand ✕");
  assertStringIncludes(html, "Not classified");
  assertStringIncludes(html, "as-tone-sev-info");
});

Deno.test("FilterChips: each chip counts its calls; the active one shows its count of the total in its colour", () => {
  const html = renderToStaticMarkup(
    <FilterChips
      filter={{ kind: "label", label: "bypass" }}
      onChange={noop}
      findingTitle={null}
      count={(f) => (f.kind === "label" && f.label === "bypass" ? 8 : 1)}
      total={32}
      withSubagents
    />,
  );
  assertStringIncludes(html, 'aria-label="Bypass, 8 calls"');
  assertStringIncludes(html, 'aria-label="All calls, 32 calls"');
  assertStringIncludes(html, "as-chip-total as-tone-l-bypass");
  assertStringIncludes(
    html,
    "<strong>8</strong> of 32 calls (with opened subagents)",
  );
});

Deno.test("TurnWaterfall: turns start closed, and a busy turn draws only rows in view", () => {
  const closed = waterfall();
  assertEquals(closed.split('class="as-call"').length - 1, 0);
  const busy = long.turns.find((t) => t.calls.length > 100)!;
  const html = waterfall(long, [turnKey(long.id, busy.n)]);
  assertStringIncludes(html, `aria-rowcount="${busy.calls.length}"`);
  const drawn = html.split('class="as-call"').length - 1;
  assert(drawn > 0 && drawn < busy.calls.length, `${drawn} rows drawn`);
});

Deno.test("TurnWaterfall: an opened subagent call draws the child under its turn", () => {
  const link = long.turns.findIndex((t) =>
    t.calls.some((c) => c.subagentSessionId)
  );
  const html = waterfall(long, [turnKey(long.id, long.turns[link].n)], [
    child.id,
  ]);
  assertStringIncludes(html, `subagent-${child.id}`);
  assertStringIncludes(html, 'aria-expanded="true"');
});

Deno.test("CallInspector: label, rule, spans, and the call text as text, never markup", () => {
  const call = long.turns.flatMap((t) => t.calls).find((c) => c.swampSpans)!;
  const html = renderToStaticMarkup(
    <CallInspector
      call={{ ...call, text: "<img src=x onerror=alert(1)>" }}
      onClose={noop}
    />,
  );
  assertStringIncludes(html, "&lt;img src=x");
  assert(!html.includes("<img"));
  assertStringIncludes(html, "runs the swamp CLI");
  assertStringIncludes(html, "swamp.cli.teardown");
});

Deno.test("CallInspector: an unlabeled call reads as not classified; a cut one says so", () => {
  const calls = fixtureSessions().flatMap((s) =>
    s.turns.flatMap((t) => t.calls)
  );
  const unlabeled = renderToStaticMarkup(
    <CallInspector
      call={calls.find((c) => c.label === "unlabeled")!}
      onClose={noop}
    />,
  );
  assertStringIncludes(unlabeled, "Not classified yet");
  const cut = renderToStaticMarkup(
    <CallInspector
      call={calls.find((c) => c.truncated)!}
      onClose={noop}
    />,
  );
  assertStringIncludes(cut, "Cut to 1000 characters");
});
