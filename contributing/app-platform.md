---
audience: maintainer
last-verified: 2026-11-19
---

# App platform

The app platform is what swamp serves to apps at `/app-platform/<major>/`. Its
design and contract are in `design/surfaces/apps.md` ("The app platform"); this
page is the commands.

## Build it

```bash
deno run build-app-platform   # npm ci + build of packages/app-platform/1 into packages/app-platform/dist/1, then pack it
```

It needs `npm` on `PATH`. The build writes the production files serve answers
from, plus `dev/` (the development build) and `types/` (the kit's declarations
and the library declarations they reach). `scripts/pack_app_platform.ts` then
packs `dev/` and `types/` into `dist/<major>/authoring.tar.gz`, laid out as an
app's `.swamp-platform/` (`platform/<major>/dev/`, `ui/`, `node_modules/`),
records its hash in `platform.json` and removes the two folders. The archive is
deterministic, so an unchanged build packs to the same bytes. `swamp app init`,
`dev` and `build` unpack it into the app.

`deno run compile` refuses to build without the dist, with one older than the
source's minor, without the archive, or with `dev/` or `types/` left unpacked
(`npm run build` run on its own), unless given `--no-app-platform`.

## Change what it exports

1. Edit the module (`packages/app-sdk/mod.ts`, `packages/app-sdk/react.tsx`, or
   `packages/app-platform/<major>/ui/index.ts`).
2. Adding an export, or a library module, bumps `minor` in
   `packages/app-platform/<major>/platform.json`. Removing or renaming an
   export needs a new major.
3. Rewrite the snapshot and rebuild:

   ```bash
   deno run app-platform-surface 1
   deno run build-app-platform
   ```

4. `integration/app_platform_rules_test.ts` fails when the source, the snapshot
   and the minor disagree.

## Add a library module

Pin it exactly in `packages/app-platform/<major>/package.json` (`npm install
--save-exact`), add it to `ESM` in `build.mjs` and to `PLATFORM_MODULES` in
`packages/app-sdk/vite.ts`, pin it in the templates' `package.json` for
`bun test`, bump the minor, and run `deno run audit`.
