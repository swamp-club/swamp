# Adversarial Review & Plan Iteration

Read this after generating or iterating on a plan. After **every** `plan` or
`iterate` call, you MUST run an adversarial review before the human can approve.

## Step 1: Challenge the Plan

Re-read the plan, then critically evaluate it.

Read `agent-constraints/adversarial-dimensions.md` at the repo root for the
review criteria specific to this repository. If it does not exist, evaluate
across these default dimensions:

- **Architecture**: Are domain boundaries correct? Is this the right abstraction
  level? Are there better patterns?
- **Scope**: Is this doing too much or too little? Does it match the issue? Is
  there scope creep? Are there unnecessary changes?
- **Risk**: Are all failure modes identified? What about edge cases, race
  conditions, backwards compatibility? What could go wrong that isn't listed?
- **Testing**: Is the testing strategy sufficient? Are edge cases covered? Are
  there integration test gaps?
- **Complexity**: Is this over-engineered? Could it be simpler? Are there
  unnecessary abstractions or indirections?
- **Correctness**: Will this actually solve the problem? Are there logical gaps?
  Does the approach match established patterns in the codebase?
- **Documentation**: Does this change affect project documentation? Flag any
  gaps as findings.

## Step 2: Verify Against the Codebase

For each plan step, **read the actual code**:

- Read every file referenced in the plan steps — verify they exist
- Confirm functions, classes, and types exist where claimed
- Grep for related code the plan might have missed
- Check for conflicts with existing patterns or naming conventions
- Verify that proposed test paths and test patterns match the codebase
- Look for code that already does what a step proposes (duplication risk)
- **Trace existing execution paths**: When the plan adds a new entry point to an
  existing capability (e.g. a new way to run workflows, execute model methods,
  acquire locks), find how existing callers invoke that capability and verify
  the plan routes through the same shared code path. New entry points that
  reimplement existing logic are a high-severity finding.
- Check if project documentation describes behavior being changed — flag stale
  docs

## Step 3: Record Findings

Write findings to a YAML file as a YAML object with a `findings` key. **Use an
issue-scoped filename** like `/tmp/findings-issue-<N>.yaml` — a generic
`/tmp/findings.yaml` collides with stale content from previous lifecycle
sessions and can leak unrelated findings into the current review.

```yaml
# /tmp/findings-issue-<N>.yaml
findings:
  - id: ADV-1
    severity: high
    category: architecture
    description: "The plan adds a new service but doesn't define its domain boundary"
  - id: ADV-2
    severity: medium
    category: testing
    description: "No integration tests planned for the new API endpoint"
```

Then record them:

```
swamp model method run issue-<N> adversarial_review \
  --input-file /tmp/findings-issue-<N>.yaml
```

Each finding must have:

- `id`: Sequential identifier (ADV-1, ADV-2, ...)
- `severity`: critical, high, medium, or low
- `category`: Use categories from `agent-constraints/adversarial-dimensions.md`,
  or the defaults above (architecture, scope, risk, testing, complexity,
  correctness, documentation)
- `description`: Clear explanation of the concern

**Critical/high findings block approval.** Medium/low are shown as warnings.

## Step 4: Present to the Human

Show findings grouped by severity:

1. Critical findings (blockers)
2. High findings (blockers)
3. Medium findings (warnings)
4. Low findings (warnings)

If there are blocking findings, say:

> "The adversarial review found N blocking issue(s) that need to be addressed
> before approval. Here's what needs to change: ..."

If no blocking findings, say:

> "Adversarial review passed — no blocking findings. N warning(s) noted. Ready
> for your approval when you are."

## Plan Iteration Loop

When the human gives feedback OR adversarial findings need addressing:

1. **Call iterate** with both the feedback text and your revised plan. Write the
   revised `steps` and `potentialChallenges` to an issue-scoped YAML file (e.g.
   `/tmp/plan-issue-<N>-v2.yaml` — the `-v2` suffix keeps each revision distinct
   if you want to diff between iterations), then run:

   ```
   swamp model method run issue-<N> iterate \
     --input feedback="<human's feedback or adversarial findings>" \
     --input summary="..." \
     --input dddAnalysis="..." \
     --input testingStrategy="..." \
     --input-file /tmp/plan-issue-<N>-v2.yaml
   ```

2. **Resolve addressed findings**. Write resolutions to an issue-scoped YAML
   file:

   ```yaml
   # /tmp/resolutions-issue-<N>.yaml
   resolutions:
     - findingId: ADV-1
       resolutionNote: "Added domain boundary definition in step 2"
     - findingId: ADV-2
       resolutionNote: "Added integration test step covering the new endpoint"
   ```

   ```
   swamp model method run issue-<N> resolve_findings \
     --input-file /tmp/resolutions-issue-<N>.yaml
   ```

3. **Re-run adversarial review** on the new plan version. The review must be
   current with the latest plan version — stale reviews block approval.

4. **Show what changed** between the previous and new plan version. Be specific:
   - "Reordered steps 2 and 3 based on your feedback"
   - "Added regression analysis for module X"
   - "Removed step 4 — you're right, that's already handled by..."

5. **Ask for feedback again.** Keep iterating until:
   - All critical/high adversarial findings are resolved, AND
   - The human says: "approve", "approved", "looks good", "ship it", "go",
     "LGTM"

6. Only then call `approve`:
   ```
   swamp model method run issue-<N> approve
   ```

**The `approve` method will fail** if critical/high findings are unresolved or
if the adversarial review is stale (wrong plan version). This is enforced by the
`adversarial-review-clear` pre-flight check.

## Next Phase

Plan is approved. Read [implementation.md](implementation.md) when the human
says to implement.
