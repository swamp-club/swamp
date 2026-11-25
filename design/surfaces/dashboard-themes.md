---
audience: operator, maintainer
last-verified: 2026-11-24 @ 2e73b114
---

# Dashboard themes

A repo can restyle the dashboard — serve's, the local one, the apps area and
the apps inside it — with themes kept as files in the repo. Viewers pick
between them, or swamp's own look, from a picker in the sidebar.

## Shape

- **Files, not config.** Each theme is `dashboard-themes/<id>/` (outside the
  ignored `.swamp/`, so it is committed): `theme.yaml` (label, brand name,
  logo, favicon, colour tokens for light and dark, fonts, a corner-radius
  scale, `default`, `locked`) and an optional `theme.css`. A single
  `dashboard-theme/` folder is read as the theme `default`.
- **Tokens first, stylesheet second.** Colour, font, radius and chart tokens
  are the stable contract; `theme.css` loads after every stylesheet and
  targets the class names listed in the swamp skill's theme guide. Only values
  computed from data are inline styles, so no rule needs `!important`.
- **Choice.** `default: true` sets what viewers see first; `locked: true` on
  the default hides the picker and swamp's look (white-label). A viewer's pick
  is kept in their browser, per workspace, and never changes what others see.
- **Apps** get the tokens over the bridge like the light/dark mode, and are
  re-sent them when the theme changes.

## Serving

| Path | Answers |
| --- | --- |
| `/dashboard-theme` | The index: ids, labels, per-theme versions, default, locked, errors. No theme bodies |
| `/dashboard-theme/<id>` | One theme; logos and fonts as asset paths |
| `/dashboard-theme/assets/<hash>.<ext>` | A logo or font, named by its content hash, `immutable` |

Serve answers them before sign-in so the login page is branded; the theme is
therefore public, which a white-label brand is anyway. The local hub forwards
them per workspace behind its token, so the page fetches assets and makes
blob URLs rather than linking them.

`DashboardThemeStore` (`src/serve/dashboard_theme.ts`) rebuilds a theme only
when a file in its folder changes size or time, and one look at the folders
serves every caller for a second. A version is a hash of what a theme builds
to, never of file times, so instances that checked out the same files at
different moments agree on every version and `ETag`.

The page has no theme clock: each health snapshot carries `themeVersion`, and
the page fetches the index only when it changes (and on coming back into
view), then only the theme it shows. A broken edit is reported in `errors` and
the page keeps the last good copy of that theme.

## Limits

- `theme.css` cannot make the page fetch: `@import` and any non-`data:` `url()`
  are refused by serve and again by the page. It can hide or relabel parts of
  the page, so a theme carries the trust of a commit to the repo.
- Token values are validated so none can leave its CSS declaration.
- An asset is served with a sandboxing CSP and `nosniff`, and the page shows
  an SVG as a `data:` URL, so a logo cannot run script on the dashboard origin.
- A theme file is read only if it resolves inside its theme folder.
- No contrast check: a theme can make text unreadable.
- The `swamp start` page keeps its own palette, and code highlighting keeps its
  syntax colours.
