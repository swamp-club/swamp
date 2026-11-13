---
audience: maintainer
last-verified: 2026-11-11 @ b137047b4
---

# Swampify

> **Experimental.** Swampify and its contracts may change between releases.
> A reader skips an item it cannot read, and the fix is always to run the step
> again; nothing is migrated.

Swampify is a second way into swamp for someone who already has Claude Code or
Codex history. Their own agent assesses those sessions, offers a few repeated
chores worth automating, builds the one the user picks, and reports what that
chore cost raw against what it costs with swamp. Swamp hosts no model: the
mining is deterministic, and every judgement call is made by the user's own
agent.

Core owns the three data contracts in
`src/domain/agent_sessions/swampify.ts`, beside the
[agent session record](./agent-sessions.md), and `@swamp/agent-sessions`
copies the module unchanged except its zod import specifier. The JSON Schemas
are generated into this directory (`swampify-*.schema.json`) by
`deno run swampify-schema`, and a test fails when one is stale. The dashboard
imports the names it needs through `packages/dashboard/src/lib/agent_sessions/swampify.ts`.

## The journey

1. **Start.** With `SWAMP_EXPERIMENTAL_SWAMPIFY=1` set (see
   [start](./start.md#start-from-your-past-sessions); off otherwise and
   unadvertised), `swamp start` offers "Start from your past sessions" when it
   finds Claude Code or Codex history, says what will be read and where results
   go, and launches the user's agent on a [kick-off](#the-kick-off) task. The
   agent pulls `@swamp/agent-sessions` and creates the `swampify` behavior.
2. **Assess.** The extension's `assess` method mines transcripts, with no model,
   and writes a **candidate set**.
3. **Offer.** The agent reads example sessions for the top candidates, merges
   candidates that are the same chore, and writes an **offer** of one to five
   options. The user picks one; the offer records the pick and, later, what was
   built.
4. **Swamp it.** The getting-started flow builds and runs the behavior or
   workflow.
5. **Compare.** `compare` writes a **comparison** for the picked option: what
   the chore cost raw, what the swamp run cost, and when the build pays back.

## The kick-off

The kick-off is a [start](./start.md#start-from-your-past-sessions) task of
kind `swampify`, the kind the page's build hand-off uses, so its brief and
launch prompt ("use the swampify skill") are the same. Core fills one
constant with the window and excluded paths, and the skill recognises it by
these lines, pinned by a test on both sides:

- `Swampify kick-off: start from your past sessions`, the task's title;
- `<!-- swampify kick-off v1 -->`, the line after it;
- `Window: last <N> days`;
- `Scope: every session on this machine`;
- `Excluded paths: none`, or `Excluded paths:` followed by a `json` code fence
  holding one JSON array of paths.

Every swampify brief, the kick-off and the build, ends its `# Context` with
`- Swampify page: <url>` when start knows the page's address, pinned on both
sides with the lines above; the skill names the page instead when the line is
missing or the link does not load. See
[start](./start.md#the-swampify-page-link) for how the address is chosen.

Its steps pull `@swamp/agent-sessions`, create the `swampify` behavior unless
one of that type exists, and follow the skill from its first state. The skill
still gives its disclosure and waits for the user to agree before anything is
read; it skips only its window and scope questions.

A start workspace has no skill folders when the agent launches, and neither
harness picks up a skill installed into a folder that did not exist at
startup: Claude Code answers "Unknown skill", and Codex lists a new skill only
from its next session. Reading `SKILL.md` by path worked in both, so the text
names the installed paths (`.claude/skills/swampify/SKILL.md`,
`.agents/skills/swampify/SKILL.md`) for when the skill isn't available.
Start does not pull the extension itself: that would add a network step and a
new failure to start for what one sentence covers. Codex's default sandbox
refuses the pull's write to `.agents/`, so the text says to ask the user to
run it outside the sandbox.

## The three items

| Item          | Data name                          | Type tag              | Written by                      | Version |
| ------------- | ---------------------------------- | --------------------- | ------------------------------- | ------- |
| candidate set | `swampify-candidates`              | `swampify-candidates` | `assess`                        | 2       |
| offer         | `swampify-offer`                   | `swampify-offer`      | the skill, via an offer method  | 1       |
| comparison    | `swampify-comparison-<option id>`  | `swampify-comparison` | `compare`                       | 2       |

Each re-run writes a new version of the same data item.

- **Candidate set.** One assessment: its window, scope and up to 100 ranked
  candidates. A candidate has a kind (`prompt-repeat`, `call-sequence`,
  `covered-cli`, `headless-job`), counts, a date span, per-occurrence cost
  ranges, a failure rate, session refs and up to five redacted excerpts. v2
  adds `perOccurrence.weightedTokens` (input + output + cache writes + a tenth
  of cache reads, `swampifyWeightedTokens`), `score` (what `assess` ranked by)
  and `rank` (the 1-based position in the list). `assess` interleaves
  interactive and headless candidates, so `score` need not fall as `rank`
  rises.
- **Offer.** Built from one candidate set, named by that set's `generatedAt`
  and stored on the same behavior. It holds what read the sessions (harness,
  the model the user chose, how many candidates and sessions), one to five
  `options`, the `considered` candidates that were not offered with a reason
  (`not-a-chore`, `low-value`, or `merged` with the candidate it was folded
  `into`), and a `state`: `offered`, `picked`, `built` (which keeps the pick
  and adds the target) or `declined`. Each option has a name, a one-line `why`,
  what it `becomes` (behavior or workflow), an optional registry type and
  outline, and the `candidateIds` it stands for.
- **Comparison.** One offer option that was swamped: its `optionId` and
  `candidateIds`, the target, the build cost, history ranges (the chore's own
  calls up to whole turns) summed over all the option's candidates, the swamp
  run, forward figures, break-even, and an optional labelled money estimate.

### Ids

- A **candidate id** is 32 hex digits of SHA-256 over the candidate's kind,
  invocation and normalised key (`swampifyCandidateId`). A re-assessment keeps
  it.
- An **option id** is 16 hex digits of SHA-256 over the option's sorted
  candidate ids (`swampifyOptionId`). The same chore therefore keeps its option
  id, and its comparison, across offers and re-assessments. The writer derives
  it; readers check only its shape, since the hash is async.

## Which item a reader shows

Readers list each kind by its type tag across every behavior, with
`SWAMPIFY_LIST_SELECT`, which returns each row's `name`, `modelName` (the
owning behavior, which `data.get` needs) and `tags`. Swampify writes through a
behavior called `swampify` by convention, but a reader never filters on it, so
items written from another behavior still show.

`newestSwampifyItem(rows, tag)` applies the rule, so every reader applies it the
same way:

1. the newest by `generatedAt` (candidate sets, comparisons) or `updatedAt`
   (offers), compared as instants;
2. on a tie, the `swampify` behavior, then `modelName` ascending, then data
   name ascending;
3. a row without a string name and owner, or whose time tag does not parse, is
   passed over.

When the newest candidate set's `generatedAt` differs from the newest offer's
`candidateSet.generatedAt`, the set was replaced by a later assessment. The
reader still shows the offer, marks it as built from an earlier assessment, and
resolves its candidate ids against the current set, showing any it cannot find
as no longer found. Zod cannot see across items, so the offer method checks the
link and the candidate ids when it writes.

## Rules every item follows

They are the record's rules:

- every object is strict, and every string and list is bounded
  (`SWAMPIFY_LIMITS`); counts carry true totals and only lists are capped.
  The caps were sized on a heavy machine: 368 interactive and 20,759 headless
  sessions in 30 days, whose largest repeat spanned 585 sessions. An excerpt's
  300 characters cover a prompt's first line, whose median is 40 characters and
  p99 465;
- `schemaVersion` is on every item, and a new field is a new version;
- each item has a reader that never throws and returns the item or a skip,
  `newer`, `older` or `invalid`, whose note names field paths, never values;
  each reader counts its lists before parsing, so an oversized item costs only
  those counts;
- tags carry what a list needs: `generatedAt` or `updatedAt`, a compact
  `summary`, and a comparison's `optionId`. Each summary has its own reader,
  which returns `undefined` for a tag over 4096 characters, not JSON, or not
  matching. Tags are self-reported, so a reader validates the body when it
  opens one.

| Item          | Summary tag holds                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------- |
| candidate set | `since`, `until`, `harnesses`, `candidates`, `thin`, `interactive`, `headless`, counts per kind     |
| offer         | `state`, `options`, `pickedOptionId` when picked or built, `target` when built                      |
| comparison    | `optionId`, `target`, `outcome`, `historyOccurrences`, `forwardRaw`, `forwardSwamp`, `breakEven`    |

A set is `thin` when it has fewer than `SWAMPIFY_THIN_BELOW` (3) candidates.

### Rules only Zod checks

An item that passes its JSON Schema can still be skipped as `invalid`:

- every range has `min <= median <= max`; windows and date spans run forward;
- a candidate's `rank` is its position; `steps` belong to a `call-sequence` and
  `program` to a `covered-cli`, and to nothing else; a `prompt-repeat` is
  interactive and a `headless-job` headless; session refs never outnumber
  sessions, nor sessions occurrences; candidate ids are unique in a set;
- in an offer, option ids are unique; a candidate appears once across all
  options and `considered`, and those together number `reading.candidates`;
  `merged` names, in `into`, another candidate the offer holds that is not
  itself merged, so merges never form a cycle, and only `merged` has `into`; `picked` and `built` name an option that exists;
  `candidateSet.generatedAt <= createdAt <= updatedAt`, and `pickedAt`,
  `builtAt` and `declinedAt` fall between `createdAt` and `updatedAt`, with
  `pickedAt <= builtAt`;
- in a comparison, `candidateIds` are unique; a `perOccurrence` cost is present
  exactly when there are occurrences; each `chore` statistic is at most the
  `wholeTurns` one; `breakEven.low <= high`, and `high` is null when `low` is;
- in the summaries, `thin` matches the count, the candidate counts add up, and
  the offer's pick and target appear exactly where its state carries them.

## What is read and what is stored

`assess` reads, on the machine that holds them, Claude Code transcripts and
Codex rollouts in the chosen window and scope: prompts, replies, tool calls and
their output. The agent then reads a few example sessions per candidate.

- **Session records stay prompt-free.** Nothing here changes them.
- **Candidate sets hold short redacted excerpts** as evidence, at most five of
  300 characters per candidate, and labels passed through the same redaction.
- **Offers hold agent-written names, reasons and outlines**, bounded, written
  by the user's own agent.
- **Counts, costs and ids** are stored for every candidate. Directory names are
  not, only how many.

Where the data then goes is the user's choice, as for any repo data: kept
local, synced to a datastore, or served with `swamp serve`.

## The page

The dashboard's Swampify page, at `/swampify` below Agent sessions in the
sidebar, shows the latest assessment and what to build from it. The sidebar
item shows only when one `data.query` with
`SWAMPIFY_CANDIDATES_QUERY_PREDICATE` and a limit of 1 finds a candidate set
the viewer can read; hiding is not access control. Its requests are in
`packages/dashboard/src/client/swampify.ts`, and
`integration/swampify_page_test.ts` sends them through serve's handlers.

- **What it reads.** One list per item kind, by type tag with
  `SWAMPIFY_LIST_SELECT`, so no body loads until the page opens the set and
  the offer that `newestSwampifyItem` picks. Comparisons are listed once and
  grouped by their `optionId` tag, the newest per option by the same rule; a
  comparison's body is read only when it is opened.
- **Candidates tab.** One sentence says when the set was assessed, from which
  harnesses, over which window and with which exclusions. The offer's options
  not yet built show as top candidates, then the candidates those options
  stand for, by rank; before there is an offer, every candidate. A candidate
  opens to its ranges, excerpts and session refs, and to the option it is
  part of.
- **Built tab.** Each option built or compared, opening to its comparison.
- **An option's review.** At `/swampify/options/<optionId>`, so Back returns to
  the list. What swamp would build and the hand-off come first, then the
  comparison, then the evidence.
- **The hand-off.** The brief, `swampifyBuildBrief`, carries the option's
  name, why, outline and counts, never labels or excerpts. Copy brief puts it
  on the clipboard. On the local dashboard, **Swampify!** sends the same
  brief's task text (`swampifyBuildTask`) as a `swampify.launch` request: the
  hub saves it as a [start](./start.md) task of kind `swampify` in the repo it
  serves and launches the offer's reading harness on it, with start's
  sign-in, PATH and trust checks; the click is the trust confirmation, as
  start's Launch is. The page shows the agent opened, the command to run when
  no terminal could open, or start's refusal. Under `swamp serve` the page is
  review-only: Copy brief and no launch. The page writes no Swampify data;
  the agent records the pick.
- **Refreshes.** A build happens in the agent's session, so the page
  re-reads its candidate-set, offer and comparison lists when the tab comes
  back into view, and every 15 seconds while the tab is in view and the
  shown offer is `picked`. A body is re-read when its row's version changes.
  The sidebar's probe re-reads on return too, so the item appears after the
  first assessment.
- **Computes nothing.** It shows the ranges, counts, rates and break-even the
  writers stored, and only formats them; the thin flag comes from the summary
  tag.
- **Text only.** Labels, excerpts, steps, option names, reasons and notes are
  rendered as text, never as markup or links; the only links are the session
  refs, built from the checked data name.
- **Skips.** An item a reader skips shows the reader's note, never its content.
  With the set skipped, an offer's candidates show as not readable.
- **Access.** Under `swamp serve`, `data.query` drops what the viewer may not
  read before its limit, so an unreadable comparison leaves its option showing
  as not compared, and the page adds no access logic of its own.
