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

//go:build windows

package serves

import (
	"errors"
	"io"
	"os/exec"
	"time"
)

// Windows has no SIGTERM for a console-less child, so a stop kills it.
type windowsProcess struct{ cmd *exec.Cmd }

func startProcess(argv []string, dir string, stdout, stderr io.Writer) (Process, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &windowsProcess{cmd: cmd}, nil
}

func (p *windowsProcess) Pid() int         { return p.cmd.Process.Pid }
func (p *windowsProcess) Terminate() error { return p.cmd.Process.Kill() }
func (p *windowsProcess) Kill() error      { return p.cmd.Process.Kill() }

func (p *windowsProcess) Wait() (int, error) {
	err := p.cmd.Wait()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}
