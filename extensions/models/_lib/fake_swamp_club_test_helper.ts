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

// ---------------------------------------------------------------------------
// In-memory swamp-club for tests
// ---------------------------------------------------------------------------
//
// Answers the lab API the way swamp-club does for the calls this model
// makes: the one-step status order (422 on a jump), `githubPrUrl` kept
// across the shipped transition, relationship rules including
// `duplicate_of`'s single canonical and no-chain checks, and lifecycle
// entries echoed back on the issue GET. Tests assert on the resulting state
// rather than on a script of canned responses.
//
// Not a `_test.ts` file, so `deno test` does not run it; under `_lib/`, so
// swamp's extension discovery skips it.

export const FAKE_SWAMP_CLUB_URL = "https://fake.swamp-club.test";

export interface FakeIssue {
  number: number;
  type: "bug" | "feature" | "platform" | "security";
  status: "open" | "triaged" | "in_progress" | "shipped" | "closed";
  title: string;
  authorUsername: string;
  authorId?: string;
  githubPrUrl?: string;
  githubPrNumber?: number;
}

export interface FakeRelationship {
  id: string;
  type: string;
  sourceIssueNumber: number;
  targetIssueNumber: number;
}

export interface FakeEntry {
  issue: number;
  step: string;
  targetStatus: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface FakeCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

const NEXT: Record<string, string> = {
  triaged: "open",
  in_progress: "triaged",
  shipped: "in_progress",
  open: "closed",
};

export class FakeSwampClub {
  issues = new Map<number, FakeIssue>();
  relationships: FakeRelationship[] = [];
  entries: FakeEntry[] = [];
  ripples: { issue: number; body: string }[] = [];
  calls: FakeCall[] = [];
  roster: { userId: string; username: string }[] | null = [];
  /** Return a Response to fail a call before the fake handles it. */
  failWhen?: (call: FakeCall) => Response | undefined;
  #nextId = 1;

  addIssue(issue: Partial<FakeIssue> & { number: number }): FakeIssue {
    const full: FakeIssue = {
      type: "feature",
      status: "open",
      title: `Issue ${issue.number}`,
      authorUsername: `author${issue.number}`,
      authorId: `user-${issue.number}`,
      ...issue,
    };
    this.issues.set(full.number, full);
    return full;
  }

  addEntry(issue: number, step: string, payload: Record<string, unknown>) {
    this.entries.push({
      issue,
      step,
      targetStatus: "open",
      summary: step,
      payload,
    });
  }

  entriesOn(issue: number): FakeEntry[] {
    return this.entries.filter((e) => e.issue === issue);
  }

  stepsOn(issue: number): string[] {
    return this.entriesOn(issue).map((e) => e.step);
  }

  /** Swap in as `globalThis.fetch`; returns the restore function. */
  install(): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      const call: FakeCall = {
        method: init?.method ?? "GET",
        path: url.pathname,
        body: typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined,
      };
      this.calls.push(call);
      return Promise.resolve(this.failWhen?.(call) ?? this.#handle(call));
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  #handle({ method, path, body }: FakeCall): Response {
    if (path === "/healthz") return new Response("ok");
    if (path === "/api/v1/lab/assignees") {
      return this.roster
        ? Response.json({ assignees: this.roster })
        : new Response("forbidden", { status: 403 });
    }
    const match = /^\/api\/v1\/lab\/issues\/(\d+)(?:\/(\w+))?$/.exec(path);
    if (!match) return new Response("not found", { status: 404 });
    const issue = this.issues.get(Number(match[1]));
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    const sub = match[2];

    if (!sub && method === "GET") return this.#get(issue);
    if (!sub && method === "PATCH") return this.#patch(issue, body ?? {});
    if (sub === "lifecycle" && method === "POST") {
      this.entries.push({
        issue: issue.number,
        step: String(body?.step),
        targetStatus: String(body?.targetStatus),
        summary: String(body?.summary),
        payload: (body?.payload ?? {}) as Record<string, unknown>,
      });
      return Response.json({}, { status: 201 });
    }
    if (sub === "comments" && method === "POST") {
      this.ripples.push({ issue: issue.number, body: String(body?.body) });
      return Response.json({}, { status: 201 });
    }
    if (sub === "relationships" && method === "POST") {
      return this.#addRelationship(issue, body ?? {});
    }
    if (sub === "relationships" && method === "DELETE") {
      const before = this.relationships.length;
      this.relationships = this.relationships.filter((r) =>
        r.id !== body?.relationshipId
      );
      return this.relationships.length < before
        ? new Response(null, { status: 204 })
        : Response.json({ error: "Relationship not found." }, { status: 422 });
    }
    return new Response("not found", { status: 404 });
  }

  #get(issue: FakeIssue): Response {
    return Response.json({
      issue,
      lifecycleEntries: this.entriesOn(issue.number).map((e) => ({
        step: e.step,
        payload: e.payload,
      })),
      relationships: this.relationships
        .filter((r) =>
          r.sourceIssueNumber === issue.number ||
          r.targetIssueNumber === issue.number
        )
        .map((r) => ({
          ...r,
          direction: r.sourceIssueNumber === issue.number
            ? "outgoing"
            : "incoming",
        })),
    });
  }

  #patch(issue: FakeIssue, patch: Record<string, unknown>): Response {
    if (typeof patch.status === "string") {
      const required = NEXT[patch.status];
      if (required === undefined || issue.status !== required) {
        return Response.json(
          { error: `Cannot move "${issue.status}" to "${patch.status}"` },
          { status: 422 },
        );
      }
      issue.status = patch.status as FakeIssue["status"];
    }
    if (typeof patch.githubPrUrl === "string") {
      issue.githubPrUrl = patch.githubPrUrl;
      if (typeof patch.githubPrNumber === "number") {
        issue.githubPrNumber = patch.githubPrNumber;
      }
    }
    if (typeof patch.type === "string") {
      issue.type = patch.type as FakeIssue["type"];
    }
    return Response.json({ issue });
  }

  #addRelationship(
    source: FakeIssue,
    body: Record<string, unknown>,
  ): Response {
    const type = String(body.type);
    const targetNumber = Number(body.targetIssueNumber);
    if (!this.issues.has(targetNumber)) {
      return Response.json({ error: "Issue not found." }, { status: 422 });
    }
    if (targetNumber === source.number) {
      return Response.json({ error: "self reference" }, { status: 422 });
    }
    const existing = this.relationships.find((r) =>
      r.type === type && r.sourceIssueNumber === source.number &&
      r.targetIssueNumber === targetNumber
    );
    if (existing) return Response.json({ relationship: existing });
    if (type === "duplicate_of") {
      if (
        this.relationships.some((r) =>
          r.type === "duplicate_of" && r.sourceIssueNumber === source.number
        )
      ) {
        return Response.json(
          { error: `#${source.number} is already a duplicate` },
          { status: 422 },
        );
      }
      const chain = this.relationships.find((r) =>
        r.type === "duplicate_of" && r.sourceIssueNumber === targetNumber
      );
      if (chain) {
        return Response.json(
          {
            error: `#${targetNumber} is a duplicate of ` +
              `#${chain.targetIssueNumber}; link to that instead`,
          },
          { status: 422 },
        );
      }
    }
    const relationship = {
      id: `rel-${this.#nextId++}`,
      type,
      sourceIssueNumber: source.number,
      targetIssueNumber: targetNumber,
    };
    this.relationships.push(relationship);
    return Response.json({ relationship }, { status: 201 });
  }
}
