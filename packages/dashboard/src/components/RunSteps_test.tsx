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
import { assert, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { type ApprovalInfo, type StepContext, StepList } from "./RunSteps.tsx";

const DECIDED_AT = "2026-11-12T15:00:00.000Z";

const ctx: StepContext = {
  runStatus: "succeeded",
  now: Date.parse(DECIDED_AT),
  onOpenItem: () => {},
  onNavigate: () => {},
};

function note(approval: ApprovalInfo): string {
  const html = renderToStaticMarkup(
    <StepList
      steps={[{
        name: "gate",
        status: approval.status === "approved" ? "succeeded" : "failed",
        approval,
      }]}
      ctx={ctx}
    />,
  );
  const match = html.match(/<div class="rs-note[^"]*">([^<]*)<\/div>/);
  assert(match, `no approval note in ${html}`);
  return match[1];
}

function approved(client?: string): ApprovalInfo {
  return {
    status: "approved",
    approvedBy: "user:alice",
    approvedAt: DECIDED_AT,
    ...(client !== undefined ? { client } : {}),
  };
}

function rejected(client?: string): ApprovalInfo {
  return {
    status: "rejected",
    rejectedBy: "user:alice",
    rejectedAt: DECIDED_AT,
    reason: "not today",
    ...(client !== undefined ? { client } : {}),
  };
}

Deno.test("StepList: an approval names the integration client it came through", () => {
  assertStringIncludes(
    note(approved("integration:slackwater")),
    "Approved by user:alice via integration:slackwater at ",
  );
});

Deno.test("StepList: a rejection names the integration client it came through", () => {
  const text = note(rejected("integration:slackwater"));
  assertStringIncludes(
    text,
    "Rejected by user:alice via integration:slackwater at ",
  );
  assert(text.endsWith(": not today"));
});

Deno.test("StepList: a decision through a direct client reads as before", () => {
  assertStringIncludes(
    note(approved("direct:dashboard")),
    "Approved by user:alice at ",
  );
  assertStringIncludes(
    note(rejected("direct:cli")),
    "Rejected by user:alice at ",
  );
});

Deno.test("StepList: a decision with no recorded client reads as before", () => {
  assertStringIncludes(note(approved()), "Approved by user:alice at ");
  assertStringIncludes(note(rejected()), "Rejected by user:alice at ");
});
