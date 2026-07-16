# Unification

Today, swamp has 3 different storage shapes

1. A [datastore](./datastores.md) tier. Operational Data only. Audit, telemetry, outputs, workflow-runs, evaluated bundles. No definitions.
2. filesystem - source of truth for models, workflows, vaults, pulled extensions.
3. swamp-club - registry for extensions. pushed/pulled from with swamp push/pull

There's a lot of tension across these 3 dimensions, such as

1. Reconstituting a usable environment is a minimum of 3 steps
* use something like git to clone the filesystem bits
* use `swamp datastore sync` to ensure you have the operational data, if you want it
* any sort of environment variables that need to sit outside of a vault.
2. Authoring changes to workflows, models, extensions happens out of tree. A working copy available to a single user, a published copy available in source control, and a published copy available to the ecosystem. Agents work on extensions as they see fit in a local copy. Then there's the git repo they live in. Then there's the swamp club presence.


# Exploration

This design explores changing the shape of swamp.

What if the local filesystem - all of it, becomes the datastore? all extensions, models, workflows, reports, telemetry, audit. Everything.

Pulling an extension from swamp club means bringing it into your swamp datastore.

Authoring a new extension happens in your datastore
Authoring a new workflow happens in your datastore
Authoring a new vault happens in your datastore

Models, workflows, etc. all have the opportunity to become versioned. You can ask the same types of questions you would ask about data - how has my workflow morphed over the past week / month? What roll back the input changes to my model. Instead of having to go out to a system like git, it's all available in the swamp.

Git could be a datastore implementation. Right now it's half git half something else in swamp-club half also git for the extensions themselves.

# The contract

1. Agents work on their own head by default. Default branch per agent, or per task. Can have lifetime and version counts for gc purposes, just like data.
2. Promotion is a deliberate moment. Merge semantic - publish to main. Reconcile differences.
3. Other agents can read whatever references they want. Reconstitution can happen on any divergence. 
4. You can always get a snapshot of the whole at the refs point in time.


