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

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/app"
)

// sourceTree is the git tree id of tools/swamp-eval, set by build.sh.
var sourceTree = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	env := app.DefaultEnv()
	env.SourceTree = sourceTree
	code := app.Main(ctx, os.Args[1:], env)
	stop()
	os.Exit(code)
}
