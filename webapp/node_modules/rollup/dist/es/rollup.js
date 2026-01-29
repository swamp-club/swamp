/*
  @license
	Rollup.js v4.57.0
	Tue, 27 Jan 2026 07:16:05 GMT - commit 743d0546f59799a8f7e4e2f4e1ad167f7dae333d

	https://github.com/rollup/rollup

	Released under the MIT License.
*/
export { version as VERSION, defineConfig, rollup, watch } from './shared/node-entry.js';
import './shared/parseAst.js';
import '../native.js';
import 'node:path';
import 'path';
import 'node:process';
import 'node:perf_hooks';
import 'node:fs/promises';
