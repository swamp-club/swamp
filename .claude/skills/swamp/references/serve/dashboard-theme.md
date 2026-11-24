# Dashboard Theme (White-Label)

Rebrand the swamp dashboard — colours, logo, product name, favicon and fonts —
for `swamp serve`, `swamp dashboard` and `swamp start`, including the apps area
and the apps inside it. A theme is files in the repo; no command, flag or
restart is involved. A repo can hold several named themes; viewers switch
between them, and back to swamp's own look, from a picker in the sidebar.

## Where themes live

```
<repo>/dashboard-themes/
└── <id>/             # one folder per theme; id is lowercase letters, digits, -
    ├── theme.yaml    # required
    ├── theme.css     # optional: restyles anything tokens cannot reach
    ├── logo.svg      # optional, any file theme.yaml names
    └── fonts/*.woff2 # optional
```

**Add a new theme folder; never rewrite someone else's.** A new folder keeps the
old theme one click away in the picker. Edit an existing theme only when the
user asks to change that theme. An older single `<repo>/dashboard-theme/` folder
still works and is listed as `default`.

`<repo>` is the repo serve runs from: the `--repo-dir` it was started with, or
its working directory (the folder holding `.swamp/serve.yaml`). For the local
dashboard each workspace's repo carries its own theme.

Commit the folder (it sits outside the ignored `.swamp/`): the theme travels
with the repo, so every serve instance and every checkout shows the same brand.

## theme.yaml

```yaml
label: Acme — night shift # the name in the picker (≤ 40 chars); defaults to name, then the folder id
default: true # the theme everyone sees until they pick another; set only if the user asks
locked: true # with default: hides the picker and swamp's own look (white-label); set only if asked
name: Acme Ops # replaces "Swamp" in the sidebar, login page and tab titles (≤ 40 chars)
logo: logo.svg # replaces the SC mark everywhere; svg, png, jpg or webp, ≤ 512 KiB
favicon: favicon.svg
fonts:
  body: '"Acme Sans", system-ui, sans-serif' # a font stack, not a single name
  display: '"Acme Display", "Acme Sans", sans-serif' # page titles, panel titles, big numbers
  mono: '"Acme Mono", ui-monospace, monospace'
  files: # optional @font-face files: woff2, woff, ttf or otf, ≤ 1 MiB each
    - { family: Acme Sans, src: fonts/acme-400.woff2, weight: "400" }
    - { family: Acme Sans, src: fonts/acme-600.woff2, weight: "500 700" }
shape:
  radius: 1 # multiplies every corner: 0 square, 1 swamp's own, 2–3 pillowy
colors:
  light: {
    accent: "#4f46e5",
    accent-hover: "#4338ca",
    accent-subtle: "#eef2ff",
  }
  dark: { accent: "#818cf8", accent-hover: "#a5b4fc", accent-subtle: "#1e1b4b" }
```

Every key is optional; an omitted token keeps swamp's value. With no
`default: true` anywhere, a lone theme is the default and several themes leave
swamp's look as the default until a viewer picks one. A viewer's pick is kept in
their browser and never changes what others see. Files are paths inside the
theme folder (no `..`, no links out of it), 4 MiB in total.

### Colour tokens

Each mode takes any of these, as `#hex`, `rgb()`, `hsl()`, `oklch()`,
`var(--other-token)` or a named colour:

| Group     | Tokens                                                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page      | `bg` `surface` `surface-hover` `surface-inset` `border` `border-subtle` `border-strong`                                                                               |
| Text      | `text-1` `text-2` `text-3`                                                                                                                                            |
| Brand     | `accent` `accent-hover` `accent-subtle` `on-accent` (text and icons on an `accent` fill)                                                                              |
| Sidebar   | `sidebar-bg` `sidebar-text` `sidebar-text-active` `sidebar-text-muted` `sidebar-hover` `sidebar-active` `sidebar-accent`                                              |
| Status    | `success(-bg)` `warning(-bg)` `danger(-bg)` `info(-bg)` `running(-bg)` `cancelled(-bg)` `tile-idle`                                                                   |
| Charts    | `chart-bar-1` succeeded, `chart-bar-2` failed, `chart-bar-4` running/waiting and other, `chart-bar-5` cancelled (`chart-bar-3` is unused), `chart-grid` `chart-label` |
| Skeletons | `skel-shine`                                                                                                                                                          |

## theme.css: beyond tokens

A theme that should feel like a different product, not a recolour, needs
`theme.css`: borders, shadows, backgrounds, density, letter-spacing, uppercase
labels, card treatments. It loads after everything else, so a rule with the same
selector wins. Prefer tokens (`var(--accent)` and the rest) inside it so light
and dark both follow.

Stable hooks:

| Area     | Classes                                                                                                                                                                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell    | `.app` `.main` `.sidebar-frame` `.sidebar-header` `.brand-logo` `.sidebar-brand-text` `.sidebar-section` `.sidebar-section-label` `.sidebar-nav-item` (`.active`, `.nav-item-off`) `.sidebar-nav-icon` `.sidebar-nav-indicator` `.nav-badge` `.sidebar-footer` `.sidebar-health` |
| Pages    | `.page-header` (its `h1` is the page title)                                                                                                                                                                                                                                      |
| Panels   | `.panels-grid` `.panel` `.panel-header` `.panel-title` `.panel-count` `.card`                                                                                                                                                                                                    |
| Stats    | `.stat-card` `.stat-label` `.stat-value`                                                                                                                                                                                                                                         |
| Tables   | `.table-wrap` `.data-table`                                                                                                                                                                                                                                                      |
| Controls | `.btn-sm` `.btn-approve` `.theme-toggle` `.theme-toggle-button[aria-pressed="true"]` `.pager` `.pager-page.is-current`                                                                                                                                                           |
| Badges   | `.status-pill` (`--succeeded`, `--failed`, `--running`, …) `.status-dot` `.trigger-badge` (`--schedule`, `--webhook`, `--manual`, `--api`) `.health-pill`                                                                                                                        |
| Charts   | `.chart-area` `.chart-title` `.overview-chart-tooltip`                                                                                                                                                                                                                           |
| Login    | `.login-page` `.login-container` `.login-card` `.login-brand`                                                                                                                                                                                                                    |

Only values computed from data (bar widths, positions) are still inline; every
other style is a class, so no rule needs `!important`. `@import` and any `url()`
that is not a `data:` URL are refused, so a theme cannot make the page fetch
from another site; embed images as `data:` URLs.

### Chart

The executions chart is drawn on a canvas, so `theme.css` cannot select its
bars; it reads these when it draws instead. Set them on `:root` in `theme.css`:

| Property           | Default            | Effect                                        |
| ------------------ | ------------------ | --------------------------------------------- |
| `--chart-bar-glow` | `0`                | glow around each bar in its own colour, in px |
| `--chart-font`     | `var(--font-mono)` | axis labels (size stays 10px)                 |

Bar corners follow `shape.radius`; bar colours are the `chart-bar-*` tokens.

## Workflow for a rebrand

1. Write `theme.yaml` (and copy in the logo and fonts the user supplies).
2. Set **both** `light` and `dark`: a mode left out shows swamp's palette in it.
3. Set related tokens together. They are independent, so changing `accent` alone
   leaves `accent-hover`, `accent-subtle` and `sidebar-active` in the old
   colour.
4. Pick `on-accent` with `accent`: it is the text on buttons and selected marks,
   so it needs 4.5:1 against `accent` in each mode (swamp's default is white in
   light mode, near-black in dark). The input focus ring is drawn from `accent`.
5. Keep status tokens meaning what they mean (green succeeded, red failed) and
   text at 4.5:1 contrast on `bg`, `surface` and the `-bg` tints — swamp's own
   themes meet WCAG 2.2 AA and a theme should not regress that.
6. Check the result (below). An open dashboard picks the change up within a few
   seconds; no reload or restart.

## Checking a theme

```bash
# serve (public, like /auth/info, so the login page is branded)
curl -s https://<serve-host>/dashboard-theme | jq '{themes: [.themes[] | {id, label}], default, locked, errors}'
# one theme as the page receives it; logos and fonts are /dashboard-theme/assets/<hash> paths
curl -s https://<serve-host>/dashboard-theme/<id> | jq '{name, css: (.css | length)}'
```

`themes` lists each theme that loaded, `default` and `locked` say what viewers
see first, and `errors` names each theme folder that did not load and why
(`dashboard-themes/<id>: <field>: <reason>`). An invalid edit is not applied:
the page keeps the last good theme and logs the error to the browser console, so
fix the reported field and save again. Values that could escape a CSS
declaration (`;`, `{`, `}`, quotes, `url(`) are refused.

The local dashboard needs its token for the same request:
`curl -H "x-swamp-local-token: <token from the dashboard URL>" http://127.0.0.1:<port>/w/<workspace>/dashboard-theme`.

## Apps

Apps inherit the theme with no change: the dashboard sends its tokens over the
bridge, including `font-body` and `font-mono`. Font **files** do not reach an
app's sandboxed frame, so end each font stack with a fallback (`system-ui`,
`ui-monospace`) the app can show.

## Not themeable

The `swamp start` page keeps its own "Night swamp" palette, code highlighting
keeps its syntax colours.
