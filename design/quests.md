# Quests

A quest is a seasonal bingo card of objectives that guides users through the
platform's features. Each season defines one quest board — a 5×5 grid of 24
objectives plus a free center space. The CLI detects when actions happen and
fires quest events to the backend; progress is event-driven, not derived from
stats.

## Seasons

A season is a time-bounded period with a theme. Each season defines one quest
board. When a season is active, every user gets their own quest instance for that
season. Past seasons' quests remain viewable but can no longer be progressed.

- **Season**: slug, name, theme, description, start date, end date
- **Quest**: 5×5 bingo grid (24 objectives + free center), tied to one season
- **Objective**: a specific action or milestone the user must complete
- **Bingo**: completing a full row, column, or diagonal

## Quest Events (CLI → Backend)

The CLI is the source of truth for when things happen. After a command completes
successfully, the CLI fires a quest event to the backend:

```
POST /api/v1/quest/events
Authorization: Bearer <token>

{
  "type": "model.create",
  "metadata": { "name": "my-model" }
}
```

The backend matches the event against the current season's quest objectives for
that user, updates progress, and returns what (if anything) was completed:

```json
{
  "objectives_completed": [
    { "slug": "first-model", "title": "First Model", "position": [0, 0] }
  ],
  "lines_completed": [
    { "kind": "row", "index": 0 }
  ],
  "quest_completed": false
}
```

The CLI then shows a celebratory inline message after the command output:

```
Model 'risk-assessment' created successfully.

  Quest "First Model" complete!
  Row 1 BINGO! +100 bonus points
```

> **Planned.** These event types are defined in the design but not yet present
> in the codebase.

## Quest Event Types

These map to existing CLI commands. Each fires after successful completion:

| Event Type         | Triggered By                       |
| ------------------ | ---------------------------------- |
| `model.create`     | `swamp model create`               |
| `model.run`        | `swamp model run`                  |
| `model.edit`       | `swamp model edit`                 |
| `model.search`     | `swamp model search`               |
| `model.validate`   | `swamp model validate`             |
| `workflow.create`  | `swamp workflow create`            |
| `workflow.run`     | `swamp workflow run`               |
| `data.query`       | `swamp data get/query`             |
| `data.import`      | `swamp data import` (TBD)          |
| `vault.create`     | `swamp vault create`               |
| `vault.edit`       | `swamp vault edit`                 |
| `extension.create` | `swamp extension create` (TBD)     |
| `extension.build`  | `swamp extension build` (TBD)      |
| `extension.push`   | `swamp extension push`             |
| `extension.pull`   | `swamp extension pull`             |
| `extension.install` | `swamp extension install`          |
| `extension.search` | `swamp extension search`           |
| `repo.init`        | `swamp repo init`                  |
| `issue.create`     | `swamp issue bug/feature/security` |
| `report.generate`  | `swamp report`                     |
| `datastore.sync`   | `swamp datastore sync`             |

The backend also knows about some state-based facts (collective membership,
streak length) that it can check when processing events or when the user views
their quest progress.

## Example Season: "Swamp Genesis"

Theme: Building your foundation in the swamp. The first season introduces users
to every major feature area.

### 5×5 Bingo Card

```
        Col 0          Col 1          Col 2          Col 3          Col 4
     ┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
R0   │ First Model  │ First Run    │ Vault Keeper │ Repo Ready   │ Ext Scout    │
     │ Create a     │ Run a model  │ Create a     │ Init a repo  │ Search for   │
     │ model        │              │ vault secret │              │ extensions   │
     ├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
R1   │ Flow Starter │ Ext Author   │ Data Curious │ Bug Hunter   │ Ext Builder  │
     │ Create a     │ Push an      │ Query some   │ File a lab   │ Build an     │
     │ workflow     │ extension    │ data         │ issue        │ extension    │
     ├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
R2   │ Team Player  │ Ext User     │    FREE      │ Flow Runner  │ Data Syncer  │
     │ Be in 2+     │ Install an   │              │ Run a        │ Sync a       │
     │ collectives  │ extension    │              │ workflow     │ datastore    │
     ├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
R3   │ Run x10      │ Flow Maker   │ Model Maker  │ Ext Shipper  │ Vault Pro    │
     │ Run 10       │ Create 3     │ Create 5     │ Push 3 ext   │ Create 5     │
     │ models       │ workflows    │ models       │ versions     │ vault secrets│
     ├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
R4   │ Run x25      │ Issue Champ  │ Ext Portfolio│ Flow Master  │ Report Card  │
     │ Run 25       │ File 5 lab   │ Push 2       │ Run 10       │ Generate 3   │
     │ models       │ issues       │ diff exts    │ workflows    │ reports      │
     └──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
```

**Difficulty gradient**: Row 0 is "do it once" tasks. Rows 1–2 are "try each
feature area". Rows 3–4 require sustained effort with count targets.

**Coverage**: Models, workflows, data, vault, extensions, collectives, issues,
repos, reports, datastores — every major feature area is represented.

### Bingo Rewards

- **Line (row/col/diagonal)**: bonus points (e.g. 100 per line)
- **Full board**: large bonus + seasonal badge
- Values are defined server-side per season and can be tuned

## CLI Commands

### `swamp quest`

Shows the current season summary and overall progress.

```
Season 1: Swamp Genesis (ends Aug 31, 2026)

  Progress: 8/24
  Bingos: 1

  Run swamp quest board for full card
```

JSON mode outputs the structured progress object.

> **Not yet implemented.** The current CLI only provides `swamp quest` (linear
> pass view).

### `swamp quest board`

Shows the full bingo card with per-objective progress.

```
 SEASON 1: SWAMP GENESIS                          8/24 · 1 Bingo

 ┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
 │ [x] First    │ [x] First    │ [x] Vault    │ [x] Repo     │ [x] Ext      │
 │     Model    │     Run      │     Keeper   │     Ready    │     Scout    │
 ├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
 │ [x] Flow     │ [ ] Ext      │ [ ] Data     │ [x] Bug      │ [ ] Ext      │
 │     Starter  │     Author   │     Curious  │     Hunter   │     Builder  │
 ├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
 │ [ ] Team     │ [ ] Ext      │ [x] FREE     │ [ ] Flow     │ [ ] Data     │
 │     Player   │     User     │              │     Runner   │     Syncer   │
 ├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
 │ [ ] Run x10  │ [ ] Flow     │ [ ] Model    │ [ ] Ext      │ [ ] Vault    │
 │     3/10     │     Maker    │     Maker    │     Shipper  │     Pro      │
 │              │     1/3      │     2/5      │              │     1/5      │
 ├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
 │ [ ] Run x25  │ [ ] Issue    │ [ ] Ext      │ [ ] Flow     │ [ ] Report   │
 │     3/25     │     Champ    │     Portfolio│     Master   │     Card     │
 │              │     1/5      │     0/2      │     0/10     │     0/3      │
 └──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘

 Row 0 BINGO! +100 points
```

For incomplete count-based objectives, show current/target below the title.

### `swamp quest history`

Shows past seasons and their final status.

> **Not yet implemented.** Quest event emission is planned but not wired up.

## Quest Event Emission Pattern

Each quest-relevant command adds a single call after its main stream:

```typescript
await consumeStream(modelCreate(ctx, deps, input), renderer.handlers());

// Best-effort quest event — swallows errors, short timeout
const questResult = await maybeEmitQuestEvent(questDeps, "model.create");
if (questResult) {
  renderQuestCompletion(cliCtx.outputMode, questResult);
}
```

`maybeEmitQuestEvent`:

- Checks if user is authenticated (no-op if not)
- POSTs to `/api/v1/quest/events` with a 3-second AbortSignal timeout
- Returns `QuestEventResult | null` (null on any error)
- Never throws — all errors are silently logged at debug level

`renderQuestCompletion`:

- In log mode: prints "Quest [title] complete!" + any bingo line messages
- In json mode: no-op (the main command already output its JSON; quest
  completion info is available via `swamp quest --json`)

## Backend Requirements (swamp-club repo)

The backend needs:

1. **Seasons table** — slug, name, theme, start/end dates, quest definition
2. **Quest definitions** — per-season objective list with positions, event
   matchers, and targets (stored as JSON or in a related table)
3. **User quest progress** — per-user per-season progress on each objective
4. **Event processing** — receive quest events, match against current season's
   objectives, update progress, detect line/board completion
5. **API endpoints**:
   > **Not yet implemented.**
   - `POST /api/v1/quest/events` — receive + process quest event
   - `GET /api/v1/quest/progress` — current season summary
   - `GET /api/v1/quest/board?season=<slug>` — full board with progress
   - `GET /api/v1/quest/history` — past seasons list

Event matching logic: each objective has a `matcher` that specifies which event
types count toward it and whether it needs a count or just once. Example:

```json
{
  "slug": "run-x10",
  "title": "Run x10",
  "matcher": { "event_types": ["model.run"], "target": 10 },
  "position": [3, 0]
}
```

State-based objectives (like "be in 2+ collectives") can be checked at event
processing time or board-view time by querying existing data.
