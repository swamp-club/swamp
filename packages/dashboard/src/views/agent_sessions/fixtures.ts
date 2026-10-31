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
 * Synthetic agent sessions in the v2 record shape, for tests and the page's
 * sample setup. Every repo, path and command here is made up; the sizes and
 * label mix follow the three sessions of the agent observation prototype
 * (5 turns and 32 calls, 17 and 169, 5 and 29), plus what the prototype did
 * not have: a subagent child, a headless session, a turn over a hundred
 * calls, a truncated call and an unlabeled call. Findings are written here
 * as the importer would write them; the page only renders them.
 */

import type {
  AgentSessionFinding,
  AgentSessionRecord,
  AgentSessionToolCall,
  AgentSessionTurn,
} from "../../lib/agent_sessions/record.ts";

type CallShape = Omit<AgentSessionToolCall, "id" | "start" | "end">;

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** A small seeded generator, so the fixtures are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function swampRun(command: string, fails = false): CallShape {
  return {
    tool: "Bash",
    toolKind: "shell",
    ok: !fails,
    ...(fails ? { exitCode: 1 } : {}),
    text: command,
    label: "swamp",
    category: "swamp",
    rule: "runs the swamp CLI",
    swampSpans: [{
      offset: 140,
      spans: [
        { name: "swamp.cli", start: 0, duration: 760, depth: 0, error: fails },
        {
          name: "swamp.cli.startup",
          start: 0,
          duration: 180,
          depth: 1,
          error: false,
        },
        {
          name: "swamp.method.run",
          start: 190,
          duration: 410,
          depth: 1,
          error: fails,
        },
        {
          name: "swamp.datastore.write",
          start: 420,
          duration: 120,
          depth: 2,
          error: false,
        },
        {
          name: "swamp.cli.teardown",
          start: 610,
          duration: 150,
          depth: 1,
          error: false,
        },
      ],
    }],
  };
}

const READ_DEFINITION: CallShape = {
  tool: "Read",
  toolKind: "file-read",
  ok: true,
  text: "models/web-frontend/definition.yaml",
  label: "neutral",
  category: "read a file",
  rule: "reads are neutral",
};

function handEdit(fails = false): CallShape {
  return {
    tool: "Edit",
    toolKind: "file-edit",
    ok: !fails,
    text: "models/web-frontend/definition.yaml",
    label: "bypass",
    category: "hand-edited definition",
    rule: "edits a swamp definition outside swamp",
  };
}

const KUBECTL: CallShape = {
  tool: "Bash",
  toolKind: "shell",
  ok: true,
  exitCode: 0,
  text: "kubectl get pods -n staging",
  label: "bypass",
  category: "kubectl — covered by @demo/kubernetes",
  rule: "runs a CLI an installed extension covers",
};

const GIT_STATUS: CallShape = {
  tool: "Bash",
  toolKind: "shell",
  ok: true,
  exitCode: 0,
  text: "git status --short",
  label: "neutral",
  category: "version control",
  rule: "git is neutral",
};

const READ_EXTENSION_SOURCE: CallShape = {
  tool: "Read",
  toolKind: "file-read",
  ok: true,
  text: ".swamp/pulled-extensions/@demo/kubernetes/models/deployment.ts",
  label: "bypass",
  category: "read extension source",
  rule: "reads pulled extension source",
};

const SKILL: CallShape = {
  tool: "Skill",
  toolKind: "skill",
  ok: true,
  text: "swamp",
  label: "neutral",
  category: "loaded a skill",
  rule: "skills are neutral",
};

const SEARCH: CallShape = {
  tool: "Grep",
  toolKind: "search",
  ok: true,
  text: "models/",
  label: "unlabeled",
};

const LONG_COMMAND: CallShape = {
  tool: "Bash",
  toolKind: "shell",
  ok: true,
  exitCode: 0,
  text: `curl -s https://api.example.test/v1/deployments?${
    "filter=staging&".repeat(70)
  }`.slice(0, 1000),
  truncated: true,
  label: "bypass",
  category: "other CLI",
  rule: "runs a CLI swamp does not cover",
};

const SWAMP_COMMANDS = [
  "swamp behavior run web-frontend apply",
  "swamp behavior get web-frontend --json",
  "swamp data query 'modelName == \"web-frontend\"'",
  "swamp workflow run deploy-staging",
  "swamp behavior validate web-frontend",
];

/** Picks a call from a weighted mix of the shapes above. */
function mixedCall(
  random: () => number,
  mix: { swamp: number; bypass: number },
): CallShape {
  const roll = random();
  if (roll < mix.swamp) {
    const command =
      SWAMP_COMMANDS[Math.floor(random() * SWAMP_COMMANDS.length)];
    return swampRun(command, random() < 0.08);
  }
  if (roll < mix.swamp + mix.bypass) {
    const pick = random();
    if (pick < 0.45) return KUBECTL;
    if (pick < 0.75) return READ_EXTENSION_SOURCE;
    return handEdit(random() < 0.2);
  }
  const pick = random();
  if (pick < 0.4) return READ_DEFINITION;
  if (pick < 0.7) return GIT_STATUS;
  if (pick < 0.85) return SKILL;
  return SEARCH;
}

interface TurnPlan {
  /** Idle time before the turn starts, after the previous one ends. */
  idle: number;
  calls: CallShape[];
}

/** Lays turns and calls out in time and numbers the call ids. */
function layOut(
  random: () => number,
  plans: TurnPlan[],
): AgentSessionTurn[] {
  const turns: AgentSessionTurn[] = [];
  let clock = 2 * SECOND;
  plans.forEach((plan, index) => {
    clock += plan.idle;
    const start = clock;
    clock += 1500 + Math.floor(random() * 2500);
    const calls = plan.calls.map((shape, c) => {
      const callStart = clock;
      const length = shape.toolKind === "subagent"
        ? 45 * SECOND
        : 300 + Math.floor(random() * 4000);
      clock += length + 200 + Math.floor(random() * 900);
      return {
        ...shape,
        id: `call-${index + 1}-${c + 1}`,
        start: callStart,
        end: callStart + length,
      };
    });
    clock += 800 + Math.floor(random() * 3000);
    const output = 300 + Math.floor(random() * 2500);
    turns.push({
      n: index + 1,
      start,
      end: clock,
      tokens: {
        input: 20 + Math.floor(random() * 300),
        output,
        cacheRead: 18000 + Math.floor(random() * 40000),
        cacheWrite: 900 + Math.floor(random() * 6000),
      },
      calls,
    });
  });
  return turns;
}

function idsWhere(
  turns: AgentSessionTurn[],
  test: (call: AgentSessionToolCall) => boolean,
): string[] {
  return turns.flatMap((t) => t.calls.filter(test).map((c) => c.id));
}

function base(
  id: string,
  startedAt: string,
  extra: Partial<AgentSessionRecord> = {},
): Omit<AgentSessionRecord, "turns" | "findings"> {
  return {
    schemaVersion: 2,
    id,
    repo: "acme-platform",
    harness: "claude-code",
    harnessVersion: "2.4.1",
    model: "claude-opus-5-5",
    startedAt,
    invocation: "interactive",
    swampUserId: "user-0001",
    swampUsername: "demo-user",
    importerVersion: "0.1.0",
    ...extra,
  };
}

/** The parent of the subagent, and the agent id the harness gave it. */
export const SUBAGENT_PARENT_ID = "0b5e7c1a-2f44-4d1b-9a63-5c0f2e8d7a10";
export const SUBAGENT_AGENT_ID = "a3f9c21b7d";
/**
 * `agentSessionChildId(SUBAGENT_PARENT_ID, SUBAGENT_AGENT_ID)`, written out
 * because the helper is async; fixtures_test.ts checks it.
 */
export const SUBAGENT_CHILD_ID =
  "0b5e7c1a-2f44-4d1b-9a63-5c0f2e8d7a10_4e3a850ce316e40e5947fd48a264afa6";

/** A short session that edits one definition by hand and fails. */
function editLoopSession(): AgentSessionRecord {
  const random = seeded(11);
  const turns = layOut(random, [
    {
      idle: 0,
      calls: [
        SKILL,
        READ_DEFINITION,
        swampRun(SWAMP_COMMANDS[1]),
        GIT_STATUS,
        READ_DEFINITION,
        swampRun(SWAMP_COMMANDS[4]),
      ],
    },
    {
      idle: 3 * MINUTE,
      calls: [
        handEdit(),
        swampRun(SWAMP_COMMANDS[4], true),
        handEdit(),
        swampRun(SWAMP_COMMANDS[4], true),
        READ_DEFINITION,
        handEdit(),
      ],
    },
    {
      idle: 9 * MINUTE,
      calls: [
        swampRun(SWAMP_COMMANDS[0]),
        KUBECTL,
        KUBECTL,
        GIT_STATUS,
        READ_DEFINITION,
        swampRun(SWAMP_COMMANDS[1]),
        SEARCH,
      ],
    },
    {
      idle: 40 * SECOND,
      calls: [
        handEdit(true),
        swampRun(SWAMP_COMMANDS[4]),
        swampRun(SWAMP_COMMANDS[0]),
        GIT_STATUS,
        READ_DEFINITION,
        LONG_COMMAND,
      ],
    },
    {
      idle: 22 * MINUTE,
      calls: [
        swampRun(SWAMP_COMMANDS[2]),
        GIT_STATUS,
        READ_DEFINITION,
        swampRun(SWAMP_COMMANDS[3]),
        KUBECTL,
        GIT_STATUS,
        READ_DEFINITION,
      ],
    },
  ]);
  const edits = idsWhere(turns, (c) => c.category === "hand-edited definition");
  const failed = idsWhere(turns, (c) => !c.ok);
  const kubectl = idsWhere(
    turns,
    (c) => c.category?.startsWith("kubectl") ?? false,
  );
  const findings: AgentSessionFinding[] = [
    {
      severity: "high",
      title:
        `Edited definition.yaml by hand ${edits.length} times across 3 turns`,
      detail:
        "models/web-frontend/definition.yaml is a swamp definition, edited directly instead of through swamp. 3 calls failed between the first and last edit.",
      tune:
        "Skill: point agents at swamp behavior validate after every edit, or give the type a method that applies a patch.",
      callIds: edits,
    },
    {
      severity: "high",
      title: `${failed.length} failed calls in turns 2 to 4`,
      detail: "swamp behavior validate failed twice after hand edits.",
      tune:
        "Diagnose: open the first failure; the swamp spans show where it stopped.",
      callIds: failed,
    },
    {
      severity: "medium",
      title:
        `Ran kubectl directly ${kubectl.length} times though @demo/kubernetes is installed`,
      detail:
        "The repo has an extension for this, and the agent did not use it.",
      tune:
        "Skill or rule: mention @demo/kubernetes where agents look, or mark direct kubectl as fine for this repo.",
      callIds: kubectl,
    },
  ];
  return {
    ...base("6f1d2c3b-8a9e-4b7c-a1d2-3e4f5a6b7c8d", "2026-10-27T14:05:09.000Z"),
    turns,
    findings,
  };
}

/** A long session with a subagent and one very busy turn. */
function longSession(): AgentSessionRecord {
  const random = seeded(23);
  const sizes = [6, 4, 5, 3, 110, 4, 3, 5, 4, 3, 6, 2, 3, 4, 3, 2, 2];
  const idles = [0, 2, 1, 6, 0.5, 14, 1, 3, 2, 30, 1, 4, 1, 2, 8, 1, 1];
  const plans: TurnPlan[] = sizes.map((size, t) => ({
    idle: idles[t] * MINUTE,
    calls: Array.from(
      { length: size },
      () => mixedCall(random, { swamp: 0.42, bypass: 0.2 }),
    ),
  }));
  plans[2].calls[1] = {
    tool: "Agent",
    toolKind: "subagent",
    ok: true,
    text: "Explore",
    label: "neutral",
    category: "started a subagent",
    rule: "subagents are neutral",
    subagentSessionId: SUBAGENT_CHILD_ID,
  };
  const turns = layOut(random, plans);
  const extensionReads = idsWhere(
    turns,
    (c) => c.category === "read extension source",
  );
  const swampCalls = idsWhere(turns, (c) => c.label === "swamp");
  const findings: AgentSessionFinding[] = [
    {
      severity: "medium",
      title: `Read pulled extension source ${extensionReads.length} times`,
      detail:
        "The agent went into .swamp/pulled-extensions to learn a schema the skill did not explain.",
      tune:
        "Skill: the extension's skill is missing what these reads looked for.",
      callIds: extensionReads,
    },
    {
      severity: "info",
      title: "Teardown is 20% of each traced swamp command",
      detail:
        `Across ${swampCalls.length} traced runs, swamp.cli.teardown took about 150 ms of the 760 ms inside swamp.cli. A finding for swamp, not the agent.`,
      tune: "swamp: look at what teardown waits on.",
      callIds: [],
    },
  ];
  return {
    ...base(SUBAGENT_PARENT_ID, "2026-10-28T09:41:30.000Z"),
    turns,
    findings,
  };
}

/** The subagent the long session started, at full detail. */
function subagentSession(): AgentSessionRecord {
  const random = seeded(31);
  const turns = layOut(random, [
    {
      idle: 0,
      calls: [
        READ_EXTENSION_SOURCE,
        READ_EXTENSION_SOURCE,
        SEARCH,
        READ_DEFINITION,
      ],
    },
    {
      idle: 5 * SECOND,
      calls: [
        READ_EXTENSION_SOURCE,
        swampRun(SWAMP_COMMANDS[1]),
        READ_EXTENSION_SOURCE,
      ],
    },
  ]);
  return {
    ...base(SUBAGENT_CHILD_ID, "2026-10-28T09:49:02.000Z", {
      parentSessionId: SUBAGENT_PARENT_ID,
      agentId: SUBAGENT_AGENT_ID,
      agentType: "Explore",
    }),
    turns,
    findings: [{
      severity: "low",
      title: "The subagent read extension source 4 times",
      detail: "It looked for the deployment schema the parent needed.",
      tune: "Skill: describe the deployment schema in the extension's skill.",
      callIds: idsWhere(turns, (c) => c.category === "read extension source"),
    }],
  };
}

/** A headless run, as automation would start it. */
function headlessSession(): AgentSessionRecord {
  const random = seeded(47);
  const sizes = [7, 6, 5, 6, 5];
  const turns = layOut(
    random,
    sizes.map((size, t) => ({
      idle: t === 0 ? 0 : 20 * SECOND,
      calls: Array.from(
        { length: size },
        () => mixedCall(random, { swamp: 0.55, bypass: 0.15 }),
      ),
    })),
  );
  return {
    ...base(
      "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
      "2026-10-29T03:00:04.000Z",
      {
        invocation: "headless",
        repo: "acme-infra",
      },
    ),
    turns,
    findings: [],
  };
}

/** Every fixture session: three top-level sessions and one subagent child. */
export function fixtureSessions(): AgentSessionRecord[] {
  return [
    editLoopSession(),
    longSession(),
    subagentSession(),
    headlessSession(),
  ];
}
