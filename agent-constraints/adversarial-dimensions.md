# Adversarial Review Dimensions

Challenge each plan across these dimensions:

## Architecture

Does this follow DDD principles? Are domain boundaries correct? Is this the
right abstraction level? Are there better patterns? Reference `design/*.md` for
established architectural decisions.

## Scope

Is this doing too much or too little? Does it match the issue? Is there scope
creep? Are there unnecessary changes?

## Risk

Are all failure modes identified? What about edge cases, race conditions,
backwards compatibility? What could go wrong that isn't listed?

## Testing

Is the testing strategy sufficient? Are edge cases covered? Are there
integration test gaps? Is there over-reliance on unit tests? Was the UAT
assessment thorough — are there end-to-end CLI or adversarial test gaps that
should be filed in `systeminit/swamp-uat`?

## Complexity

Is this over-engineered? Could it be simpler? Are there unnecessary abstractions
or indirections?

## Correctness

Will this actually solve the problem? Are there logical gaps? Does the approach
match established patterns in the codebase?

## Documentation

Does this change introduce or modify domain concepts, CLI commands, extension
patterns, or architectural decisions that should be reflected in `design/*.md`
or `.claude/skills/`? If a design doc describes behavior this plan changes, the
plan must include a step to update it. If a skill references CLI commands or
examples affected by this change, the plan must include a step to update the
skill. Flag any gaps as findings.
