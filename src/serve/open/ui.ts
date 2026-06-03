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

export const OPEN_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Swamp</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --green: #39ff14;
    --green-dim: rgba(57, 255, 20, 0.3);
    --green-dimmer: rgba(57, 255, 20, 0.15);
    --cyan: #22d3ee;
    --magenta: #ff00ff;
    --bg: #000;
    --bg-card: rgba(0, 0, 0, 0.8);
    --muted: #9ca3af;
    --label: #d1d5db;
    --red: #ff4d4d;
    --amber: #fbbf24;
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --orbitron: "Orbitron", "JetBrains Mono", monospace;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  body {
    margin: 0;
    font: 14px/1.5 var(--mono);
    color: #e6e6e6;
    -webkit-font-smoothing: antialiased;
    background:
      radial-gradient(ellipse at top, rgba(57,255,20,0.05), transparent 60%),
      repeating-linear-gradient(0deg, rgba(0,0,0,0.3), rgba(0,0,0,0.3) 1px, transparent 1px, transparent 3px),
      #000;
    min-height: 100vh;
  }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--green-dim); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(57,255,20,0.4); }
  * { scrollbar-width: thin; scrollbar-color: var(--green-dim) transparent; }

  header {
    padding: 14px 24px;
    background: rgba(0,0,0,0.8);
    border-bottom: 1px solid var(--green-dim);
    position: sticky; top: 0; z-index: 10;
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    gap: 16px;
  }
  header h1 { flex: 1 1 auto; min-width: 0; }
  .header-right {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-shrink: 0;
  }
  .whoami {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.05em;
    color: var(--muted);
    text-transform: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .whoami::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 6px var(--green);
  }
  header h1 {
    margin: 0;
    font-family: var(--orbitron);
    font-weight: 700;
    font-size: 18px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--green);
    text-shadow: 0 0 12px rgba(57,255,20,0.5);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  header h1 .crumb {
    cursor: pointer;
    transition: opacity 0.15s;
  }
  header h1 .crumb:hover { opacity: 0.7; }
  header h1 .sep { color: var(--cyan); opacity: 0.6; }
  header h1 .repo-path {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.05em;
    text-transform: none;
    color: var(--muted);
    text-shadow: none;
    max-width: 60vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  header button, header #vaultBtn {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 6px 12px;
    background: transparent;
    border: 1px solid var(--green-dim);
    color: var(--green);
    border-radius: 0;
    cursor: pointer;
    transition: all 0.15s;
  }
  header button:hover { border-color: var(--green); box-shadow: 0 0 8px var(--green-dimmer); }

  .mode-btn {
    flex: 0 0 auto;
    padding: 10px 22px;
    background: transparent;
    /* reserve borders on all sides so .active doesn't resize the button */
    border: 1px solid transparent;
    border-bottom: 2px solid transparent;
    border-right: 1px solid var(--green-dim);
    color: var(--muted);
    font-family: var(--orbitron);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    cursor: pointer;
    transition: color 0.15s, background 0.15s, border-bottom-color 0.15s, text-shadow 0.15s;
    margin-bottom: -1px;
  }
  .mode-btn:hover { color: var(--green); background: rgba(57,255,20,0.04); }
  .mode-btn.active {
    color: var(--green);
    background: rgba(57,255,20,0.08);
    border-bottom-color: var(--green);
    text-shadow: 0 0 8px rgba(57,255,20,0.4);
  }

  .layout { display: grid; grid-template-columns: 340px 1fr; height: calc(100vh - 51px); }
  aside {
    border-right: 1px solid var(--green-dim);
    overflow-y: auto;
    background: rgba(0,0,0,0.4);
  }
  main { overflow-y: auto; padding: 24px 28px; }

  aside h2, main h2 {
    font-family: var(--orbitron);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: var(--label);
    margin: 16px 16px 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(34, 211, 238, 0.3);
  }
  main h2 { margin: 20px 0 10px; }
  main h2:first-of-type { margin-top: 0; }

  .search { padding: 14px 16px; position: sticky; top: 0; background: rgba(0,0,0,0.9); border-bottom: 1px solid var(--green-dim); z-index: 5; }
  .search input, input, textarea, select {
    width: 100%;
    padding: 8px 10px;
    background: rgba(0,0,0,0.6);
    border: 1px solid var(--green-dim);
    color: var(--green);
    border-radius: 0;
    font: inherit;
    font-family: var(--mono);
    outline: none;
    transition: all 0.15s;
  }
  input:focus, textarea:focus, select:focus {
    border-color: var(--green);
    box-shadow: 0 0 8px var(--green-dimmer);
  }
  input::placeholder, textarea::placeholder { color: rgba(156, 163, 175, 0.6); }

  select {
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    padding-right: 32px;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2339ff14' stroke-width='2.5' stroke-linecap='square'><polyline points='6 9 12 15 18 9'/></svg>");
    background-repeat: no-repeat;
    background-position: right 10px center;
    background-size: 12px;
    background-color: #000;
    color: var(--green);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 12px;
    font-family: var(--mono);
  }
  /* Native option styling is limited, but these win on Chrome/Firefox desktop. */
  select option,
  select optgroup {
    background-color: #000 !important;
    color: var(--green) !important;
    font-family: var(--mono) !important;
    font-size: 12px;
    padding: 6px 10px;
  }
  select option:hover,
  select option:checked,
  select option:focus {
    background: linear-gradient(0deg, rgba(57,255,20,0.15), rgba(57,255,20,0.15)) !important;
    color: var(--green) !important;
  }

  .ext-list { list-style: none; padding: 0; margin: 0; }
  .ext-list li {
    padding: 10px 16px;
    border-bottom: 1px solid rgba(57, 255, 20, 0.1);
    cursor: pointer;
    transition: all 0.15s;
    position: relative;
  }
  .ext-list li:hover {
    background: rgba(57, 255, 20, 0.05);
    border-left: 2px solid var(--green);
    padding-left: 14px;
  }
  .ext-list li.active {
    background: rgba(57, 255, 20, 0.08);
    border-left: 2px solid var(--green);
    padding-left: 14px;
  }
  .ext-list .name {
    font-family: var(--orbitron);
    font-weight: 600;
    font-size: 12px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--green);
  }
  .ext-list .meta { color: var(--muted); font-size: 11px; margin-top: 2px; }

  .badge {
    display: inline-block;
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 0;
    background: transparent;
    border: 1px solid var(--green);
    color: var(--green);
    margin-left: 6px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  form.run-form {
    background: var(--bg-card);
    border: 1px solid var(--green-dim);
    padding: 16px 20px;
    border-radius: 0;
    margin-bottom: 16px;
    position: relative;
  }
  form.run-form::before, form.run-form::after {
    content: "";
    position: absolute;
    width: 8px; height: 8px;
    border: 2px solid var(--green);
  }
  form.run-form::before { top: -1px; left: -1px; border-right: none; border-bottom: none; }
  form.run-form::after { bottom: -1px; right: -1px; border-left: none; border-top: none; }
  form.run-form label {
    display: block;
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--label);
    margin: 12px 0 4px;
  }
  .field-row {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    width: 100%;
    gap: 8px;
  }
  .field-row > input {
    flex: 1 1 0;
    min-width: 0;
    width: auto;
    height: 36px;
    box-sizing: border-box;
  }
  .field-row > textarea {
    flex: 1 1 0;
    min-width: 0;
    width: auto;
  }
  .field-row > .vault-slot {
    display: flex;
    flex-shrink: 0;
  }
  .field-row > .vault-slot > button {
    height: 36px;
    width: 36px;
    min-width: 36px;
    margin: 0 !important;
    padding: 0 !important;
  }
  .field-row:has(textarea) {
    align-items: stretch;
  }
  .field-row:has(textarea) > .vault-slot > button {
    height: auto;
    align-self: stretch;
  }
  form.run-form button {
    margin-top: 14px;
    padding: 8px 20px;
    background: transparent;
    color: var(--green);
    border: 1px solid var(--green);
    border-radius: 0;
    cursor: pointer;
    font-family: var(--orbitron);
    font-weight: 600;
    font-size: 12px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    transition: all 0.15s;
  }
  form.run-form button:hover {
    background: rgba(57, 255, 20, 0.1);
    box-shadow: 0 0 12px var(--green-dimmer);
  }
  form.run-form button:disabled { opacity: 0.4; cursor: not-allowed; }

  button {
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .log {
    background: #000;
    border: 1px solid var(--green-dim);
    padding: 12px;
    border-radius: 0;
    font: 12px/1.5 var(--mono);
    white-space: pre-wrap;
    max-height: 320px;
    overflow-y: auto;
    color: var(--green);
    margin: 18px 0;
  }

  /* --- Task follower --- */
  .task-follower { margin: 18px 0; }
  .dag-graph {
    background: rgba(0,0,0,0.6);
    border: 1px solid var(--green-dim);
    border-top: 0;
    overflow: auto;
    position: relative;
  }
  .dag-graph svg { display: block; min-width: 100%; }
  .dag-graph svg .dag-node-bg { transition: filter 0.15s; }
  .dag-graph svg .dag-node-label {
    font-family: var(--mono);
    font-size: 11px;
    fill: var(--label);
    pointer-events: none;
  }
  .dag-graph svg .dag-node-tag {
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 700;
    pointer-events: none;
  }
  .dag-graph svg g[data-node] { cursor: pointer; }
  .dag-graph svg g[data-node]:hover .dag-node-bg { filter: brightness(1.3); }
  .task-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 18px 24px;
    padding: 12px 16px;
    background: rgba(0,0,0,0.6);
    border: 1px solid var(--green-dim);
    border-bottom: 0;
    font: 11px var(--mono);
  }
  .task-meta .k { color: var(--muted); margin-right: 6px; }
  .task-meta .v { color: var(--label); }
  .task-meta .v.status-running { color: var(--amber); }
  .task-meta .v.status-succeeded { color: var(--green); }
  .task-meta .v.status-failed { color: var(--red); }

  .job-strip {
    display: flex;
    gap: 10px;
    padding: 14px 16px;
    background: rgba(0,0,0,0.4);
    border: 1px solid var(--green-dim);
    border-top: 0;
    border-bottom: 0;
    overflow-x: auto;
  }
  .job-card {
    flex: 0 0 auto;
    min-width: 160px;
    padding: 10px 14px;
    background: rgba(0,0,0,0.6);
    border: 1px solid var(--green-dim);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 10px;
    transition: all 0.15s;
  }
  .job-card:hover { background: rgba(57,255,20,0.04); border-color: rgba(57,255,20,0.5); }
  .job-card.active {
    border-color: var(--green);
    background: rgba(57,255,20,0.08);
    box-shadow: 0 0 10px var(--green-dimmer);
  }
  .job-card .job-name {
    font-family: var(--orbitron);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--label);
    flex: 1;
  }
  .job-card.active .job-name { color: var(--green); }
  .job-card .job-dur { font: 10px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }

  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    display: inline-block;
  }
  .status-dot.pending { background: transparent; border: 1px solid var(--muted); }
  .status-dot.running {
    background: var(--amber);
    box-shadow: 0 0 6px var(--amber);
    animation: task-pulse 1s ease-in-out infinite;
  }
  .status-dot.succeeded { background: var(--green); box-shadow: 0 0 6px var(--green-dimmer); }
  .status-dot.failed { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .status-dot.skipped { background: var(--muted); opacity: 0.5; }
  @keyframes task-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .job-detail {
    background: rgba(0,0,0,0.5);
    border: 1px solid var(--green-dim);
    padding: 14px 18px;
  }
  .step-row {
    position: relative;
    padding: 4px 0 4px 22px;
  }
  .step-row::before {
    content: "";
    position: absolute;
    left: 4px;
    top: 20px;
    bottom: -4px;
    width: 1px;
    background: rgba(57,255,20,0.15);
  }
  .step-row:last-child::before { display: none; }
  .step-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    margin-left: -22px;
    padding-left: 22px;
    cursor: pointer;
    transition: background 0.12s;
    position: relative;
  }
  .step-header:hover { background: rgba(57,255,20,0.04); }
  .step-header .status-dot {
    position: absolute;
    left: -1px;
    top: 11px;
    width: 10px;
    height: 10px;
  }
  .step-header .step-caret {
    color: var(--cyan);
    font-size: 10px;
    width: 10px;
    flex-shrink: 0;
  }
  .step-header .step-name {
    flex: 1;
    font: 12px var(--mono);
    color: var(--label);
  }
  .step-header .step-badges { display: flex; gap: 4px; align-items: center; }
  .step-header .step-badge {
    font-size: 9px;
    color: var(--muted);
    opacity: 0.7;
  }
  .step-header .step-dur {
    font: 11px var(--mono);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .step-body {
    margin: 6px 0 10px 8px;
    padding-left: 12px;
    border-left: 1px solid rgba(57,255,20,0.15);
  }
  .step-body .sub-heading {
    font: 10px var(--orbitron);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 8px 0 4px;
  }
  .step-log {
    background: #000;
    border: 1px solid rgba(57,255,20,0.2);
    padding: 8px 10px;
    font: 11px/1.5 var(--mono);
    color: var(--green);
    white-space: pre-wrap;
    max-height: 220px;
    overflow-y: auto;
  }
  .step-log .err-line { color: var(--red); }
  .step-error {
    background: #000;
    border: 1px solid rgba(255,77,77,0.4);
    padding: 8px 10px;
    font: 11px/1.5 var(--mono);
    color: var(--red);
    white-space: pre-wrap;
  }
  .step-artifact, .step-report {
    background: rgba(0,0,0,0.5);
    border: 1px solid rgba(57,255,20,0.2);
    padding: 8px 10px;
    margin-bottom: 6px;
  }
  .step-artifact-name, .step-report-name {
    font: 11px var(--orbitron);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--green);
  }
  .step-report-name { color: #a78bfa; }
  .step-artifact pre, .step-report pre {
    margin: 6px 0 0;
    padding: 6px 8px;
    background: #000;
    border: 1px solid rgba(57,255,20,0.15);
    font: 10px/1.4 var(--mono);
    white-space: pre-wrap;
    max-height: 260px;
    overflow: auto;
    color: var(--label);
  }
  #runOutput:not(:empty) { margin-top: 20px; }
  main h2 { margin-top: 28px; }
  main h2:first-of-type { margin-top: 0; }
  .log .err { color: var(--red); }
  .log .ok { color: var(--green); text-shadow: 0 0 6px var(--green-dimmer); }
  .log .evt { color: var(--cyan); }

  table.history { width: 100%; border-collapse: collapse; font-size: 12px; font-family: var(--mono); }
  table.history th, table.history td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid rgba(57,255,20,0.1);
  }
  table.history th {
    color: var(--label);
    font-family: var(--orbitron);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .status-succeeded { color: var(--green); }
  .status-failed { color: var(--red); }
  .status-running { color: var(--amber); }

  .hint { color: var(--muted); font-family: var(--mono); font-size: 12px; }
  .err { color: var(--red); }
  .ok { color: var(--green); }

  details {
    margin: 8px 0;
  }
  details summary {
    cursor: pointer;
    color: var(--label);
    font-family: var(--orbitron);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  /* Section header: NN ── LABEL ── verb ──── */
  .section-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 0 20px;
  }
  .section-header .num {
    font-family: var(--mono);
    font-size: 12px;
    color: rgba(34, 211, 238, 0.8);
    letter-spacing: 0.2em;
    flex-shrink: 0;
  }
  .section-header .label {
    font-family: var(--orbitron);
    font-size: 14px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: #fff;
    flex-shrink: 0;
  }
  .section-header .verb {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 0.15em;
    flex-shrink: 0;
  }
  .section-header .line {
    flex: 1;
    height: 1px;
    background: rgba(34, 211, 238, 0.4);
  }

  .panel {
    background: var(--bg-card);
    border: 1px solid var(--green-dim);
    padding: 16px 20px;
    margin-bottom: 20px;
    position: relative;
  }
  .panel::before, .panel::after {
    content: "";
    position: absolute;
    width: 10px; height: 10px;
    border: 2px solid var(--green);
  }
  .panel::before { top: -1px; left: -1px; border-right: none; border-bottom: none; }
  .panel::after { bottom: -1px; right: -1px; border-left: none; border-top: none; }

  /* --- Themed combo (custom dropdown) --- */
  .combo { position: relative; width: 100%; }
  .combo-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(0,0,0,0.6);
    border: 1px solid var(--green-dim);
    color: var(--green);
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: all 0.15s;
    margin: 0 !important;
    height: 36px;
    box-sizing: border-box;
  }
  .combo-btn:hover, .combo.open .combo-btn {
    border-color: var(--green);
    box-shadow: 0 0 8px var(--green-dimmer);
  }
  .combo-label {
    text-align: left;
    flex: 1;
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .combo-caret { color: var(--green); font-size: 10px; }
  .combo.open .combo-caret { transform: rotate(180deg); }
  .combo-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: #000;
    border: 1px solid var(--green);
    max-height: 280px;
    overflow-y: auto;
    z-index: 200;
    list-style: none;
    padding: 4px 0;
    margin: 0;
    box-shadow: 0 0 16px rgba(57,255,20,0.15);
    display: none;
  }
  .combo.open .combo-menu { display: block; }
  .combo-menu li {
    padding: 8px 14px;
    cursor: pointer;
    transition: background 0.12s;
    border-left: 2px solid transparent;
  }
  .combo-menu li:hover { background: rgba(57,255,20,0.08); border-left-color: var(--green); }
  .combo-menu li.selected { background: rgba(57,255,20,0.12); border-left-color: var(--green); }
  .combo-item-name {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--green);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .combo-item-tag {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    border: 1px solid var(--cyan);
    color: var(--cyan);
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .combo-item-desc {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    margin-top: 3px;
    line-height: 1.4;
  }

  /* --- Extension detail --- */
  .ext-detail-heading {
    font-family: var(--orbitron);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    margin: 12px 0 6px;
  }
  .ext-detail-heading:first-child { margin-top: 0; }
  .ext-detail-badges {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .ext-detail-pre {
    white-space: pre-wrap;
    font: 12px/1.5 var(--mono);
    color: var(--label);
    background: #000;
    border: 1px solid rgba(57,255,20,0.15);
    padding: 12px;
    max-height: 400px;
    overflow: auto;
    margin: 0;
  }
  .ext-content-card { margin-bottom: 10px; }
  .ext-content-title {
    font-family: var(--orbitron);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--green);
    margin-bottom: 4px;
  }
  .ext-arg-list {
    list-style: none;
    padding: 0;
    margin: 4px 0 0 0;
    font: 12px/1.6 var(--mono);
  }
  .ext-arg-list li {
    padding: 2px 0;
    border-bottom: 1px dashed rgba(57,255,20,0.08);
  }
  .ext-arg-list li:last-child { border-bottom: 0; }
  .arg-name { color: var(--label); font-weight: 600; }
  .arg-type { color: var(--cyan); font-size: 11px; margin-left: 4px; }
  .arg-req { color: var(--red); }
  .ext-method {
    background: rgba(0,0,0,0.4);
    border-left: 2px solid var(--green-dim);
    padding: 8px 10px;
    margin-bottom: 8px;
  }
  .ext-method:hover { border-left-color: var(--green); }
  .ext-method-name {
    font: 12px var(--mono);
    font-weight: 600;
    color: var(--green);
  }

  /* --- Modal --- */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    backdrop-filter: blur(2px);
  }
  .modal-panel {
    background: #000;
    border: 1px solid var(--green);
    padding: 24px 28px;
    width: 600px;
    max-width: 92vw;
    max-height: 85vh;
    overflow-y: auto;
    box-shadow: 0 0 32px rgba(57, 255, 20, 0.15);
    position: relative;
  }
  .modal-panel::before, .modal-panel::after {
    content: "";
    position: absolute;
    width: 12px; height: 12px;
    border: 2px solid var(--green);
  }
  .modal-panel::before { top: -1px; left: -1px; border-right: none; border-bottom: none; }
  .modal-panel::after { bottom: -1px; right: -1px; border-left: none; border-top: none; }
  .modal-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 14px;
  }
  .modal-header .num {
    font-family: var(--mono);
    font-size: 11px;
    color: rgba(34, 211, 238, 0.8);
    letter-spacing: 0.2em;
  }
  .modal-header .label {
    font-family: var(--orbitron);
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: #fff;
  }
  .modal-header .line {
    flex: 1;
    height: 1px;
    background: rgba(34, 211, 238, 0.3);
  }
  .modal-close-btn {
    padding: 8px 18px;
    background: transparent;
    border: 1px solid var(--green-dim);
    color: var(--muted);
    font-family: var(--orbitron);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    cursor: pointer;
    transition: all 0.15s;
  }
  .modal-close-btn:hover {
    border-color: var(--green);
    color: var(--green);
    box-shadow: 0 0 8px var(--green-dimmer);
  }

  /* --- Vault cards --- */
  .vault-card {
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid var(--green-dim);
    padding: 10px 14px;
    margin-bottom: 10px;
  }
  .vault-card summary {
    cursor: pointer;
    list-style: none;
    font-family: var(--mono);
  }
  .vault-card summary::-webkit-details-marker { display: none; }
  .vault-card summary::before {
    content: "▸";
    color: var(--cyan);
    margin-right: 8px;
    display: inline-block;
    transition: transform 0.15s;
  }
  .vault-card[open] summary::before { transform: rotate(90deg); }
  .vault-card-name {
    font-family: var(--orbitron);
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--green);
  }
  .vault-key-list {
    list-style: none;
    padding: 0;
    margin: 10px 0 10px 18px;
    font: 12px/1.6 var(--mono);
    color: var(--muted);
  }
  .vault-key-list li { padding: 2px 0; }
  .vault-key-list li::before {
    content: "- ";
    color: var(--cyan);
    opacity: 0.6;
  }
  .vault-put-form {
    display: flex;
    gap: 8px;
    margin-top: 10px;
    align-items: center;
  }
  .vault-put-form input { flex: 1; padding: 6px 8px; height: 32px; box-sizing: border-box; }
  .vault-put-form input[name="value"] { flex: 2; }
  .vault-put-form button {
    flex-shrink: 0;
    padding: 0 16px;
    height: 32px;
    background: transparent;
    color: var(--green);
    border: 1px solid var(--green);
    font-family: var(--orbitron);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    cursor: pointer;
    transition: all 0.15s;
  }
  .vault-put-form button:hover {
    background: rgba(57, 255, 20, 0.08);
    box-shadow: 0 0 8px var(--green-dimmer);
  }

  .picker-wrap {
    max-width: 820px;
    margin: 40px auto;
    padding: 0 24px;
  }
  .picker-wrap .hero-title {
    font-family: var(--orbitron);
    font-size: 36px;
    font-weight: 700;
    color: var(--green);
    text-shadow: 0 0 20px rgba(57, 255, 20, 0.4);
    margin: 0 0 8px;
    letter-spacing: 0.08em;
  }
  .picker-wrap .hero-sub {
    color: var(--muted);
    font-family: var(--mono);
    margin: 0 0 32px;
  }
</style>
</head>
<body>
<header>
  <h1 id="headerTitle"><span class="crumb" id="headerHome">&gt;&gt; SWAMP</span></h1>
  <div class="header-right" id="headerRight"></div>
</header>
<div id="app"></div>
<script>
const $ = (id) => document.getElementById(id);
let installedNames = new Set();
let selected = null;
let vaultCache = [];

async function refreshVaults() {
  try {
    const r = await fetch('/api/vaults');
    const d = await r.json();
    vaultCache = d.vaults || [];
  } catch {
    vaultCache = [];
  }
  return vaultCache;
}

const MAIN_LAYOUT =
  '<nav id="modeNav" style="display:flex;gap:0;border-bottom:1px solid var(--green-dim);background:rgba(0,0,0,0.6)">' +
    '<button data-mode="extensions" class="mode-btn">Extensions</button>' +
    '<button data-mode="workflows" class="mode-btn">Workflows</button>' +
    '<button data-mode="reports" class="mode-btn">Reports</button>' +
  '</nav>' +
  '<div id="modeContainer"></div>';

const EXTENSIONS_LAYOUT = '<div class="layout">' +
  '<aside>' +
    '<div class="search"><input id="q" placeholder="Search registry..." autofocus></div>' +
    '<h2>Installed</h2><ul class="ext-list" id="installed"></ul>' +
    '<h2>Registry</h2><ul class="ext-list" id="registry"></ul>' +
  '</aside>' +
  '<main id="main"><p class="hint">Select an extension on the left.</p></main>' +
'</div>';

const WORKFLOWS_LAYOUT = '<div class="layout">' +
  '<aside>' +
    '<h2>Workflows</h2><ul class="ext-list" id="workflowList"></ul>' +
  '</aside>' +
  '<main id="main"><p class="hint">Select a workflow on the left.</p></main>' +
'</div>';

const REPORTS_LAYOUT = '<div class="layout">' +
  '<aside>' +
    '<h2>Reports</h2><ul class="ext-list" id="reportList"></ul>' +
  '</aside>' +
  '<main id="main"><p class="hint">Select a report on the left.</p></main>' +
'</div>';

async function boot() {
  const home = $('headerHome');
  if (home) home.onclick = () => renderPicker();
  const r = await fetch('/api/repo/status');
  const d = await r.json();
  if (d.initialized) {
    setHeaderPath(d.path);
    renderMainUi();
  } else {
    setHeaderPath(null);
    renderPicker();
  }
}

function setHeaderPath(path) {
  const title = $('headerTitle');
  if (!title) return;
  // Always rebuild to keep the home crumb click handler fresh.
  title.innerHTML = '<span class="crumb" id="headerHome">&gt;&gt; SWAMP</span>' +
    (path
      ? '<span class="sep">&gt;&gt;</span><span class="repo-path" title="' + escapeHtml(path) + '">' + escapeHtml(path) + '</span>'
      : '');
  const home = $('headerHome');
  if (home) home.onclick = () => renderPicker();
}

let currentMode = 'extensions';

function renderMainUi() {
  $('app').innerHTML = MAIN_LAYOUT;
  populateHeaderRight();
  refreshVaults();
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.onclick = () => switchMode(btn.dataset.mode);
  });
  switchMode(currentMode);
}

function populateHeaderRight() {
  const right = $('headerRight');
  if (!right) return;
  right.innerHTML = '';
  const vaultBtn = document.createElement('button');
  vaultBtn.id = 'vaultBtn';
  vaultBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" style="vertical-align:-2px;margin-right:6px"><rect x="4" y="11" width="16" height="10"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>Vaults';
  vaultBtn.style.cssText = 'padding:6px 14px;background:transparent;border:1px solid var(--green-dim);color:var(--green);font-family:var(--orbitron);font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;cursor:pointer;transition:all 0.15s;display:inline-flex;align-items:center';
  vaultBtn.onmouseover = () => { vaultBtn.style.borderColor = 'var(--green)'; vaultBtn.style.boxShadow = '0 0 10px var(--green-dimmer)'; vaultBtn.style.background = 'rgba(57,255,20,0.06)'; };
  vaultBtn.onmouseout = () => { vaultBtn.style.borderColor = 'var(--green-dim)'; vaultBtn.style.boxShadow = ''; vaultBtn.style.background = 'transparent'; };
  vaultBtn.onclick = openVaultManager;
  right.appendChild(vaultBtn);

  const who = document.createElement('span');
  who.className = 'whoami';
  who.id = 'whoami';
  who.textContent = '…';
  right.appendChild(who);
  fetch('/api/whoami').then((r) => r.json()).then((d) => {
    who.textContent = d.user || 'anonymous';
    if (d.authenticated && d.name) who.title = d.name + (d.email ? ' <' + d.email + '>' : '');
    if (!d.authenticated) who.style.opacity = '0.6';
  }).catch(() => { who.textContent = '?'; });
}

function switchMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  const container = $('modeContainer');
  if (mode === 'extensions') {
    container.innerHTML = EXTENSIONS_LAYOUT;
    let searchTimer;
    $('q').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadRegistry(e.target.value), 250);
    });
    loadInstalled().then(() => loadRegistry(''));
  } else if (mode === 'workflows') {
    container.innerHTML = WORKFLOWS_LAYOUT;
    loadWorkflowList();
  } else if (mode === 'reports') {
    container.innerHTML = REPORTS_LAYOUT;
    loadReportList();
  }
}

async function loadWorkflowList() {
  const ul = $('workflowList');
  if (!ul) return;
  ul.innerHTML = '<li><p class="hint" style="padding:8px">Loading…</p></li>';
  try {
    const r = await fetch('/api/workflows');
    const d = await r.json();
    if (d.error) { ul.innerHTML = '<li><p class="err">' + escapeHtml(d.error.message) + '</p></li>'; return; }
    if (!d.workflows || d.workflows.length === 0) {
      ul.innerHTML = '<li><p class="hint" style="padding:8px">No workflows in this repo.</p></li>';
      return;
    }
    ul.innerHTML = '';
    for (const wf of d.workflows) {
      const li = document.createElement('li');
      li.innerHTML = '<div class="name">' + escapeHtml(wf.name) + '</div>' +
        (wf.description ? '<div class="meta">' + escapeHtml(wf.description) + '</div>' : '') +
        '<div class="meta">' + wf.jobCount + ' job' + (wf.jobCount === 1 ? '' : 's') + '</div>';
      li.onclick = () => selectWorkflow(wf.name, li);
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = '<li><p class="err">' + escapeHtml(String(e)) + '</p></li>';
  }
}

async function selectWorkflow(name, li) {
  document.querySelectorAll('#workflowList li').forEach((el) => el.classList.remove('active'));
  if (li) li.classList.add('active');
  const main = $('main');
  main.innerHTML = '<p class="hint">Loading workflow…</p>';
  try {
    const r = await fetch('/api/workflows/' + encodeURIComponent(name));
    const d = await r.json();
    if (d.error) { main.innerHTML = '<p class="err">' + escapeHtml(d.error.message) + '</p>'; return; }
    renderWorkflowPanel(d);
  } catch (e) {
    main.innerHTML = '<p class="err">' + escapeHtml(String(e)) + '</p>';
  }
}

function renderWorkflowPanel(wf) {
  const main = $('main');
  const parts = [];
  parts.push('<h2>' + escapeHtml(wf.name) + '</h2>');
  if (wf.description) parts.push('<p class="hint">' + escapeHtml(wf.description) + '</p>');
  parts.push('<h2>Run</h2>');
  parts.push('<form class="run-form" id="wfRunForm">');
  parts.push('<label>Inputs (JSON, optional)</label>');
  parts.push('<textarea name="inputs" rows="4" placeholder=\'{"key": "value"}\'></textarea>');
  parts.push('<button type="submit">Run workflow</button>');
  parts.push(' <span id="wfInputsStatus" class="hint"></span>');
  parts.push('</form>');
  parts.push('<div class="log" id="wfLog" style="display:none"></div>');
  parts.push('<h2>History</h2>');
  parts.push('<div id="wfHistory"><p class="hint">Loading…</p></div>');
  main.innerHTML = parts.join('');
  $('wfRunForm').onsubmit = (e) => {
    e.preventDefault();
    const raw = new FormData(e.target).get('inputs');
    const status = $('wfInputsStatus');
    if (status) status.innerHTML = '';
    let inputs = {};
    if (raw) {
      try { inputs = JSON.parse(raw); }
      catch {
        if (status) status.innerHTML = '<span class="err">Inputs must be valid JSON</span>';
        return;
      }
    }
    runWorkflow(wf.name, inputs);
  };
  loadWorkflowHistory(wf.name);
}

async function loadWorkflowHistory(wfName) {
  const el = $('wfHistory');
  if (!el) return;
  try {
    const r = await fetch('/api/workflows/' + encodeURIComponent(wfName) + '/history');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<p class="err">' + escapeHtml(d.error.message) + '</p>'; return; }
    if (!d.runs || d.runs.length === 0) { el.innerHTML = '<p class="hint">No historical runs.</p>'; return; }

    const table = document.createElement('table');
    table.className = 'history';
    table.innerHTML = '<thead><tr><th style="width:18px"></th><th>Status</th><th>Started</th><th>Duration</th><th>Jobs</th></tr></thead>';
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    for (const run of d.runs) {
      const row = document.createElement('tr');
      row.style.cursor = 'pointer';
      row.innerHTML =
        '<td class="hist-caret" style="color:var(--cyan)">▸</td>' +
        '<td class="status-' + escapeHtml(run.status) + '">' + escapeHtml(run.status) + '</td>' +
        '<td>' + escapeHtml(run.startedAt || '') + '</td>' +
        '<td>' + (run.durationMs != null ? formatDurationShort(run.durationMs) : '') + '</td>' +
        '<td>' + run.jobCount + '</td>';
      tbody.appendChild(row);

      const detail = document.createElement('tr');
      detail.style.display = 'none';
      const detailCell = document.createElement('td');
      detailCell.colSpan = 5;
      detailCell.style.cssText = 'padding:12px 16px;background:rgba(57,255,20,0.03);border-left:2px solid var(--green-dim)';
      detailCell.innerHTML = '<p class="hint">Loading run…</p>';
      detail.appendChild(detailCell);
      tbody.appendChild(detail);

      let loaded = false;
      row.onclick = async () => {
        const caret = row.querySelector('.hist-caret');
        if (detail.style.display === 'none') {
          detail.style.display = '';
          if (caret) caret.textContent = '▾';
          if (!loaded) {
            loaded = true;
            try {
              // Fetch the workflow definition to get dependsOn edges and the run itself for statuses.
              const [defRes, runRes] = await Promise.all([
                fetch('/api/workflows/' + encodeURIComponent(wfName)).then((r) => r.json()),
                fetch('/api/workflows/' + encodeURIComponent(wfName) + '/runs/' + encodeURIComponent(run.id)).then((r) => r.json()),
              ]);
              if (runRes.error) { detailCell.innerHTML = '<p class="err">' + escapeHtml(runRes.error.message) + '</p>'; return; }
              const historyRun = workflowRunToRunState(wfName, defRes, runRes);
              detailCell.innerHTML = '';
              renderTaskFollower(detailCell, historyRun);
            } catch (e) {
              detailCell.innerHTML = '<p class="err">' + escapeHtml(String(e)) + '</p>';
            }
          }
        } else {
          detail.style.display = 'none';
          if (caret) caret.textContent = '▸';
        }
      };
    }
    el.innerHTML = '';
    el.appendChild(table);
  } catch (e) {
    el.innerHTML = '<p class="err">' + escapeHtml(String(e)) + '</p>';
  }
}

function workflowRunToRunState(wfName, def, run) {
  // Build a lookup for per-step dependsOn and per-job dependsOn from the definition.
  const defJobs = (def && def.jobs) || [];
  const defJobByName = new Map(defJobs.map((j) => [j.name, j]));
  const jobs = (run.jobs || []).map((jr) => {
    const defJob = defJobByName.get(jr.name);
    const defSteps = (defJob && defJob.steps) || [];
    const defStepByName = new Map(defSteps.map((s) => [s.name, s]));
    return {
      id: jr.name,
      name: jr.name,
      status: jr.status,
      dependsOn: (defJob && defJob.dependsOn) || [],
      steps: (jr.steps || []).map((sr) => {
        const defStep = defStepByName.get(sr.name);
        return {
          id: sr.name,
          name: sr.name,
          status: sr.status,
          dependsOn: (defStep && defStep.dependsOn) || [],
          output: [],
          error: sr.error || null,
          durationMs: sr.durationMs,
          reports: [],
          dataArtifacts: (sr.dataArtifacts || []).map((a) => ({
            name: a.name || a.dataId || '(artifact)',
            attributes: a.attributes,
            preview: a.preview,
          })),
          startedAt: null,
        };
      }),
      startedAt: null,
      durationMs: jr.durationMs,
    };
  });
  return {
    kind: 'workflow',
    label: wfName,
    status: run.status,
    startedAt: run.startedAt ? new Date(run.startedAt).getTime() : null,
    durationMs: run.durationMs,
    trigger: '(history)',
    jobs,
    selectedJob: jobs[0] ? jobs[0].id : null,
    selectedStep: null,
    reports: [],
    error: null,
  };
}

async function runWorkflow(name, inputs) {
  const container = $('wfLog');
  if (!container) return;
  container.style.display = 'none';
  let follower = document.getElementById('wfFollower');
  if (!follower) {
    follower = document.createElement('div');
    follower.id = 'wfFollower';
    container.parentNode.insertBefore(follower, container.nextSibling);
  }
  follower.innerHTML = '';

  const run = {
    kind: 'workflow',
    label: name,
    status: 'running',
    startedAt: Date.now(),
    trigger: Object.keys(inputs).length > 0 ? Object.entries(inputs).map(([k,v]) => k + '=' + JSON.stringify(v)).join(' ') : '(no inputs)',
    jobs: [],
    selectedJob: null,
    selectedStep: null,
    error: null,
  };

  // Pre-seed the run state with the workflow definition so the DAG renders
  // with all nodes and dependency edges before streaming starts.
  try {
    const defRes = await fetch('/api/workflows/' + encodeURIComponent(name));
    const def = await defRes.json();
    if (!def.error && Array.isArray(def.jobs)) {
      for (const j of def.jobs) {
        const job = {
          id: j.name,
          name: j.name,
          status: 'pending',
          dependsOn: j.dependsOn || [],
          steps: (j.steps || []).map((s) => ({
            id: s.name,
            name: s.name,
            status: 'pending',
            dependsOn: s.dependsOn || [],
            output: [],
            error: null,
            durationMs: null,
            reports: [],
            dataArtifacts: [],
            startedAt: null,
          })),
          startedAt: null,
          durationMs: null,
        };
        run.jobs.push(job);
      }
      if (run.jobs.length > 0) run.selectedJob = run.jobs[0].id;
    }
  } catch { /* fall back to event-driven state */ }

  renderTaskFollower(follower, run);

  const resp = await fetch('/api/workflows/' + encodeURIComponent(name) + '/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs }),
  });
  await consumeTaskStream(resp, (evt) => applyWorkflowEvent(run, evt, follower));
  if (run.status === 'running') run.status = 'succeeded';
  renderTaskFollower(follower, run);
}

function applyWorkflowEvent(run, evt, container) {
  const upsertJob = (id) => {
    let job = run.jobs.find((j) => j.id === id);
    if (!job) {
      job = { id, name: id, status: 'pending', dependsOn: [], steps: [], startedAt: null, durationMs: null };
      run.jobs.push(job);
      if (!run.selectedJob) run.selectedJob = id;
    }
    return job;
  };
  const upsertStep = (job, id) => {
    let step = job.steps.find((s) => s.id === id);
    if (!step) {
      step = { id, name: id, status: 'pending', dependsOn: [], output: [], error: null, durationMs: null, reports: [], dataArtifacts: [], startedAt: null };
      job.steps.push(step);
    }
    return step;
  };

  switch (evt.kind) {
    case 'started':
      run.runId = evt.runId;
      run.executor = evt.driver;
      for (const j of evt.jobs || []) {
        upsertJob(j.id || j.name);
      }
      break;
    case 'job_started': {
      const job = upsertJob(evt.jobId);
      job.status = 'running';
      job.startedAt = Date.now();
      break;
    }
    case 'job_completed': {
      const job = upsertJob(evt.jobId);
      job.status = evt.status || 'succeeded';
      if (job.startedAt) job.durationMs = Date.now() - job.startedAt;
      break;
    }
    case 'job_skipped': {
      upsertJob(evt.jobId).status = 'skipped';
      break;
    }
    case 'step_started': {
      const step = upsertStep(upsertJob(evt.jobId), evt.stepId);
      step.status = 'running';
      step.startedAt = Date.now();
      break;
    }
    case 'step_completed': {
      const step = upsertStep(upsertJob(evt.jobId), evt.stepId);
      step.status = 'succeeded';
      if (step.startedAt) step.durationMs = Date.now() - step.startedAt;
      break;
    }
    case 'step_failed': {
      const step = upsertStep(upsertJob(evt.jobId), evt.stepId);
      step.status = 'failed';
      step.error = evt.error;
      if (step.startedAt) step.durationMs = Date.now() - step.startedAt;
      break;
    }
    case 'step_skipped': {
      upsertStep(upsertJob(evt.jobId), evt.stepId).status = 'skipped';
      break;
    }
    case 'method_output': {
      const step = upsertStep(upsertJob(evt.jobId), evt.stepId);
      step.output.push({ stream: evt.stream, line: evt.line });
      break;
    }
    case 'report_completed': {
      const target = evt.stepId
        ? upsertStep(upsertJob(evt.jobId), evt.stepId)
        : run;
      target.reports = target.reports || [];
      target.reports.push({ name: evt.reportName, scope: evt.scope, markdown: evt.markdown, json: evt.json });
      break;
    }
    case 'report_failed': {
      const target = evt.stepId
        ? upsertStep(upsertJob(evt.jobId), evt.stepId)
        : run;
      target.reports = target.reports || [];
      target.reports.push({ name: evt.reportName, scope: evt.scope, error: evt.error });
      break;
    }
    case 'completed':
      run.status = evt.run && evt.run.status ? evt.run.status : 'succeeded';
      run.durationMs = Date.now() - run.startedAt;
      break;
    case 'error':
      run.status = 'failed';
      run.error = (evt.error && evt.error.message) || String(evt.error);
      run.durationMs = Date.now() - run.startedAt;
      break;
  }
  renderTaskFollower(container, run);
}

async function consumeTaskStream(resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() || '';
    for (const frame of frames) {
      const line = frame.replace(/^data: /, '');
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        onEvent(evt);
      } catch { /* ignore */ }
    }
  }
}

// ── DAG layout (ported from swamp-club AdminMonitor) ─────────────────────────
const DAG = {
  NODE_W: 180,
  NODE_H: 38,
  COL_GAP: 70,
  ROW_GAP: 14,
  PAD_X: 20,
  PAD_Y: 18,
};

function layoutDag(nodes, depsOf) {
  // nodes: [{ name, status, ... }]
  // depsOf(node) -> array of upstream node names
  if (nodes.length === 0) return [];
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const inDeg = new Map();
  const edges = new Map();
  for (const n of nodes) { inDeg.set(n.name, 0); edges.set(n.name, []); }
  for (const n of nodes) {
    for (const dep of depsOf(n) || []) {
      if (byName.has(dep)) {
        inDeg.set(n.name, (inDeg.get(n.name) || 0) + 1);
        edges.get(dep).push(n.name);
      }
    }
  }
  const columns = [];
  let queue = nodes.filter((n) => (inDeg.get(n.name) || 0) === 0).map((n) => n.name);
  while (queue.length > 0) {
    columns.push(queue);
    const next = [];
    for (const name of queue) {
      for (const child of edges.get(name) || []) {
        const deg = (inDeg.get(child) || 1) - 1;
        inDeg.set(child, deg);
        if (deg === 0) next.push(child);
      }
    }
    queue = next;
  }
  const out = [];
  for (let col = 0; col < columns.length; col++) {
    for (let row = 0; row < columns[col].length; row++) {
      out.push({ node: byName.get(columns[col][row]), column: col, row });
    }
  }
  return out;
}

function buildDagEdges(layout, depsOf) {
  const posMap = new Map();
  for (const n of layout) posMap.set(n.node.name, { col: n.column, row: n.row });
  const nodeX = (col) => DAG.PAD_X + col * (DAG.NODE_W + DAG.COL_GAP);
  const nodeY = (row) => DAG.PAD_Y + row * (DAG.NODE_H + DAG.ROW_GAP);
  const nodeCY = (row) => nodeY(row) + DAG.NODE_H / 2;
  const gapEdges = new Map();
  for (const n of layout) {
    for (const dep of depsOf(n.node) || []) {
      const from = posMap.get(dep);
      if (!from) continue;
      const key = from.col + '-' + n.column;
      if (!gapEdges.has(key)) gapEdges.set(key, []);
      gapEdges.get(key).push({
        from: dep,
        to: n.node.name,
        y1: nodeCY(from.row),
        y2: nodeCY(n.row),
        fromCol: from.col,
        toCol: n.column,
        failed: n.node.status === 'failed',
      });
    }
  }
  const paths = [];
  for (const [, es] of gapEdges) {
    const count = es.length;
    const spacing = 6;
    const totalW = (count - 1) * spacing;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      const x1 = nodeX(e.fromCol) + DAG.NODE_W;
      const x2 = nodeX(e.toCol);
      const midX = Math.round((x1 + x2) / 2 - totalW / 2 + i * spacing);
      paths.push({
        d: 'M' + x1 + ',' + e.y1 + ' H' + midX + ' V' + e.y2 + ' H' + x2,
        from: e.from,
        to: e.to,
        failed: e.failed,
      });
    }
  }
  return paths;
}

function computeDagSize(layout) {
  if (layout.length === 0) return { w: 100, h: 60 };
  let maxCol = 0, maxRow = 0;
  for (const n of layout) {
    if (n.column > maxCol) maxCol = n.column;
    if (n.row > maxRow) maxRow = n.row;
  }
  return {
    w: DAG.PAD_X * 2 + (maxCol + 1) * DAG.NODE_W + maxCol * DAG.COL_GAP,
    h: DAG.PAD_Y * 2 + (maxRow + 1) * DAG.NODE_H + maxRow * DAG.ROW_GAP,
  };
}

function statusNodeFill(status) {
  switch (status) {
    case 'succeeded': case 'completed': return '#0e3a1a';
    case 'failed': return '#3a0e0e';
    case 'running': return '#2a2a0e';
    default: return '#0a0a0a';
  }
}
function statusNodeStroke(status) {
  switch (status) {
    case 'succeeded': case 'completed': return '#39ff14';
    case 'failed': return '#ff4d4d';
    case 'running': return '#fbbf24';
    case 'skipped': return '#6b7280';
    default: return '#374151';
  }
}
function statusTag(status) {
  switch (status) {
    case 'succeeded': case 'completed': return 'OK';
    case 'failed': return 'ERR';
    case 'running': return 'RUN';
    case 'skipped': return 'SKIP';
    default: return '---';
  }
}

function centerDagNode(container, kind, nodeName) {
  if (!nodeName) return;
  // Find the matching graph container — job DAG is the first .dag-graph,
  // step DAG is the second. We re-locate the node via data-node attribute.
  const graphs = container.querySelectorAll('.dag-graph');
  const clickAttr = kind === 'job' ? 'data-job-click' : 'data-step-click';
  for (const g of graphs) {
    const node = g.querySelector('g[' + clickAttr + '][data-node="' + (window.CSS && window.CSS.escape ? CSS.escape(nodeName) : nodeName) + '"]');
    if (!node) continue;
    const scroller = g;
    const nodeRect = node.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const currentOffset = nodeRect.left - scrollerRect.left + scroller.scrollLeft;
    const target = currentOffset - (scroller.clientWidth - nodeRect.width) / 2;
    scroller.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
    // Also vertical centering for tall graphs.
    const currentTop = nodeRect.top - scrollerRect.top + scroller.scrollTop;
    const targetTop = currentTop - (scroller.clientHeight - nodeRect.height) / 2;
    if (scroller.scrollHeight > scroller.clientHeight) {
      scroller.scrollTo({ top: Math.max(0, targetTop), left: Math.max(0, target), behavior: 'smooth' });
    }
    return;
  }
}

function renderDagSvg(nodes, depsOf, selectedName, onSelectAttr) {
  const layout = layoutDag(nodes, depsOf);
  if (layout.length === 0) return '';
  const { w, h } = computeDagSize(layout);
  const edges = buildDagEdges(layout, depsOf);
  const nodeX = (col) => DAG.PAD_X + col * (DAG.NODE_W + DAG.COL_GAP);
  const nodeY = (row) => DAG.PAD_Y + row * (DAG.NODE_H + DAG.ROW_GAP);
  const parts = [];
  parts.push('<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">');

  // Edges — dim pass then hot pass if selection
  const hasSel = !!selectedName;
  for (const e of edges) {
    const hot = hasSel && (e.from === selectedName || e.to === selectedName);
    if (hot) continue;
    parts.push('<path d="' + e.d + '" stroke="' + (e.failed ? '#f87171' : '#6b7280') + '" stroke-width="1" stroke-opacity="' + (hasSel ? 0.4 : 0.8) + '" fill="none" stroke-dasharray="6 3"/>');
  }
  for (const e of edges) {
    const hot = hasSel && (e.from === selectedName || e.to === selectedName);
    if (!hot) continue;
    parts.push('<path d="' + e.d + '" stroke="' + (e.failed ? '#ef4444' : '#39ff14') + '" stroke-width="' + (e.failed ? 2.5 : 2) + '" fill="none"/>');
  }

  // Nodes
  for (const n of layout) {
    const x = nodeX(n.column);
    const y = nodeY(n.row);
    const status = n.node.status || 'pending';
    const isSel = n.node.name === selectedName;
    const fill = statusNodeFill(status);
    const stroke = statusNodeStroke(status);
    // Label area: from x+42 (after status pill) to roughly x+NODE_W-55 (before duration).
    // At 11px mono with ~6.5px/char, that's ~13 chars when a duration is present, 18 without.
    const hasDur = n.node.durationMs != null;
    const maxChars = hasDur ? 13 : 18;
    const label = n.node.name.length > maxChars ? n.node.name.slice(0, maxChars - 1) + '…' : n.node.name;
    parts.push('<g data-node="' + escapeHtml(n.node.name) + '" ' + onSelectAttr + '><title>' + escapeHtml(n.node.name) + '</title>');
    // Selection brackets
    if (isSel) {
      const C = 7;
      parts.push('<path d="M' + (x - 5) + ',' + (y - 5 + C) + ' V' + (y - 5) + ' H' + (x - 5 + C) + '" stroke="' + stroke + '" stroke-width="2" fill="none"/>');
      parts.push('<path d="M' + (x + DAG.NODE_W + 5 - C) + ',' + (y - 5) + ' H' + (x + DAG.NODE_W + 5) + ' V' + (y - 5 + C) + '" stroke="' + stroke + '" stroke-width="2" fill="none"/>');
      parts.push('<path d="M' + (x - 5) + ',' + (y + DAG.NODE_H + 5 - C) + ' V' + (y + DAG.NODE_H + 5) + ' H' + (x - 5 + C) + '" stroke="' + stroke + '" stroke-width="2" fill="none"/>');
      parts.push('<path d="M' + (x + DAG.NODE_W + 5 - C) + ',' + (y + DAG.NODE_H + 5) + ' H' + (x + DAG.NODE_W + 5) + ' V' + (y + DAG.NODE_H + 5 - C) + '" stroke="' + stroke + '" stroke-width="2" fill="none"/>');
    }
    parts.push('<rect class="dag-node-bg" x="' + x + '" y="' + y + '" width="' + DAG.NODE_W + '" height="' + DAG.NODE_H + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"/>');
    // Status tag pill
    const tag = statusTag(status);
    parts.push('<rect x="' + (x + 8) + '" y="' + (y + DAG.NODE_H / 2 - 8) + '" width="28" height="16" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1"/>');
    parts.push('<text class="dag-node-tag" x="' + (x + 22) + '" y="' + (y + DAG.NODE_H / 2 + 3) + '" text-anchor="middle" fill="' + stroke + '">' + tag + '</text>');
    // Label
    parts.push('<text class="dag-node-label" x="' + (x + 42) + '" y="' + (y + DAG.NODE_H / 2 + 3) + '">' + escapeHtml(label) + '</text>');
    // Duration tail
    if (n.node.durationMs != null) {
      const durStr = formatDurationShort(n.node.durationMs);
      parts.push('<text class="dag-node-label" x="' + (x + DAG.NODE_W - 8) + '" y="' + (y + DAG.NODE_H / 2 + 3) + '" text-anchor="end" fill="#9ca3af" font-size="10">' + escapeHtml(durStr) + '</text>');
    }
    parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('');
}

function formatDurationShort(ms) {
  if (ms == null) return '';
  if (ms < 1000) return ms + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return m + 'm ' + rem + 's';
}

function renderTaskFollower(container, run) {
  // Preserve which step-bodies were open so live updates don't collapse them.
  const expanded = new Set();
  container.querySelectorAll('.step-row[data-open="1"]').forEach((el) => {
    expanded.add(el.dataset.jobid + '::' + el.dataset.stepid);
  });
  // Preserve DAG scroll positions across re-renders so live updates don't
  // jerk the viewport back to the origin.
  const scrollState = [];
  container.querySelectorAll('.dag-graph').forEach((g) => {
    scrollState.push({ left: g.scrollLeft, top: g.scrollTop });
  });

  const parts = [];
  parts.push('<div class="task-follower">');
  // Meta strip
  parts.push('<div class="task-meta">');
  parts.push('<div><span class="k">' + (run.kind === 'workflow' ? 'workflow' : 'method') + ':</span><span class="v">' + escapeHtml(run.label) + '</span></div>');
  parts.push('<div><span class="k">status:</span><span class="v status-' + escapeHtml(run.status) + '">' + escapeHtml(run.status) + '</span></div>');
  if (run.executor) parts.push('<div><span class="k">executor:</span><span class="v">' + escapeHtml(run.executor) + '</span></div>');
  if (run.durationMs != null) parts.push('<div><span class="k">duration:</span><span class="v">' + escapeHtml(formatDurationShort(run.durationMs)) + '</span></div>');
  if (run.trigger) parts.push('<div><span class="k">inputs:</span><span class="v">' + escapeHtml(run.trigger) + '</span></div>');
  parts.push('</div>');

  // Job DAG
  if (run.jobs.length === 0) {
    parts.push('<div class="dag-graph"><p class="hint" style="padding:12px 16px">Waiting for first job…</p></div>');
  } else {
    // Build DAG nodes for jobs using id as name.
    const jobNodes = run.jobs.map((j) => ({
      name: j.id,
      displayName: j.name,
      status: j.status,
      durationMs: j.durationMs,
    }));
    const jobDepsOf = (n) => {
      const job = run.jobs.find((j) => j.id === n.name);
      return job ? (job.dependsOn || []) : [];
    };
    const svg = renderDagSvg(jobNodes, jobDepsOf, run.selectedJob, 'data-job-click="1"');
    parts.push('<div class="dag-graph">' + svg + '</div>');
  }

  // Job detail — selected job's steps as DAG
  const selected = run.jobs.find((j) => j.id === run.selectedJob);
  if (selected && selected.steps.length > 0) {
    const stepNodes = selected.steps.map((s) => ({
      name: s.id,
      status: s.status,
      durationMs: s.durationMs,
    }));
    const stepDepsOf = (n) => {
      const step = selected.steps.find((s) => s.id === n.name);
      return step ? (step.dependsOn || []) : [];
    };
    const svg = renderDagSvg(stepNodes, stepDepsOf, run.selectedStep, 'data-step-click="1"');
    parts.push('<div class="dag-graph" style="border-top:1px solid var(--green-dim)">' + svg + '</div>');
  }

  parts.push('<div class="job-detail">');
  if (!selected) {
    parts.push('<p class="hint">No job selected.</p>');
  } else {
    for (const step of selected.steps) {
      const key = selected.id + '::' + step.id;
      const isOpen = expanded.has(key) || step.status === 'failed';
      parts.push('<div class="step-row" data-jobid="' + escapeHtml(selected.id) + '" data-stepid="' + escapeHtml(step.id) + '" data-open="' + (isOpen ? '1' : '0') + '">');
      parts.push('<div class="step-header">');
      parts.push('<span class="status-dot ' + escapeHtml(step.status) + '"></span>');
      parts.push('<span class="step-caret">' + (isOpen ? '▾' : '▸') + '</span>');
      parts.push('<span class="step-name">' + escapeHtml(step.name) + '</span>');
      parts.push('<span class="step-badges">');
      if (step.dataArtifacts && step.dataArtifacts.length > 0) parts.push('<span class="step-badge" title="artifacts">●</span>');
      if (step.reports && step.reports.length > 0) parts.push('<span class="step-badge" title="reports" style="color:#a78bfa">◆</span>');
      parts.push('</span>');
      if (step.durationMs != null) parts.push('<span class="step-dur">' + escapeHtml(formatDurationShort(step.durationMs)) + '</span>');
      parts.push('</div>');
      if (isOpen) {
        parts.push('<div class="step-body">');
        if (step.error) {
          parts.push('<div class="sub-heading">Error</div>');
          parts.push('<div class="step-error">' + escapeHtml(step.error) + '</div>');
        }
        if (step.output && step.output.length > 0) {
          parts.push('<div class="sub-heading">Output</div>');
          parts.push('<div class="step-log">');
          for (const o of step.output) {
            const cls = o.stream === 'stderr' ? ' class="err-line"' : '';
            parts.push('<span' + cls + '>' + escapeHtml(o.line) + '</span>\n');
          }
          parts.push('</div>');
        }
        if (step.dataArtifacts && step.dataArtifacts.length > 0) {
          parts.push('<div class="sub-heading">Data artifacts</div>');
          for (const a of step.dataArtifacts) {
            parts.push('<div class="step-artifact"><div class="step-artifact-name">' + escapeHtml(a.name) + '</div>');
            if (a.attributes !== undefined) parts.push('<pre>' + escapeHtml(JSON.stringify(a.attributes, null, 2)) + '</pre>');
            else if (a.preview) parts.push('<pre>' + escapeHtml(a.preview) + '</pre>');
            parts.push('</div>');
          }
        }
        if (step.reports && step.reports.length > 0) {
          parts.push('<div class="sub-heading">Reports</div>');
          for (const r of step.reports) {
            parts.push('<div class="step-report"><div class="step-report-name">' + escapeHtml(r.name) + ' <span class="hint" style="font-size:10px">(' + escapeHtml(r.scope || '') + ')</span></div>');
            if (r.error) parts.push('<div class="step-error" style="margin-top:6px">' + escapeHtml(r.error) + '</div>');
            else if (r.markdown) parts.push('<pre>' + escapeHtml(r.markdown) + '</pre>');
            parts.push('</div>');
          }
        }
        parts.push('</div>');
      }
      parts.push('</div>');
    }
    if (selected.steps.length === 0) {
      parts.push('<p class="hint">Waiting for first step…</p>');
    }
  }
  parts.push('</div>');

  if (run.reports && run.reports.length > 0) {
    parts.push('<div class="job-detail" style="border-top:0;margin-top:0">');
    parts.push('<div class="sub-heading">Run reports</div>');
    for (const r of run.reports) {
      parts.push('<div class="step-report"><div class="step-report-name">' + escapeHtml(r.name) + ' <span class="hint" style="font-size:10px">(' + escapeHtml(r.scope || '') + ')</span></div>');
      if (r.error) parts.push('<div class="step-error" style="margin-top:6px">' + escapeHtml(r.error) + '</div>');
      else if (r.markdown) parts.push('<pre>' + escapeHtml(r.markdown) + '</pre>');
      parts.push('</div>');
    }
    parts.push('</div>');
  }

  if (run.error) {
    parts.push('<div class="step-error" style="margin-top:8px">' + escapeHtml(run.error) + '</div>');
  }

  parts.push('</div>');
  container.innerHTML = parts.join('');

  // Restore DAG scroll positions by index (job graph, then step graph).
  const freshGraphs = container.querySelectorAll('.dag-graph');
  freshGraphs.forEach((g, i) => {
    const prev = scrollState[i];
    if (!prev) return;
    g.scrollLeft = prev.left;
    g.scrollTop = prev.top;
  });

  // Wire up DAG node clicks
  container.querySelectorAll('g[data-job-click]').forEach((el) => {
    el.addEventListener('click', () => {
      run.selectedJob = el.getAttribute('data-node');
      run.selectedStep = null;
      renderTaskFollower(container, run);
      centerDagNode(container, 'job', run.selectedJob);
    });
  });
  container.querySelectorAll('g[data-step-click]').forEach((el) => {
    el.addEventListener('click', () => {
      const name = el.getAttribute('data-node');
      run.selectedStep = run.selectedStep === name ? null : name;
      const row = container.querySelector('.step-row[data-stepid="' + (window.CSS && window.CSS.escape ? CSS.escape(name) : name) + '"]');
      if (row) row.dataset.open = '1';
      renderTaskFollower(container, run);
      if (run.selectedStep) centerDagNode(container, 'step', name);
    });
  });
  container.querySelectorAll('.step-row').forEach((el) => {
    const header = el.querySelector('.step-header');
    if (!header) return;
    header.onclick = () => {
      const open = el.dataset.open === '1';
      el.dataset.open = open ? '0' : '1';
      // Re-render to regenerate the body.
      renderTaskFollower(container, run);
    };
  });
}

async function loadReportList() {
  const ul = $('reportList');
  if (!ul) return;
  ul.innerHTML = '<li><p class="hint" style="padding:8px">Loading…</p></li>';
  try {
    const r = await fetch('/api/reports');
    const d = await r.json();
    if (d.error) { ul.innerHTML = '<li><p class="err">' + escapeHtml(d.error.message) + '</p></li>'; return; }
    if (!d.reports || d.reports.length === 0) {
      ul.innerHTML = '<li><p class="hint" style="padding:8px">No reports registered.</p></li>';
      return;
    }
    ul.innerHTML = '';
    for (const rep of d.reports) {
      const li = document.createElement('li');
      li.innerHTML = '<div class="name">' + escapeHtml(rep.name) + '</div>' +
        '<div class="meta">scope: ' + escapeHtml(rep.scope || '') + '</div>';
      li.onclick = () => selectReport(rep, li);
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = '<li><p class="err">' + escapeHtml(String(e)) + '</p></li>';
  }
}

function selectReport(rep, li) {
  document.querySelectorAll('#reportList li').forEach((el) => el.classList.remove('active'));
  if (li) li.classList.add('active');
  const main = $('main');
  const parts = [];
  parts.push('<h2>' + escapeHtml(rep.name) + '</h2>');
  parts.push('<div class="panel">');
  if (rep.description) parts.push('<p>' + escapeHtml(rep.description) + '</p>');
  parts.push('<p class="hint"><strong style="color:var(--label)">Scope:</strong> ' + escapeHtml(rep.scope || '') + '</p>');
  if (rep.labels && rep.labels.length > 0) {
    parts.push('<p class="hint"><strong style="color:var(--label)">Labels:</strong> ' +
      rep.labels.map((l) => '<span class="badge">' + escapeHtml(l) + '</span>').join(' ') + '</p>');
  }
  parts.push('<p class="hint" style="margin-top:12px;border-top:1px solid var(--green-dim);padding-top:12px">Reports are not standalone-runnable — they execute automatically as part of a model method run or workflow run when configured. Run an instance of a compatible model from the Extensions tab, or trigger a workflow that references this report.</p>');
  parts.push('</div>');
  main.innerHTML = parts.join('');
}

function openVaultManager() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  const modal = document.createElement('div');
  modal.className = 'modal-panel';
  modal.style.width = '680px';
  modal.innerHTML =
    '<div class="modal-header">' +
      '<span class="num">//</span>' +
      '<span class="label">VAULTS</span>' +
      '<span class="line"></span>' +
    '</div>' +
    '<div id="vaultList"><p class="hint">Loading...</p></div>' +
    '<div class="modal-header" style="margin-top:20px">' +
      '<span class="num">//</span>' +
      '<span class="label">Create Vault</span>' +
      '<span class="line"></span>' +
    '</div>' +
    '<form id="vaultCreateForm" class="run-form" style="margin:0">' +
      '<label>Type</label>' +
      '<div id="vaultTypeCombo" class="combo"><button type="button" class="combo-btn" id="vaultTypeBtn"><span class="combo-label">Loading…</span><span class="combo-caret">▾</span></button><ul class="combo-menu" id="vaultTypeMenu"></ul></div>' +
      '<input type="hidden" name="type" id="vaultTypeValue">' +
      '<div id="vaultTypeDesc" class="hint" style="margin-top:4px;font-size:11px"></div>' +
      '<label>Name</label>' +
      '<input name="name" required placeholder="my-secrets">' +
      '<div id="vaultConfigFields"></div>' +
      '<button type="submit">&gt; Create Vault</button>' +
      ' <span id="vaultCreateStatus" class="hint"></span>' +
    '</form>' +
    '<div class="modal-header" style="margin-top:20px">' +
      '<span class="num">//</span>' +
      '<span class="label">Install Vault Provider</span>' +
      '<span class="line"></span>' +
    '</div>' +
    '<p class="hint" style="margin:0 0 8px;font-size:11px">Install additional vault providers from the extension registry.</p>' +
    '<input id="vaultRegistrySearch" placeholder="> search providers…" style="margin-bottom:8px">' +
    '<div id="vaultRegistryList"><p class="hint">Loading registry…</p></div>' +
    '<div style="text-align:right;margin-top:18px">' +
      '<button id="vaultCloseBtn" class="modal-close-btn">Close</button>' +
    '</div>';
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  $('vaultCloseBtn').onclick = () => overlay.remove();
  renderVaultList();
  loadVaultTypes();
  loadVaultRegistry();
  $('vaultCreateForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = fd.get('name');
    const type = fd.get('type') || 'local_encryption';
    const config = {};
    for (const [k, v] of fd.entries()) {
      if (!k.startsWith('cfg.')) continue;
      if (v === '') continue;
      const key = k.slice(4);
      try { config[key] = JSON.parse(v); } catch { config[key] = v; }
    }
    $('vaultCreateStatus').textContent = 'Creating...';
    try {
      const r = await fetch('/api/vaults', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, type, config: Object.keys(config).length > 0 ? config : undefined }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      $('vaultCreateStatus').innerHTML = '<span class="ok">Created</span>';
      e.target.reset();
      await refreshVaults();
      renderVaultList();
      loadVaultTypes();
    } catch (err) {
      $('vaultCreateStatus').innerHTML = '<span class="err" style="white-space:pre-wrap;word-break:break-word">' + escapeHtml(String(err.message || err)) + '</span>';
    }
  };
}

async function renderVaultConfigFields(type) {
  const wrap = $('vaultConfigFields');
  if (!wrap) return;
  wrap.innerHTML = '';
  try {
    const r = await fetch('/api/vault-types/' + encodeURIComponent(type) + '/schema');
    const d = await r.json();
    if (d.error || !d.configSchema) return;
    const schema = d.configSchema;
    const props = (schema && schema.properties) || {};
    const required = new Set((schema && schema.required) || []);
    if (Object.keys(props).length === 0) return;
    const parts = ['<div class="sub-heading" style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);margin:12px 0 4px">Config</div>'];
    for (const [key, propSchema] of Object.entries(props)) {
      const req = required.has(key) ? ' *' : '';
      const desc = propSchema.description ? ' <span class="hint">' + escapeHtml(propSchema.description) + '</span>' : '';
      parts.push('<label>' + escapeHtml(key) + req + ' <span class="hint">(' + escapeHtml(propSchema.type || 'any') + ')</span>' + desc + '</label>');
      if (propSchema.enum) {
        parts.push('<select name="cfg.' + escapeHtml(key) + '">');
        for (const v of propSchema.enum) parts.push('<option value="' + escapeHtml(String(v)) + '">' + escapeHtml(String(v)) + '</option>');
        parts.push('</select>');
      } else if (propSchema.type === 'boolean') {
        parts.push('<select name="cfg.' + escapeHtml(key) + '"><option value="">-</option><option value="true">true</option><option value="false">false</option></select>');
      } else if (propSchema.type === 'object' || propSchema.type === 'array') {
        parts.push('<textarea name="cfg.' + escapeHtml(key) + '" rows="3" placeholder="JSON"></textarea>');
      } else {
        const ipt = propSchema.type === 'number' || propSchema.type === 'integer' ? 'number' : 'text';
        parts.push('<input name="cfg.' + escapeHtml(key) + '" type="' + ipt + '">');
      }
    }
    wrap.innerHTML = parts.join('');
  } catch { /* ignore */ }
}

async function loadVaultTypes() {
  const combo = $('vaultTypeCombo');
  const btn = $('vaultTypeBtn');
  const menu = $('vaultTypeMenu');
  const valueInput = $('vaultTypeValue');
  const desc = $('vaultTypeDesc');
  if (!combo || !btn || !menu || !valueInput) return;

  const labelEl = btn.querySelector('.combo-label');
  try {
    const r = await fetch('/api/vault-types');
    const d = await r.json();
    const types = d.types || [];
    if (types.length === 0) {
      labelEl.textContent = 'No vault types registered';
      menu.innerHTML = '';
      return;
    }
    menu.innerHTML = '';
    const select = (t) => {
      valueInput.value = t.type;
      labelEl.textContent = t.type.toUpperCase() + (t.isBuiltIn ? ' (BUILT-IN)' : '');
      if (desc) desc.textContent = t.description || '';
      menu.querySelectorAll('li').forEach((el) => el.classList.toggle('selected', el.dataset.value === t.type));
      combo.classList.remove('open');
      renderVaultConfigFields(t.type);
    };
    for (const t of types) {
      const li = document.createElement('li');
      li.dataset.value = t.type;
      li.innerHTML =
        '<div class="combo-item-name">' + escapeHtml(t.type) + (t.isBuiltIn ? ' <span class="combo-item-tag">built-in</span>' : '') + '</div>' +
        (t.description ? '<div class="combo-item-desc">' + escapeHtml(t.description) + '</div>' : '');
      li.onclick = () => select(t);
      menu.appendChild(li);
    }
    select(types[0]);
    btn.onclick = (e) => {
      e.preventDefault();
      combo.classList.toggle('open');
      if (combo.classList.contains('open')) {
        const closeOnClickAway = (e2) => {
          if (!combo.contains(e2.target)) {
            combo.classList.remove('open');
            document.removeEventListener('click', closeOnClickAway);
          }
        };
        setTimeout(() => document.addEventListener('click', closeOnClickAway), 0);
      }
    };
  } catch (e) {
    if (labelEl) labelEl.textContent = 'Error loading types';
  }
}

let vaultRegistryCache = [];

async function loadVaultRegistry() {
  const el = $('vaultRegistryList');
  if (!el) return;
  try {
    const r = await fetch('/api/vault-types/registry');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<p class="err">' + escapeHtml(d.error.message) + '</p>'; return; }
    vaultRegistryCache = d.results || [];
    renderVaultRegistry('');
    const search = $('vaultRegistrySearch');
    if (search) {
      let timer;
      search.oninput = (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => renderVaultRegistry(e.target.value || ''), 150);
      };
    }
  } catch (e) {
    el.innerHTML = '<p class="err">' + escapeHtml(String(e)) + '</p>';
  }
}

function renderVaultRegistry(query) {
  const el = $('vaultRegistryList');
  if (!el) return;
  const q = (query || '').toLowerCase().trim();
  const filtered = q
    ? vaultRegistryCache.filter((e) => {
        const hay = (e.name + ' ' + (e.description || '')).toLowerCase();
        return hay.includes(q);
      })
    : vaultRegistryCache;
  if (filtered.length === 0) {
    el.innerHTML = '<p class="hint">' + (vaultRegistryCache.length === 0 ? 'No vault providers in registry.' : 'No matches.') + '</p>';
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'ext-list';
  ul.style.cssText = 'border:1px solid var(--green-dim);max-height:260px;overflow-y:auto';
  for (const ext of filtered) {
    const li = document.createElement('li');
    li.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px';
    const left = document.createElement('div');
    left.style.cssText = 'flex:1;min-width:0;overflow:hidden';
    const version = ext.latestVersion ? ' <span class="hint" style="font-size:10px;margin-left:6px">' + escapeHtml(ext.latestVersion) + '</span>' : '';
    left.innerHTML = '<div class="name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(ext.name) + version + '</div>';
    if (ext.description) {
      left.title = ext.description;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Install';
    btn.style.cssText = 'flex-shrink:0;padding:6px 14px;background:transparent;color:var(--green);border:1px solid var(--green-dim);cursor:pointer;font-family:var(--orbitron);font-size:10px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase';
    btn.onmouseover = () => { btn.style.borderColor = 'var(--green)'; btn.style.background = 'rgba(57,255,20,0.06)'; };
    btn.onmouseout = () => { btn.style.borderColor = 'var(--green-dim)'; btn.style.background = 'transparent'; };
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Installing…';
      // Remove any previous error row before retrying.
      const prevErr = li.nextElementSibling;
      if (prevErr && prevErr.classList && prevErr.classList.contains('install-error-row')) prevErr.remove();
      try {
        const r = await fetch('/api/extensions/install', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: ext.name }),
        });
        const rd = await r.json();
        if (rd.error) throw new Error(rd.error.message || JSON.stringify(rd.error));
        btn.textContent = 'Installed';
        btn.style.borderColor = 'var(--green)';
        await loadVaultTypes();
        await loadInstalled();
      } catch (e) {
        btn.textContent = 'Error';
        btn.disabled = false;
        btn.style.borderColor = 'var(--red)';
        btn.style.color = 'var(--red)';
        const msg = String((e && e.message) || e);
        btn.title = msg;
        // Inline expanded error under the row.
        const errRow = document.createElement('li');
        errRow.className = 'install-error-row';
        errRow.style.cssText = 'padding:6px 12px;background:rgba(255,77,77,0.06);border-top:1px solid rgba(255,77,77,0.25)';
        errRow.innerHTML = '<div class="err" style="font:11px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word">' + escapeHtml(msg) + '</div>';
        li.parentNode.insertBefore(errRow, li.nextSibling);
      }
    };
    li.appendChild(left);
    li.appendChild(btn);
    ul.appendChild(li);
  }
  el.innerHTML = '';
  el.appendChild(ul);
}

async function renderVaultList() {
  await refreshVaults();
  const el = $('vaultList');
  if (!el) return;
  if (vaultCache.length === 0) {
    el.innerHTML = '<p class="hint">No vaults yet.</p>';
    return;
  }
  const parts = [];
  for (const v of vaultCache) {
    parts.push('<details open class="vault-card">');
    parts.push('<summary><span class="vault-card-name">' + escapeHtml(v.name) + '</span> <span class="hint">(' + escapeHtml(v.type) + ')</span></summary>');
    if (v.keys && v.keys.length > 0) {
      parts.push('<ul class="vault-key-list">');
      for (const k of v.keys) parts.push('<li>' + escapeHtml(k) + '</li>');
      parts.push('</ul>');
    } else {
      parts.push('<p class="hint" style="margin:8px 0">No keys yet.</p>');
    }
    parts.push('<form data-vault="' + escapeHtml(v.name) + '" class="vault-put-form">');
    parts.push('<input name="key" placeholder="key">');
    parts.push('<input name="value" placeholder="value" type="password">');
    parts.push('<button type="submit">Add</button>');
    parts.push('</form>');
    parts.push('</details>');
  }
  el.innerHTML = parts.join('');
  el.querySelectorAll('.vault-put-form').forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault();
      const vaultName = f.dataset.vault;
      const fd = new FormData(f);
      // Clear any previous error row
      const card = f.closest('.vault-card');
      const prevErr = card && card.querySelector('.vault-put-error');
      if (prevErr) prevErr.remove();
      try {
        const r = await fetch('/api/vaults/' + encodeURIComponent(vaultName) + '/keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: fd.get('key'), value: fd.get('value'), overwrite: true }),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
        await refreshVaults();
        renderVaultList();
      } catch (err) {
        const errDiv = document.createElement('div');
        errDiv.className = 'vault-put-error';
        errDiv.style.cssText = 'margin-top:8px;padding:8px 10px;background:rgba(255,77,77,0.08);border:1px solid rgba(255,77,77,0.4);color:var(--red);font:11px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word';
        errDiv.textContent = String((err && err.message) || err);
        f.parentNode.insertBefore(errDiv, f.nextSibling);
      }
    };
  });
}

const VAULT_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="4" y="11" width="16" height="10"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

function vaultPickerFor(fieldName, inputEl) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.innerHTML = VAULT_ICON_SVG;
  btn.title = 'Insert from vault';
  btn.style.cssText = 'flex-shrink:0;padding:0;width:36px;min-width:36px;background:transparent;border:1px solid var(--green-dim);color:var(--green);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box';
  btn.onmouseover = () => { btn.style.borderColor = 'var(--green)'; btn.style.boxShadow = '0 0 8px var(--green-dimmer)'; };
  btn.onmouseout = () => { btn.style.borderColor = 'var(--green-dim)'; btn.style.boxShadow = ''; };
  btn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await refreshVaults();
    const existing = document.querySelector('.vault-popover');
    if (existing) existing.remove();
    const hasKeys = vaultCache.some((v) => v.keys && v.keys.length > 0);
    const pop = document.createElement('div');
    pop.className = 'vault-popover';
    pop.style.cssText = 'position:absolute;background:#000;border:1px solid var(--green-dim);padding:6px 0;z-index:50;min-width:280px;max-height:320px;overflow-y:auto;box-shadow:0 0 16px var(--green-dimmer)';
    const rect = btn.getBoundingClientRect();
    pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    pop.style.left = Math.max(8, rect.right + window.scrollX - 280) + 'px';
    if (!hasKeys) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:10px 14px;color:var(--muted);font-size:12px';
      empty.innerHTML = 'No vault keys yet.<br>Open <strong style="color:var(--green)">Vaults</strong> from the header to create a vault and add secrets.';
      pop.appendChild(empty);
      const openBtn = document.createElement('div');
      openBtn.textContent = '> Open Vaults manager';
      openBtn.style.cssText = 'padding:8px 14px;cursor:pointer;color:var(--green);font-family:var(--orbitron);font-size:11px;text-transform:uppercase;letter-spacing:0.1em;border-top:1px solid var(--green-dim);margin-top:4px';
      openBtn.onmouseover = () => openBtn.style.background = 'rgba(57,255,20,0.08)';
      openBtn.onmouseout = () => openBtn.style.background = '';
      openBtn.onclick = () => { pop.remove(); openVaultManager(); };
      pop.appendChild(openBtn);
    } else {
      for (const v of vaultCache) {
        if (!v.keys || v.keys.length === 0) continue;
        const header = document.createElement('div');
        header.textContent = v.name;
        header.style.cssText = 'padding:6px 14px;color:var(--label);font-family:var(--orbitron);font-size:10px;text-transform:uppercase;letter-spacing:0.1em;border-bottom:1px solid rgba(57,255,20,0.1)';
        pop.appendChild(header);
        for (const k of v.keys) {
          const item = document.createElement('div');
          item.textContent = k;
          item.style.cssText = 'padding:6px 18px;cursor:pointer;font:12px var(--mono);color:var(--green)';
          item.onmouseover = () => { item.style.background = 'rgba(57,255,20,0.08)'; };
          item.onmouseout = () => { item.style.background = ''; };
          item.onclick = () => {
            inputEl.value = '$' + '{{ vault.get("' + v.name + '", "' + k + '") }}';
            pop.remove();
          };
          pop.appendChild(item);
        }
      }
    }
    document.body.appendChild(pop);
    const closeOnClickAway = (e2) => {
      if (!pop.contains(e2.target) && e2.target !== btn) {
        pop.remove();
        document.removeEventListener('click', closeOnClickAway);
      }
    };
    setTimeout(() => document.addEventListener('click', closeOnClickAway), 0);
  };
  return btn;
}

function renderPicker(startPath) {
  setHeaderPath(null);
  // Only the whoami badge belongs in the picker header — no repo means no vaults.
  const right = $('headerRight');
  if (right) {
    right.innerHTML = '';
    const who = document.createElement('span');
    who.className = 'whoami';
    who.id = 'whoami';
    who.textContent = '…';
    right.appendChild(who);
    fetch('/api/whoami').then((r) => r.json()).then((d) => {
      who.textContent = d.user || 'anonymous';
      if (d.authenticated && d.name) who.title = d.name + (d.email ? ' <' + d.email + '>' : '');
      if (!d.authenticated) who.style.opacity = '0.6';
    }).catch(() => { who.textContent = '?'; });
  }
  $('app').innerHTML =
    '<div class="picker-wrap">' +
      '<h1 class="hero-title">SELECT SWAMP</h1>' +
      '<p class="hero-sub">Pick an existing swamp repository or initialize a new one.</p>' +

      '<div class="section-header">' +
        '<span class="num">01</span>' +
        '<span class="label">Existing Swamps</span>' +
        '<span class="verb">use</span>' +
        '<span class="line"></span>' +
      '</div>' +
      '<div class="panel" style="margin-bottom:28px">' +
        '<input id="swampSearch" placeholder="> search by path, name, tag, description…" style="margin-bottom:12px">' +
        '<div id="discoveredList"><p class="hint">Scanning filesystem…</p></div>' +
      '</div>' +

      '<div class="section-header">' +
        '<span class="num">02</span>' +
        '<span class="label">Create New Swamp</span>' +
        '<span class="verb">init</span>' +
        '<span class="line"></span>' +
      '</div>' +
      '<div class="panel">' +
        '<div id="cwd" style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:10px;word-break:break-all"></div>' +
        '<ul class="ext-list" id="fsList" style="max-height:360px;overflow-y:auto;border:1px solid var(--green-dim)"></ul>' +
        '<div id="pickerActions" style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"></div>' +
      '</div>' +
    '</div>';
  loadDiscoveredSwamps();
  loadFs(startPath || null);
}

let discoveredRepos = [];

async function loadDiscoveredSwamps() {
  const el = $('discoveredList');
  if (!el) return;
  try {
    const r = await fetch('/api/repo/discover');
    const d = await r.json();
    if (d.error || !d.repos || d.repos.length === 0) {
      discoveredRepos = [];
      el.innerHTML = '<p class="hint">No existing swamp repositories found under ' + escapeHtml(d.root || '') + '.</p>';
      return;
    }
    discoveredRepos = d.repos;
    renderDiscovered('');
    const search = $('swampSearch');
    if (search) {
      search.oninput = (e) => renderDiscovered(e.target.value);
    }
  } catch (e) {
    el.innerHTML = '<p class="err">' + escapeHtml(String(e)) + '</p>';
  }
}

function matchSwamp(repo, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  if (repo.path.toLowerCase().includes(q)) return true;
  const m = repo.meta || {};
  if (m.name && m.name.toLowerCase().includes(q)) return true;
  if (m.description && m.description.toLowerCase().includes(q)) return true;
  if (Array.isArray(m.tags) && m.tags.some((t) => t.toLowerCase().includes(q))) return true;
  return false;
}

function renderDiscovered(query) {
  const el = $('discoveredList');
  if (!el) return;
  const filtered = discoveredRepos.filter((r) => matchSwamp(r, query));
  if (filtered.length === 0) {
    el.innerHTML = '<p class="hint">No matches.</p>';
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'ext-list';
  ul.style.cssText = 'border:1px solid #222832;border-radius:4px;max-height:300px;overflow-y:auto';
  for (const repo of filtered) {
    const li = document.createElement('li');
    li.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:8px';
    const left = document.createElement('div');
    left.style.cssText = 'flex:1;min-width:0';
    const m = repo.meta || {};
    const title = m.name
      ? '<div class="name">' + escapeHtml(m.name) + '</div><div class="meta" style="font-family:ui-monospace,monospace;font-size:11px">' + escapeHtml(repo.path) + '</div>'
      : '<div class="name" style="font-family:ui-monospace,monospace;font-size:12px">' + escapeHtml(repo.path) + '</div>';
    let tagsHtml = '';
    if (Array.isArray(m.tags) && m.tags.length > 0) {
      tagsHtml = '<div style="margin-top:4px">' + m.tags.map((t) => '<span class="badge" style="margin-right:4px">' + escapeHtml(t) + '</span>').join('') + '</div>';
    }
    const descHtml = m.description ? '<div class="hint" style="margin-top:2px">' + escapeHtml(m.description) + '</div>' : '';
    left.innerHTML = title + tagsHtml + descHtml;
    left.onclick = () => useExisting(repo.path);
    left.style.cursor = 'pointer';
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎';
    editBtn.title = 'Edit metadata';
    editBtn.style.cssText = 'padding:4px 8px;background:#1a1f28;border:1px solid #2a3140;color:#e6e6e6;border-radius:4px;cursor:pointer;font-size:12px';
    editBtn.onclick = (e) => {
      e.stopPropagation();
      openMetaEditor(repo);
    };
    li.appendChild(left);
    li.appendChild(editBtn);
    ul.appendChild(li);
  }
  el.innerHTML = '';
  el.appendChild(ul);
}

function openMetaEditor(repo) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:100';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  const modal = document.createElement('div');
  modal.style.cssText = 'background:#161a21;border:1px solid #222832;border-radius:6px;padding:20px;width:480px;max-width:90vw';
  const m = repo.meta || {};
  modal.innerHTML =
    '<h2 style="margin-top:0;font-size:14px">Edit metadata</h2>' +
    '<p class="hint" style="font-family:ui-monospace,monospace;font-size:11px;margin-top:0;word-break:break-all">' + escapeHtml(repo.path) + '</p>' +
    '<form id="metaForm" class="run-form" style="margin:0">' +
      '<label>Name <input name="name" value="' + escapeHtml(m.name || '') + '" placeholder="e.g. Production aws"></label>' +
      '<label>Description <textarea name="description" rows="2" placeholder="What is this swamp for?">' + escapeHtml(m.description || '') + '</textarea></label>' +
      '<label>Tags (comma-separated) <input name="tags" value="' + escapeHtml((m.tags || []).join(', ')) + '" placeholder="prod, aws, team-a"></label>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
        '<button type="submit">Save</button>' +
        '<button type="button" id="metaCancel" style="padding:8px 16px;background:#1a1f28;border:1px solid #2a3140;color:#e6e6e6;border-radius:4px;cursor:pointer">Cancel</button>' +
        ' <span id="metaStatus" class="hint"></span>' +
      '</div>' +
    '</form>';
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  document.getElementById('metaCancel').onclick = () => overlay.remove();
  document.getElementById('metaForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const tags = String(fd.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean);
    document.getElementById('metaStatus').textContent = 'Saving...';
    try {
      const r = await fetch('/api/repo/meta', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: repo.path,
          name: fd.get('name'),
          description: fd.get('description'),
          tags,
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      repo.meta = d.meta;
      overlay.remove();
      renderDiscovered($('swampSearch') ? $('swampSearch').value : '');
    } catch (err) {
      document.getElementById('metaStatus').innerHTML = '<span class="err">' + escapeHtml(String(err.message || err)) + '</span>';
    }
  };
}

async function loadFs(path) {
  const q = path ? '?path=' + encodeURIComponent(path) : '';
  const r = await fetch('/api/fs/list' + q);
  const d = await r.json();
  if (d.error) {
    $('pickerActions').innerHTML = '<span class="err">' + escapeHtml(d.error.message) + '</span>';
    return;
  }
  $('cwd').textContent = d.path + (d.isSwamp ? '  (swamp repo)' : '');
  const ul = $('fsList');
  ul.innerHTML = '';
  if (d.parent) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="name">.. (parent)</div>';
    li.onclick = () => loadFs(d.parent);
    ul.appendChild(li);
  }
  for (const e of d.entries) {
    if (!e.isDir) continue;
    const li = document.createElement('li');
    if (e.isSwamp) {
      // Dim: these already have a swamp, so they aren't a target for "create new".
      li.innerHTML = '<div class="name" style="color:#555e70">' + escapeHtml(e.name) + '/ <span class="hint">(already a swamp)</span></div>';
      li.style.cursor = 'default';
      li.style.opacity = '0.55';
    } else {
      li.innerHTML = '<div class="name">' + escapeHtml(e.name) + '/</div>';
      li.onclick = () => loadFs(d.path + '/' + e.name);
    }
    ul.appendChild(li);
  }

  const actions = $('pickerActions');
  actions.innerHTML = '';
  if (d.isSwamp) {
    const msg = document.createElement('span');
    msg.className = 'hint';
    msg.textContent = 'This directory is already a swamp — use it from the "Existing swamps" list above.';
    actions.appendChild(msg);
  } else {
    const initBtn = document.createElement('button');
    initBtn.textContent = '> Initialize new swamp here';
    initBtn.style.cssText = 'padding:8px 18px;background:transparent;color:var(--green);border:1px solid var(--green);cursor:pointer;font-family:var(--orbitron);font-size:12px;font-weight:600;letter-spacing:0.15em;text-transform:uppercase';
    initBtn.onmouseover = () => { initBtn.style.boxShadow = '0 0 12px var(--green-dimmer)'; initBtn.style.background = 'rgba(57,255,20,0.08)'; };
    initBtn.onmouseout = () => { initBtn.style.boxShadow = ''; initBtn.style.background = 'transparent'; };
    initBtn.onclick = async () => {
      setPickerStatus('Initializing...');
      const r = await fetch('/api/repo/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: d.path }),
      });
      const result = await r.json();
      if (result.error) { setPickerStatus(result.error.message, true); return; }
      setPickerStatus('Initialized at ' + result.path);
      setHeaderPath(result.path);
      setTimeout(() => renderMainUi(), 400);
    };
    actions.appendChild(initBtn);
  }
  const statusSpan = document.createElement('span');
  statusSpan.id = 'pickerStatus';
  statusSpan.className = 'hint';
  actions.appendChild(statusSpan);
}

async function useExisting(path) {
  setPickerStatus('Loading repository...');
  const r = await fetch('/api/repo/use', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const d = await r.json();
  if (d.error) { setPickerStatus(d.error.message, true); return; }
  setPickerStatus('Loaded ' + d.path);
  setHeaderPath(d.path);
  setTimeout(() => renderMainUi(), 300);
}

function setPickerStatus(msg, isErr) {
  const el = $('pickerStatus');
  if (!el) return;
  el.innerHTML = isErr ? '<span class="err">' + escapeHtml(msg) + '</span>' : '<span class="ok">' + escapeHtml(msg) + '</span>';
}

async function loadInstalled() {
  const r = await fetch('/api/extensions/installed');
  const d = await r.json();
  installedNames = new Set(d.extensions.map(e => e.name));
  const ul = $('installed');
  ul.innerHTML = '';
  for (const e of d.extensions) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="name">' + escapeHtml(e.name) + '</div><div class="meta">' + escapeHtml(e.version) + '</div>';
    li.onclick = () => selectExtension(e.name, li, 'installed');
    ul.appendChild(li);
  }
}

async function loadRegistry(q) {
  const r = await fetch('/api/extensions/search?q=' + encodeURIComponent(q || ''));
  const d = await r.json();
  const ul = $('registry');
  ul.innerHTML = '';
  for (const e of d.results) {
    const li = document.createElement('li');
    const badge = installedNames.has(e.name) ? '<span class="badge">installed</span>' : '';
    const version = e.latestVersion ? escapeHtml(e.latestVersion) : '';
    const updated = e.updatedAt ? formatRelativeDate(e.updatedAt) : '';
    const meta = [version, updated].filter(Boolean).join(' · ');
    li.innerHTML = '<div class="name">' + escapeHtml(e.name) + badge + '</div>' +
      (meta ? '<div class="meta">' + escapeHtml(meta) + '</div>' : '');
    li.onclick = () => selectExtension(e.name, li, 'registry');
    ul.appendChild(li);
  }
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function renderArg(arg) {
  const req = arg.required ? ' <span class="arg-req">*</span>' : '';
  return '<li><span class="arg-name">' + escapeHtml(arg.name) + '</span>' + req +
    ' <span class="arg-type">' + escapeHtml(arg.type || '') + '</span>' +
    (arg.description ? ' <span class="hint">— ' + escapeHtml(arg.description) + '</span>' : '') +
    '</li>';
}

function renderProviderCard(p) {
  const parts = [];
  parts.push('<div class="panel ext-content-card">');
  parts.push('<div class="ext-content-title">' + escapeHtml(p.type || p.name) + '</div>');
  if (p.description) parts.push('<div class="hint">' + escapeHtml(p.description) + '</div>');
  if (Array.isArray(p.configFields) && p.configFields.length > 0) {
    parts.push('<div class="ext-detail-heading">Config</div>');
    parts.push('<ul class="ext-arg-list">');
    for (const f of p.configFields) parts.push(renderArg(f));
    parts.push('</ul>');
  }
  parts.push('</div>');
  return parts.join('');
}

function formatRelativeDate(iso) {
  try {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const diff = Date.now() - then;
    const day = 86400000;
    if (diff < day) return 'today';
    if (diff < 2 * day) return 'yesterday';
    if (diff < 30 * day) return Math.floor(diff / day) + 'd ago';
    if (diff < 365 * day) return Math.floor(diff / (30 * day)) + 'mo ago';
    return Math.floor(diff / (365 * day)) + 'y ago';
  } catch {
    return iso;
  }
}

async function selectExtension(name, li, list) {
  selected = name;
  document.querySelectorAll('.ext-list li').forEach(el => el.classList.remove('active'));
  li.classList.add('active');
  renderExtensionPanel(name);
}

async function renderExtensionPanel(name) {
  const main = $('main');
  const installed = installedNames.has(name);

  if (!installed) {
    main.innerHTML = '<h2>' + escapeHtml(name) + '</h2><p class="hint">Loading extension details…</p>';
    try {
      const r = await fetch('/api/extensions/' + encodeURIComponent(name));
      const info = await r.json();
      if (info.error) {
        main.innerHTML = '<h2>' + escapeHtml(name) + '</h2><p class="err">' + escapeHtml(info.error.message) + '</p>';
        return;
      }
      renderUninstalledExtension(name, info);
      return;
    } catch (e) {
      main.innerHTML = '<h2>' + escapeHtml(name) + '</h2><p class="err">' + escapeHtml(String(e)) + '</p>';
      return;
    }
  }

  const parts = [
    '<h2>' + escapeHtml(name) + '</h2>',
    '<div style="margin-bottom:16px">',
    '<span class="badge">installed</span>',
    '</div>',
  ];

  parts.push('<h2 id="typePickerHeader" style="display:none">Model type</h2>');
  parts.push('<div id="typePickerWrap"></div>');

  parts.push('<h2>Model instances</h2>');
  parts.push('<div id="defsList"><p class="hint">Loading...</p></div>');

  parts.push('<h2 id="createHeader">Create instance</h2>');
  parts.push('<div id="createFormWrap"><p class="hint">Loading schema...</p></div>');

  parts.push('<h2 id="methodsHeader" style="display:none">Run method</h2>');
  parts.push('<div id="methodArea"></div>');

  main.innerHTML = parts.join('');

  loadExtensionTypes(name);
}

function renderUninstalledExtension(name, info) {
  const main = $('main');
  const latest = info.latestVersion || '';
  const author = (info.author && (info.author.displayName || info.author.username)) || '';
  const homepage = info.repository || '';
  const contentTypes = Array.isArray(info.contentTypes) ? info.contentTypes : [];
  const labels = Array.isArray(info.labels) ? info.labels : [];
  const platforms = Array.isArray(info.platforms) ? info.platforms : [];
  const updatedAt = info.updatedAt ? formatRelativeDate(info.updatedAt) : '';
  const createdAt = info.createdAt ? formatRelativeDate(info.createdAt) : '';
  const detail = info.latestVersionDetail;

  const parts = [];
  parts.push('<h2 style="margin-bottom:4px">' + escapeHtml(name) + '</h2>');
  if (info.description) {
    parts.push('<p class="hint" style="margin-top:0;font-size:13px">' + escapeHtml(info.description) + '</p>');
  }

  // Meta strip
  parts.push('<div class="task-meta" style="border:1px solid var(--green-dim);margin:14px 0">');
  if (latest) parts.push('<div><span class="k">version:</span><span class="v">' + escapeHtml(latest) + '</span></div>');
  if (updatedAt) parts.push('<div><span class="k">updated:</span><span class="v">' + escapeHtml(updatedAt) + '</span></div>');
  if (createdAt) parts.push('<div><span class="k">created:</span><span class="v">' + escapeHtml(createdAt) + '</span></div>');
  if (author) parts.push('<div><span class="k">author:</span><span class="v">' + escapeHtml(author) + '</span></div>');
  if (detail && typeof detail.archiveSize === 'number') parts.push('<div><span class="k">size:</span><span class="v">' + escapeHtml(formatBytes(detail.archiveSize)) + '</span></div>');
  parts.push('</div>');

  parts.push('<div style="margin:16px 0">');
  parts.push('<button id="installBtn" style="padding:10px 22px;background:transparent;color:var(--green);border:1px solid var(--green);cursor:pointer;font-family:var(--orbitron);font-size:12px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;transition:all 0.15s" onmouseover="this.style.background=\'rgba(57,255,20,0.08)\';this.style.boxShadow=\'0 0 12px rgba(57,255,20,0.25)\'" onmouseout="this.style.background=\'transparent\';this.style.boxShadow=\'\'">&gt; Install Extension</button>');
  parts.push(' <span id="installStatus" class="hint"></span>');
  parts.push('</div>');

  if (contentTypes.length > 0 || labels.length > 0 || platforms.length > 0) {
    parts.push('<div class="panel">');
    if (contentTypes.length > 0) {
      parts.push('<div class="ext-detail-heading">Provides</div>');
      parts.push('<div class="ext-detail-badges">');
      for (const ct of contentTypes) parts.push('<span class="badge">' + escapeHtml(ct) + '</span>');
      parts.push('</div>');
    }
    if (labels.length > 0) {
      parts.push('<div class="ext-detail-heading">Labels</div>');
      parts.push('<div class="ext-detail-badges">');
      for (const l of labels) parts.push('<span class="badge">' + escapeHtml(l) + '</span>');
      parts.push('</div>');
    }
    if (platforms.length > 0) {
      parts.push('<div class="ext-detail-heading">Platforms</div>');
      parts.push('<div class="ext-detail-badges">');
      for (const p of platforms) parts.push('<span class="badge">' + escapeHtml(p) + '</span>');
      parts.push('</div>');
    }
    parts.push('</div>');
  }

  if (!detail) {
    parts.push('<div class="panel"><p class="hint">Version-level detail (models, workflows, reports, etc.) is only available when authenticated with swamp-club. Run <code>swamp auth login</code> and reload.</p></div>');
  } else {
    // Release notes
    if (detail.releaseNotes) {
      parts.push('<h2>Release Notes</h2>');
      parts.push('<div class="panel"><pre class="ext-detail-pre">' + escapeHtml(detail.releaseNotes) + '</pre></div>');
    }

    // Models
    if (Array.isArray(detail.models) && detail.models.length > 0) {
      parts.push('<h2>Models <span class="hint" style="font-family:var(--mono);font-size:11px">(' + detail.models.length + ')</span></h2>');
      for (const m of detail.models) {
        parts.push('<div class="panel ext-content-card">');
        parts.push('<div class="ext-content-title">' + escapeHtml(m.type || m.fileName || '(model)') + (m.version ? ' <span class="hint" style="font-size:11px">v' + escapeHtml(m.version) + '</span>' : '') + '</div>');
        if (Array.isArray(m.globalArguments) && m.globalArguments.length > 0) {
          parts.push('<div class="ext-detail-heading">Global arguments</div>');
          parts.push('<ul class="ext-arg-list">');
          for (const arg of m.globalArguments) parts.push(renderArg(arg));
          parts.push('</ul>');
        }
        if (Array.isArray(m.methods) && m.methods.length > 0) {
          parts.push('<div class="ext-detail-heading">Methods</div>');
          for (const mth of m.methods) {
            parts.push('<div class="ext-method">');
            parts.push('<div class="ext-method-name">' + escapeHtml(mth.name) + '</div>');
            if (mth.description) parts.push('<div class="hint">' + escapeHtml(mth.description) + '</div>');
            if (Array.isArray(mth.arguments) && mth.arguments.length > 0) {
              parts.push('<ul class="ext-arg-list" style="margin-top:6px">');
              for (const arg of mth.arguments) parts.push(renderArg(arg));
              parts.push('</ul>');
            }
            parts.push('</div>');
          }
        }
        if (Array.isArray(m.resources) && m.resources.length > 0) {
          parts.push('<div class="ext-detail-heading">Resources</div>');
          parts.push('<ul class="ext-arg-list">');
          for (const r of m.resources) parts.push('<li><span class="arg-name">' + escapeHtml(r.key) + '</span> <span class="arg-type">' + escapeHtml(r.lifetime || '') + '</span>' + (r.description ? ' <span class="hint">— ' + escapeHtml(r.description) + '</span>' : '') + '</li>');
          parts.push('</ul>');
        }
        if (Array.isArray(m.files) && m.files.length > 0) {
          parts.push('<div class="ext-detail-heading">Files</div>');
          parts.push('<ul class="ext-arg-list">');
          for (const f of m.files) parts.push('<li><span class="arg-name">' + escapeHtml(f.key) + '</span> <span class="arg-type">' + escapeHtml(f.contentType || '') + '</span>' + (f.description ? ' <span class="hint">— ' + escapeHtml(f.description) + '</span>' : '') + '</li>');
          parts.push('</ul>');
        }
        parts.push('</div>');
      }
    }

    // Workflows
    if (Array.isArray(detail.workflows) && detail.workflows.length > 0) {
      parts.push('<h2>Workflows <span class="hint" style="font-family:var(--mono);font-size:11px">(' + detail.workflows.length + ')</span></h2>');
      for (const wf of detail.workflows) {
        parts.push('<div class="panel ext-content-card">');
        parts.push('<div class="ext-content-title">' + escapeHtml(wf.name) + '</div>');
        if (wf.description) parts.push('<div class="hint">' + escapeHtml(wf.description) + '</div>');
        if (Array.isArray(wf.jobs) && wf.jobs.length > 0) {
          parts.push('<div class="ext-detail-heading">Jobs</div>');
          for (const job of wf.jobs) {
            parts.push('<div class="ext-method">');
            parts.push('<div class="ext-method-name">' + escapeHtml(job.name) + '</div>');
            if (job.description) parts.push('<div class="hint">' + escapeHtml(job.description) + '</div>');
            if (Array.isArray(job.steps) && job.steps.length > 0) {
              parts.push('<ul class="ext-arg-list" style="margin-top:6px">');
              for (const step of job.steps) {
                const target = step.modelIdOrName && step.methodName ? ' → ' + step.modelIdOrName + '.' + step.methodName : '';
                parts.push('<li><span class="arg-name">' + escapeHtml(step.name) + '</span> <span class="arg-type">' + escapeHtml(step.taskType || '') + '</span>' + (target ? ' <span class="hint">' + escapeHtml(target) + '</span>' : '') + '</li>');
              }
              parts.push('</ul>');
            }
            parts.push('</div>');
          }
        }
        parts.push('</div>');
      }
    }

    // Vaults
    if (Array.isArray(detail.vaults) && detail.vaults.length > 0) {
      parts.push('<h2>Vaults <span class="hint" style="font-family:var(--mono);font-size:11px">(' + detail.vaults.length + ')</span></h2>');
      for (const v of detail.vaults) {
        parts.push(renderProviderCard(v));
      }
    }
    // Datastores
    if (Array.isArray(detail.datastores) && detail.datastores.length > 0) {
      parts.push('<h2>Datastores <span class="hint" style="font-family:var(--mono);font-size:11px">(' + detail.datastores.length + ')</span></h2>');
      for (const d of detail.datastores) parts.push(renderProviderCard(d));
    }
    // Drivers
    if (Array.isArray(detail.drivers) && detail.drivers.length > 0) {
      parts.push('<h2>Drivers <span class="hint" style="font-family:var(--mono);font-size:11px">(' + detail.drivers.length + ')</span></h2>');
      for (const dr of detail.drivers) parts.push(renderProviderCard(dr));
    }
    // Reports
    if (Array.isArray(detail.reports) && detail.reports.length > 0) {
      parts.push('<h2>Reports <span class="hint" style="font-family:var(--mono);font-size:11px">(' + detail.reports.length + ')</span></h2>');
      for (const r of detail.reports) {
        parts.push('<div class="panel ext-content-card">');
        parts.push('<div class="ext-content-title">' + escapeHtml(r.name) + ' <span class="hint" style="font-size:11px">scope=' + escapeHtml(r.scope || '') + '</span></div>');
        if (r.description) parts.push('<div class="hint">' + escapeHtml(r.description) + '</div>');
        if (Array.isArray(r.labels) && r.labels.length > 0) {
          parts.push('<div style="margin-top:6px">');
          for (const l of r.labels) parts.push('<span class="badge" style="margin-right:4px">' + escapeHtml(l) + '</span>');
          parts.push('</div>');
        }
        parts.push('</div>');
      }
    }
    // Skills
    if (Array.isArray(detail.skills) && detail.skills.length > 0) {
      parts.push('<h2>Skills <span class="hint" style="font-family:var(--mono);font-size:11px">(' + detail.skills.length + ')</span></h2>');
      for (const s of detail.skills) {
        parts.push('<div class="panel ext-content-card">');
        parts.push('<div class="ext-content-title">' + escapeHtml(s.name || s.dirName) + '</div>');
        if (s.description) parts.push('<div class="hint">' + escapeHtml(s.description) + '</div>');
        parts.push('<div class="hint" style="margin-top:4px;font-size:10px">' + (s.fileCount || 0) + ' files' + (s.hasScripts ? ' · has scripts' : '') + '</div>');
        parts.push('</div>');
      }
    }

    // Dependencies
    if (Array.isArray(detail.dependencies) && detail.dependencies.length > 0) {
      parts.push('<h2>Dependencies</h2>');
      parts.push('<div class="panel ext-detail-badges">');
      for (const d of detail.dependencies) parts.push('<span class="badge">' + escapeHtml(d) + '</span>');
      parts.push('</div>');
    }
  }

  if (homepage) {
    parts.push('<div style="margin-top:16px"><a href="' + escapeHtml(homepage) + '" target="_blank" style="color:var(--cyan);font-family:var(--mono);font-size:12px">&gt; ' + escapeHtml(homepage) + '</a></div>');
  }

  main.innerHTML = parts.join('');

  // Wire install
  $('installBtn').onclick = async () => {
    $('installStatus').textContent = 'Installing…';
    $('installBtn').disabled = true;
    try {
      const r = await fetch('/api/extensions/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      installedNames.add(name);
      $('installStatus').innerHTML = '<span class="ok">Installed.</span>';
      await loadInstalled();
      renderExtensionPanel(name);
    } catch (e) {
      $('installStatus').innerHTML = '<span class="err">' + escapeHtml(String(e.message || e)) + '</span>';
      $('installBtn').disabled = false;
    }
  };
}

async function loadExtensionTypes(extensionName) {
  const header = $('typePickerHeader');
  const wrap = $('typePickerWrap');
  try {
    const r = await fetch('/api/types?prefix=' + encodeURIComponent(extensionName));
    const d = await r.json();
    const types = d.types || [];
    if (types.length === 0) {
      // Extension provides no model types — it contributes reports,
      // workflows, vaults, drivers, or skills instead. Hide the instance
      // sections and show a hint.
      const defsList = $('defsList');
      const defsHeader = defsList ? defsList.previousElementSibling : null;
      if (defsList) defsList.style.display = 'none';
      if (defsHeader) defsHeader.style.display = 'none';
      const createHeader = $('createHeader');
      const createWrap = $('createFormWrap');
      if (createHeader) createHeader.style.display = 'none';
      if (createWrap) createWrap.style.display = 'none';
      header.style.display = '';
      header.textContent = 'No model types';
      wrap.innerHTML =
        '<p class="hint">This extension does not contribute any model types — it likely provides <strong style="color:var(--label)">reports</strong>, <strong style="color:var(--label)">workflows</strong>, <strong style="color:var(--label)">vaults</strong>, <strong style="color:var(--label)">drivers</strong>, or <strong style="color:var(--label)">skills</strong> instead, which are not instantiable from this UI.</p>';
      return;
    }
    if (types.length === 1) {
      // Single type — no picker needed.
      loadDefinitions(types[0]);
      loadCreateForm(types[0]);
      return;
    }
    // Multi-type extension — render a select so the user picks which type.
    header.style.display = '';
    header.textContent = 'Model type';
    wrap.innerHTML = '<select id="typePicker">' +
      types.map((t) => '<option value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>').join('') +
      '</select>';
    const sel = $('typePicker');
    const onChange = () => {
      const chosen = sel.value;
      loadDefinitions(chosen);
      loadCreateForm(chosen);
    };
    sel.onchange = onChange;
    onChange();
  } catch (e) {
    wrap.innerHTML = '<p class="err">' + escapeHtml(String(e)) + '</p>';
  }
}

async function loadCreateForm(typeName) {
  const wrap = $('createFormWrap');
  if (!wrap) return;
  await refreshVaults();
  let schema = null;
  try {
    const r = await fetch('/api/types/' + encodeURIComponent(typeName) + '/describe');
    const d = await r.json();
    if (d.error) {
      wrap.innerHTML = '<p class="hint">' + escapeHtml(d.error.message) + '</p>';
      return;
    }
    schema = d.globalArguments;
  } catch (e) {
    wrap.innerHTML = '<p class="err">' + escapeHtml(String(e)) + '</p>';
    return;
  }

  const placeholder = defaultInstanceName(typeName);
  const parts = ['<form class="run-form" id="createForm">'];
  parts.push('<label>Name <input name="__name" required value="' + escapeHtml(placeholder) + '"></label>');

  const props = (schema && schema.properties) || {};
  const required = new Set((schema && schema.required) || []);
  if (Object.keys(props).length === 0) {
    parts.push('<p class="hint">No global arguments.</p>');
  } else {
    for (const [key, propSchema] of Object.entries(props)) {
      const req = required.has(key) ? ' *' : '';
      const desc = propSchema.description ? ' <span class="hint">' + escapeHtml(propSchema.description) + '</span>' : '';
      parts.push('<label>' + escapeHtml(key) + req + ' <span class="hint">(' + escapeHtml(propSchema.type || 'any') + ')</span>' + desc + '</label>');
      if (propSchema.enum) {
        parts.push('<select name="' + escapeHtml(key) + '">');
        for (const v of propSchema.enum) parts.push('<option value="' + escapeHtml(String(v)) + '">' + escapeHtml(String(v)) + '</option>');
        parts.push('</select>');
      } else if (propSchema.type === 'boolean') {
        parts.push('<select name="' + escapeHtml(key) + '"><option value="">-</option><option value="true">true</option><option value="false">false</option></select>');
      } else if (propSchema.type === 'object' || propSchema.type === 'array') {
        parts.push('<div class="field-row" style="align-items:stretch"><textarea name="' + escapeHtml(key) + '" rows="3" placeholder="JSON" style="flex:1"></textarea><span class="vault-slot" data-field="' + escapeHtml(key) + '"></span></div>');
      } else {
        const type = propSchema.type === 'number' || propSchema.type === 'integer' ? 'number' : 'text';
        parts.push('<div class="field-row"><input name="' + escapeHtml(key) + '" type="' + type + '" style="flex:1"><span class="vault-slot" data-field="' + escapeHtml(key) + '"></span></div>');
      }
    }
  }
  parts.push('<button type="submit">Create</button>');
  parts.push(' <span id="createStatus" class="hint"></span>');
  parts.push('</form>');
  wrap.innerHTML = parts.join('');

  document.querySelectorAll('#createForm .vault-slot').forEach((slot) => {
    const fieldName = slot.dataset.field;
    const input = document.querySelector('#createForm [name="' + CSS.escape(fieldName) + '"]');
    if (!input) return;
    const btn = vaultPickerFor(fieldName, input);
    if (btn) slot.appendChild(btn);
  });

  $('createForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const defName = fd.get('__name');
    const globalArguments = {};
    for (const [k, v] of fd.entries()) {
      if (k === '__name') continue;
      if (v === '') continue;
      try { globalArguments[k] = JSON.parse(v); }
      catch { globalArguments[k] = v; }
    }
    $('createStatus').textContent = 'Creating...';
    try {
      const r = await fetch('/api/definitions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: typeName,
          name: defName,
          globalArguments: Object.keys(globalArguments).length ? globalArguments : undefined,
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      $('createStatus').innerHTML = '<span class="ok">Created ' + escapeHtml(d.definition.name) + '</span>';
      await loadDefinitions(typeName);
      selectDefinition(d.definition.name);
    } catch (e) {
      $('createStatus').innerHTML = '<span class="err">' + escapeHtml(String(e.message || e)) + '</span>';
    }
  };
}

function defaultInstanceName(typeName) {
  const base = typeName.split('/').pop().replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'instance';
  const suffix = Math.random().toString(36).slice(2, 8);
  return base + '-' + suffix;
}

async function loadDefinitions(typeName) {
  const el = $('defsList');
  if (!el) return;
  try {
    const r = await fetch('/api/definitions?type=' + encodeURIComponent(typeName));
    const d = await r.json();
    if (d.error) { el.innerHTML = '<p class="hint">' + escapeHtml(d.error.message) + '</p>'; return; }
    if (!d.definitions || d.definitions.length === 0) {
      el.innerHTML = '<p class="hint">No instances yet — create one below.</p>';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'ext-list';
    for (const def of d.definitions) {
      const li = document.createElement('li');
      li.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';
      const left = document.createElement('div');
      left.style.cssText = 'flex:1;min-width:0;cursor:pointer';
      left.innerHTML = '<div class="name">' + escapeHtml(def.name) + '</div>';
      left.onclick = () => selectDefinition(def.name);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = '✎';
      editBtn.title = 'Edit global arguments';
      editBtn.style.cssText = 'width:auto;padding:4px 10px;background:transparent;border:1px solid var(--green-dim);color:var(--green);cursor:pointer;font-size:12px';
      editBtn.onclick = (e) => { e.stopPropagation(); openInstanceEditor(typeName, def.name); };

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete instance';
      delBtn.style.cssText = 'width:auto;padding:4px 10px;background:transparent;border:1px solid rgba(255,77,77,0.4);color:var(--red);cursor:pointer;font-size:12px';
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        const r = await fetch('/api/definitions/' + encodeURIComponent(def.name), { method: 'DELETE' });
        const d2 = await r.json();
        if (d2.error) {
          delBtn.title = d2.error.message;
          delBtn.style.background = 'rgba(255,77,77,0.15)';
          return;
        }
        await loadDefinitions(typeName);
      };

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      li.appendChild(left);
      li.appendChild(actions);
      ul.appendChild(li);
    }
    el.innerHTML = '';
    el.appendChild(ul);
  } catch (e) {
    el.innerHTML = '<p class="err">' + escapeHtml(String(e)) + '</p>';
  }
}

async function openInstanceEditor(typeName, defName) {
  await refreshVaults();
  // Fetch both the current definition and its type schema in parallel.
  const [defRes, typeRes] = await Promise.all([
    fetch('/api/definitions/' + encodeURIComponent(defName)).then((r) => r.json()),
    fetch('/api/types/' + encodeURIComponent(typeName) + '/describe').then((r) => r.json()),
  ]);
  if (defRes.error) { showToast(defRes.error.message, 'err'); return; }
  const current = defRes.globalArguments || {};
  const schema = typeRes && typeRes.globalArguments ? typeRes.globalArguments : null;
  const props = (schema && schema.properties) || {};
  const required = new Set((schema && schema.required) || []);

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:100';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  const modal = document.createElement('div');
  modal.style.cssText = 'background:#000;border:1px solid var(--green);padding:24px;width:560px;max-width:90vw;max-height:85vh;overflow-y:auto;box-shadow:0 0 24px rgba(57,255,20,0.2)';

  const parts = [
    '<h2 style="margin-top:0;font-family:var(--orbitron);color:var(--green);letter-spacing:0.1em">EDIT ' + escapeHtml(defName).toUpperCase() + '</h2>',
    '<form id="editForm" class="run-form" style="margin:0">',
    '<label>Name</label>',
    '<input name="__name" value="' + escapeHtml(defName) + '" required>',
  ];
  // Build fields: union of schema props and any current args (for extras)
  const allKeys = new Set([...Object.keys(props), ...Object.keys(current)]);
  if (allKeys.size === 0) {
    parts.push('<p class="hint">No global arguments.</p>');
  } else {
    for (const key of allKeys) {
      const propSchema = props[key] || { type: 'string' };
      const req = required.has(key) ? ' *' : '';
      const currentVal = current[key];
      const val = currentVal === undefined ? '' : (typeof currentVal === 'string' ? currentVal : JSON.stringify(currentVal));
      parts.push('<label>' + escapeHtml(key) + req + ' <span class="hint">(' + escapeHtml(propSchema.type || 'any') + ')</span></label>');
      if (propSchema.enum) {
        parts.push('<select name="' + escapeHtml(key) + '">');
        for (const v of propSchema.enum) {
          const sel = String(v) === String(currentVal) ? ' selected' : '';
          parts.push('<option value="' + escapeHtml(String(v)) + '"' + sel + '>' + escapeHtml(String(v)) + '</option>');
        }
        parts.push('</select>');
      } else if (propSchema.type === 'boolean') {
        parts.push('<select name="' + escapeHtml(key) + '">');
        parts.push('<option value=""' + (currentVal === undefined ? ' selected' : '') + '>-</option>');
        parts.push('<option value="true"' + (currentVal === true ? ' selected' : '') + '>true</option>');
        parts.push('<option value="false"' + (currentVal === false ? ' selected' : '') + '>false</option>');
        parts.push('</select>');
      } else if (propSchema.type === 'object' || propSchema.type === 'array') {
        parts.push('<div class="field-row" style="align-items:stretch"><textarea name="' + escapeHtml(key) + '" rows="3" style="flex:1">' + escapeHtml(val) + '</textarea><span class="vault-slot" data-field="' + escapeHtml(key) + '"></span></div>');
      } else {
        const type = propSchema.type === 'number' || propSchema.type === 'integer' ? 'number' : 'text';
        parts.push('<div class="field-row"><input name="' + escapeHtml(key) + '" type="' + type + '" value="' + escapeHtml(val) + '" style="flex:1"><span class="vault-slot" data-field="' + escapeHtml(key) + '"></span></div>');
      }
    }
  }
  parts.push('<div style="display:flex;gap:8px;margin-top:16px">');
  parts.push('<button type="submit">Save</button>');
  parts.push('<button type="button" id="editCancel" style="padding:8px 20px;background:transparent;border:1px solid var(--green-dim);color:var(--muted);cursor:pointer;font-family:var(--orbitron);font-size:12px;letter-spacing:0.15em;text-transform:uppercase">Cancel</button>');
  parts.push(' <span id="editStatus" class="hint"></span>');
  parts.push('</div></form>');
  modal.innerHTML = parts.join('');
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  modal.querySelectorAll('.vault-slot').forEach((slot) => {
    const fieldName = slot.dataset.field;
    const input = modal.querySelector('[name="' + CSS.escape(fieldName) + '"]');
    if (!input) return;
    const btn = vaultPickerFor(fieldName, input);
    if (btn) slot.appendChild(btn);
  });

  document.getElementById('editCancel').onclick = () => overlay.remove();
  document.getElementById('editForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const newName = String(fd.get('__name') || '').trim();
    const globalArguments = {};
    for (const [k, v] of fd.entries()) {
      if (k === '__name') continue;
      if (v === '') continue;
      try { globalArguments[k] = JSON.parse(v); }
      catch { globalArguments[k] = v; }
    }
    document.getElementById('editStatus').textContent = 'Saving...';
    try {
      const r = await fetch('/api/definitions/' + encodeURIComponent(defName), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName, globalArguments }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      overlay.remove();
      await loadDefinitions(typeName);
    } catch (err) {
      document.getElementById('editStatus').innerHTML = '<span class="err">' + escapeHtml(String(err.message || err)) + '</span>';
    }
  };
}

async function selectDefinition(defName) {
  // Hide the Create instance section once a specific instance is selected.
  const createHeader = $('createHeader');
  const createWrap = $('createFormWrap');
  if (createHeader) createHeader.style.display = 'none';
  if (createWrap) createWrap.style.display = 'none';
  $('methodsHeader').style.display = '';
  const area = $('methodArea');
  area.innerHTML = '<p class="hint">Loading methods...</p>';
  try {
    const r = await fetch('/api/models/' + encodeURIComponent(defName) + '/methods');
    const d = await r.json();
    if (d.error) { area.innerHTML = '<p class="err">' + escapeHtml(d.error.message) + '</p>'; return; }
    renderMethodsInto(area, defName, d);
  } catch (e) {
    area.innerHTML = '<p class="err">' + escapeHtml(String(e)) + '</p>';
  }
}

function renderMethodsInto(area, modelName, data) {
  const parts = ['<div class="hint">' + escapeHtml(modelName) + ' (' + escapeHtml(data.modelType) + ')</div>'];
  parts.push('<label>Method: <select id="method">');
  for (const m of data.methods) parts.push('<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>');
  parts.push('</select></label>');
  parts.push('<div id="methodForm"></div>');
  parts.push('<h2>History</h2><div id="history"></div>');
  area.innerHTML = parts.join('');
  $('method').onchange = () => loadMethod(modelName, $('method').value);
  if (data.methods.length > 0) loadMethod(modelName, data.methods[0]);
  loadHistory(modelName);
}

function renderMethods(modelName, data) {
  const main = $('main');
  const parts = ['<h2>' + escapeHtml(modelName) + ' <span class="hint">(' + escapeHtml(data.modelType) + ')</span></h2>'];
  parts.push('<label>Method: <select id="method">');
  for (const m of data.methods) parts.push('<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>');
  parts.push('</select></label>');
  parts.push('<div id="methodForm"></div>');
  parts.push('<h2>History</h2><div id="history"></div>');
  main.innerHTML = parts.join('');
  $('method').onchange = () => loadMethod(modelName, $('method').value);
  loadMethod(modelName, data.methods[0]);
  loadHistory(modelName);
}

async function loadMethod(modelName, methodName) {
  await refreshVaults();
  const r = await fetch('/api/models/' + encodeURIComponent(modelName) + '/methods/' + encodeURIComponent(methodName) + '/describe');
  const d = await r.json();
  if (d.error) { $('methodForm').innerHTML = '<p class="err">' + escapeHtml(d.error.message) + '</p>'; return; }
  const args = d.method.arguments || {};
  const props = args.properties || {};
  const required = new Set(args.required || []);
  const parts = ['<form class="run-form" id="runForm">'];
  if (d.method.description) parts.push('<p class="hint">' + escapeHtml(d.method.description) + '</p>');
  for (const [key, schema] of Object.entries(props)) {
    const req = required.has(key) ? ' *' : '';
    parts.push('<label>' + escapeHtml(key) + req + ' <span class="hint">' + escapeHtml(schema.type || '') + '</span></label>');
    if (schema.enum) {
      parts.push('<select name="' + escapeHtml(key) + '">');
      for (const v of schema.enum) parts.push('<option value="' + escapeHtml(String(v)) + '">' + escapeHtml(String(v)) + '</option>');
      parts.push('</select>');
    } else if (schema.type === 'boolean') {
      parts.push('<select name="' + escapeHtml(key) + '"><option value="">-</option><option value="true">true</option><option value="false">false</option></select>');
    } else if (schema.type === 'object' || schema.type === 'array') {
      parts.push('<div class="field-row" style="align-items:stretch"><textarea name="' + escapeHtml(key) + '" rows="3" placeholder="JSON" style="flex:1"></textarea><span class="vault-slot" data-field="' + escapeHtml(key) + '"></span></div>');
    } else {
      parts.push('<div class="field-row"><input name="' + escapeHtml(key) + '" type="' + (schema.type === 'number' ? 'number' : 'text') + '" style="flex:1"><span class="vault-slot" data-field="' + escapeHtml(key) + '"></span></div>');
    }
  }
  if (Object.keys(props).length === 0) parts.push('<p class="hint">No arguments.</p>');
  parts.push('<button type="submit">Run</button>');
  parts.push('</form>');
  parts.push('<div class="log" id="runLog" style="display:none"></div>');
  $('methodForm').innerHTML = parts.join('');
  // Attach vault pickers to each input/textarea
  document.querySelectorAll('#runForm .vault-slot').forEach((slot) => {
    const fieldName = slot.dataset.field;
    const input = document.querySelector('#runForm [name="' + CSS.escape(fieldName) + '"]');
    if (!input) return;
    const btn = vaultPickerFor(fieldName, input);
    if (btn) slot.appendChild(btn);
  });
  $('runForm').onsubmit = (e) => { e.preventDefault(); runMethod(modelName, methodName, new FormData(e.target)); };
}

async function runMethod(modelName, methodName, formData) {
  const inputs = {};
  for (const [k, v] of formData.entries()) {
    if (v === '') continue;
    try { inputs[k] = JSON.parse(v); } catch { inputs[k] = v; }
  }
  const log = $('runLog');
  if (log) log.style.display = 'none';
  let follower = document.getElementById('runFollower');
  if (!follower) {
    follower = document.createElement('div');
    follower.id = 'runFollower';
    (log || $('methodForm') || $('methodArea')).parentNode.insertBefore(
      follower,
      (log || $('methodForm') || $('methodArea')).nextSibling,
    );
  }
  follower.innerHTML = '';

  const run = {
    kind: 'method',
    label: modelName + '.' + methodName,
    status: 'running',
    startedAt: Date.now(),
    trigger: Object.keys(inputs).length > 0
      ? Object.entries(inputs).map(([k, v]) => k + '=' + JSON.stringify(v)).join(' ')
      : '(no inputs)',
    jobs: [],
    selectedJob: 'method',
    error: null,
    reports: [],
  };
  // One implicit job with one implicit step for method runs.
  const job = { id: 'method', name: methodName, status: 'running', steps: [], startedAt: Date.now(), durationMs: null };
  const step = { id: methodName, name: methodName, status: 'running', output: [], error: null, durationMs: null, reports: [], dataArtifacts: [], startedAt: Date.now() };
  job.steps.push(step);
  run.jobs.push(job);
  renderTaskFollower(follower, run);

  const resp = await fetch('/api/models/' + encodeURIComponent(modelName) + '/methods/' + encodeURIComponent(methodName) + '/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs }),
  });
  await consumeTaskStream(resp, (evt) => applyMethodEvent(run, step, job, evt, follower));
  if (run.status === 'running') run.status = 'succeeded';
  if (job.status === 'running') {
    job.status = run.status;
    job.durationMs = Date.now() - job.startedAt;
  }
  if (step.status === 'running') {
    step.status = run.status;
    step.durationMs = Date.now() - step.startedAt;
  }
  renderTaskFollower(follower, run);
  loadHistory(modelName);
}

function applyMethodEvent(run, step, job, evt, container) {
  switch (evt.kind) {
    case 'method_output':
      step.output.push({ stream: evt.stream, line: evt.line });
      break;
    case 'data_artifact_saved':
      // Placeholder — the full artifact with attributes lands on completed.
      break;
    case 'report_completed':
      step.reports.push({ name: evt.reportName, scope: evt.scope, markdown: evt.markdown, json: evt.json });
      break;
    case 'report_failed':
      step.reports.push({ name: evt.reportName, scope: evt.scope, error: evt.error });
      break;
    case 'completed':
      step.status = evt.run && evt.run.status ? evt.run.status : 'succeeded';
      step.durationMs = Date.now() - step.startedAt;
      job.status = step.status;
      job.durationMs = Date.now() - job.startedAt;
      run.status = step.status;
      run.durationMs = Date.now() - run.startedAt;
      if (evt.run && Array.isArray(evt.run.dataArtifacts)) {
        step.dataArtifacts = evt.run.dataArtifacts.map((a) => ({
          name: a.name,
          attributes: a.attributes,
          preview: a.preview,
          path: a.path,
        }));
      }
      break;
    case 'error':
      run.status = 'failed';
      step.status = 'failed';
      job.status = 'failed';
      step.error = (evt.error && evt.error.message) || JSON.stringify(evt.error);
      run.error = step.error;
      step.durationMs = Date.now() - step.startedAt;
      job.durationMs = Date.now() - job.startedAt;
      run.durationMs = Date.now() - run.startedAt;
      break;
  }
  renderTaskFollower(container, run);
}

function renderRunOutput(outArea, reports, dataArtifacts) {
  const parts = [];
  if (reports.length > 0) {
    parts.push('<h2 style="margin-top:16px">Reports</h2>');
    for (const r of reports) {
      parts.push('<details open style="background:#161a21;border:1px solid #222832;border-radius:6px;padding:8px 12px;margin-bottom:8px">');
      parts.push('<summary><strong>' + escapeHtml(r.name) + '</strong> <span class="hint">(' + escapeHtml(r.scope) + ')</span></summary>');
      if (r.markdown) {
        parts.push('<pre style="white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;color:#e6e6e6;background:#0a0c10;border:1px solid #222832;border-radius:4px;padding:10px;margin-top:8px;overflow-x:auto">' + escapeHtml(r.markdown) + '</pre>');
      }
      if (r.json && Object.keys(r.json).length > 0) {
        parts.push('<details style="margin-top:6px"><summary class="hint">JSON</summary>');
        parts.push('<pre style="white-space:pre-wrap;font:11px/1.4 ui-monospace,monospace;color:#8a94a6;background:#0a0c10;border:1px solid #222832;border-radius:4px;padding:8px;overflow-x:auto">' + escapeHtml(JSON.stringify(r.json, null, 2)) + '</pre>');
        parts.push('</details>');
      }
      parts.push('</details>');
    }
  }
  if (dataArtifacts.length > 0) {
    parts.push('<h2 style="margin-top:16px">Data artifacts</h2>');
    for (const a of dataArtifacts) {
      parts.push('<details open style="background:#161a21;border:1px solid #222832;border-radius:6px;padding:8px 12px;margin-bottom:8px">');
      parts.push('<summary><strong>' + escapeHtml(a.name) + '</strong> <span class="hint">' + escapeHtml(a.path || '') + '</span></summary>');
      if (a.attributes) {
        parts.push('<pre style="white-space:pre-wrap;font:11px/1.4 ui-monospace,monospace;color:#e6e6e6;background:#0a0c10;border:1px solid #222832;border-radius:4px;padding:8px;margin-top:8px;overflow-x:auto">' + escapeHtml(JSON.stringify(a.attributes, null, 2)) + '</pre>');
      }
      parts.push('</details>');
    }
  }
  outArea.innerHTML = parts.join('');
}

async function loadHistory(modelName) {
  const el = $('history');
  if (!el) return;
  const r = await fetch('/api/models/' + encodeURIComponent(modelName) + '/history');
  const d = await r.json();
  if (d.error) { el.innerHTML = '<p class="err">' + escapeHtml(d.error.message) + '</p>'; return; }
  if (!d.runs || d.runs.length === 0) { el.innerHTML = '<p class="hint">No historical runs.</p>'; return; }

  const table = document.createElement('table');
  table.className = 'history';
  table.innerHTML = '<thead><tr><th style="width:18px"></th><th>Method</th><th>Status</th><th>Started</th><th>Duration</th></tr></thead>';
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  for (const run of d.runs) {
    const row = document.createElement('tr');
    row.style.cursor = 'pointer';
    row.innerHTML =
      '<td class="hist-caret" style="color:var(--cyan)">▸</td>' +
      '<td>' + escapeHtml(run.methodName) + '</td>' +
      '<td class="status-' + escapeHtml(run.status) + '">' + escapeHtml(run.status) + '</td>' +
      '<td>' + escapeHtml(run.startedAt) + '</td>' +
      '<td>' + (run.durationMs != null ? run.durationMs + 'ms' : '') + '</td>';
    tbody.appendChild(row);

    const detail = document.createElement('tr');
    detail.style.display = 'none';
    const detailCell = document.createElement('td');
    detailCell.colSpan = 5;
    detailCell.style.cssText = 'padding:12px 16px;background:rgba(57,255,20,0.03);border-left:2px solid var(--green-dim)';
    detailCell.innerHTML = '<p class="hint">Loading run data…</p>';
    detail.appendChild(detailCell);
    tbody.appendChild(detail);

    let loaded = false;
    row.onclick = async () => {
      const caret = row.querySelector('.hist-caret');
      if (detail.style.display === 'none') {
        detail.style.display = '';
        if (caret) caret.textContent = '▾';
        if (!loaded) {
          loaded = true;
          try {
            const rr = await fetch('/api/models/' + encodeURIComponent(modelName) + '/outputs/' + encodeURIComponent(run.id));
            const od = await rr.json();
            if (od.error) {
              detailCell.innerHTML = '<p class="err">' + escapeHtml(od.error.message) + '</p>';
              return;
            }
            // Build a run-state matching what the live task-follower produces
            // so historical runs use the exact same renderer.
            const historyRun = outputToRunState(modelName, od);
            detailCell.innerHTML = '';
            renderTaskFollower(detailCell, historyRun);
          } catch (e) {
            detailCell.innerHTML = '<p class="err">' + escapeHtml(String(e)) + '</p>';
          }
        }
      } else {
        detail.style.display = 'none';
        if (caret) caret.textContent = '▸';
      }
    };
  }
  el.innerHTML = '';
  el.appendChild(table);
}

function outputToRunState(modelName, output) {
  const artifacts = (output.artifacts || []).map((a) => ({
    name: a.name,
    attributes: a.attributes,
    preview: a.preview,
    error: a.error,
  }));
  const step = {
    id: output.methodName,
    name: output.methodName,
    status: output.status,
    output: [],
    error: output.error ? (output.error.message || String(output.error)) : null,
    durationMs: output.durationMs ?? null,
    reports: [],
    dataArtifacts: artifacts,
    startedAt: null,
  };
  const job = {
    id: 'method',
    name: output.methodName,
    status: output.status,
    steps: [step],
    startedAt: null,
    durationMs: output.durationMs ?? null,
  };
  return {
    kind: 'method',
    label: modelName + '.' + output.methodName,
    status: output.status,
    startedAt: output.startedAt ? new Date(output.startedAt).getTime() : null,
    durationMs: output.durationMs ?? null,
    trigger: '(history)',
    jobs: [job],
    selectedJob: 'method',
    reports: [],
    error: step.error,
  };
}

function renderOutputDetail(output) {
  const parts = [];
  if (output.error) {
    parts.push('<div style="margin-bottom:10px"><div class="hint" style="color:var(--label);text-transform:uppercase;font-size:10px;letter-spacing:0.1em;margin-bottom:4px">Error</div>');
    parts.push('<pre style="white-space:pre-wrap;font:12px/1.5 var(--mono);color:var(--red);background:#000;border:1px solid rgba(255,77,77,0.3);padding:8px;margin:0">' + escapeHtml(output.error.message || String(output.error)) + '</pre>');
    parts.push('</div>');
  }
  if (output.artifacts && output.artifacts.length > 0) {
    parts.push('<div class="hint" style="color:var(--label);text-transform:uppercase;font-size:10px;letter-spacing:0.1em;margin-bottom:6px">Data Artifacts</div>');
    for (const a of output.artifacts) {
      parts.push('<details open style="margin-bottom:8px;border:1px solid var(--green-dim);padding:6px 10px">');
      const tagStr = a.tags && Object.keys(a.tags).length > 0
        ? ' ' + Object.entries(a.tags).map(([k, v]) => escapeHtml(k) + '=' + escapeHtml(String(v))).join(' ')
        : '';
      parts.push('<summary><strong style="color:var(--green)">' + escapeHtml(a.name) + '</strong> <span class="hint">v' + a.version + tagStr + '</span></summary>');
      if (a.error) {
        parts.push('<p class="err" style="margin:6px 0 0">' + escapeHtml(a.error) + '</p>');
      } else if (a.attributes !== undefined) {
        parts.push('<pre style="white-space:pre-wrap;font:11px/1.4 var(--mono);color:var(--green);background:#000;border:1px solid var(--green-dim);padding:8px;margin:8px 0 0;max-height:400px;overflow:auto">' + escapeHtml(JSON.stringify(a.attributes, null, 2)) + '</pre>');
      } else if (a.preview) {
        parts.push('<pre style="white-space:pre-wrap;font:11px/1.4 var(--mono);color:var(--muted);background:#000;border:1px solid var(--green-dim);padding:8px;margin:8px 0 0;max-height:400px;overflow:auto">' + escapeHtml(a.preview) + '</pre>');
      }
      parts.push('</details>');
    }
  }
  if (!output.error && (!output.artifacts || output.artifacts.length === 0)) {
    parts.push('<p class="hint">No data artifacts produced by this run.</p>');
  }
  return parts.join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

let _toastRoot = null;
function showToast(message, kind) {
  if (!_toastRoot) {
    _toastRoot = document.createElement('div');
    _toastRoot.id = 'toastRoot';
    _toastRoot.style.cssText = 'position:fixed;top:64px;right:24px;z-index:500;display:flex;flex-direction:column;gap:8px;max-width:440px;pointer-events:none';
    document.body.appendChild(_toastRoot);
  }
  const toast = document.createElement('div');
  const isErr = kind === 'err';
  toast.style.cssText = 'pointer-events:auto;background:#000;border:1px solid ' + (isErr ? 'var(--red)' : 'var(--green)') + ';color:' + (isErr ? 'var(--red)' : 'var(--green)') + ';padding:10px 14px;font:11px/1.5 var(--mono);box-shadow:0 0 16px ' + (isErr ? 'rgba(255,77,77,0.2)' : 'rgba(57,255,20,0.2)') + ';white-space:pre-wrap;word-break:break-word;max-width:440px;opacity:0;transform:translateX(20px);transition:all 0.2s';
  toast.textContent = String(message);
  _toastRoot.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 200);
  }, 6000);
}

boot();
</script>
</body>
</html>
`;
