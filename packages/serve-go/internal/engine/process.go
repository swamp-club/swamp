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

package engine

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

// Process is injectable so lifecycle tests never need a real engine subprocess.
type Process interface {
	Input() io.WriteCloser
	Output() io.ReadCloser
	Wait() error
	Kill() error
}
type Starter func(context.Context) (Process, error)

func setProcessCleanupDeadline(process Process, ctx context.Context) {
	deadline, bounded := ctx.Deadline()
	if ctx.Err() != nil {
		deadline, bounded = time.Now(), true
	}
	if controlled, ok := process.(interface{ SetCleanupDeadline(time.Time) }); ok && bounded {
		controlled.SetCleanupDeadline(deadline)
	}
}

type childProcess struct {
	cmd             *exec.Cmd
	in              io.WriteCloser
	out             io.ReadCloser
	terminate       func() error
	release         func()
	mu              sync.Mutex
	exited          bool
	fence           processFence
	reaped          chan struct{}
	uncertainReaper *processReaper
}

type processReaper struct {
	done chan struct{}
	err  error // Published by closing done; uncertainty remains sticky even on success.
}

func (p *childProcess) startUncertainReaper(reap func() error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.uncertainReaper != nil {
		return
	}
	result := &processReaper{done: make(chan struct{})}
	p.uncertainReaper = result
	go func() { result.err = reap(); close(result.done) }()
}

func (p *childProcess) Input() io.WriteCloser { return p.in }
func (p *childProcess) Pid() int {
	if p.cmd == nil || p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}
func (p *childProcess) Output() io.ReadCloser { return p.out }
func (p *childProcess) Wait() error {
	err := p.waitContained()
	close(p.reaped)
	return errors.Join(err, p.fence.SealAndWait())
}

// Unix keeps its child waitable until the final process-group signal. Holding
// mu through reap also prevents a concurrent Kill from signaling a reused PGID.
func (p *childProcess) waitGroupBeforeReaping(observe, reap func() error) error {
	observed := observe()
	p.mu.Lock()
	defer p.mu.Unlock()
	if observed != nil {
		p.exited = true
		return errors.Join(ErrUnconfirmedCommandCleanup, observed)
	}
	p.release()
	p.exited = true
	return reap()
}
func (p *childProcess) SetCleanupDeadline(deadline time.Time) { p.fence.SetDeadline(deadline) }
func (p *childProcess) Kill() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.exited {
		return nil
	}
	return p.terminate()
}

// ExecStarter runs a repository engine with the repository as its working
// directory, so cwd-relative defaults resolve inside the repository.
func ExecStarter(executable, repo string, cleanupTimeout ...time.Duration) Starter {
	return execStarter(executable, repo, []string{"--repo", repo}, cleanupTimeout)
}

// UntrustedStarter runs a repository engine that loads no extension code:
// it serves an untrusted workspace's dashboard read-only.
func UntrustedStarter(executable, repo string, cleanupTimeout ...time.Duration) Starter {
	return execStarter(executable, repo, []string{"--repo", repo, "--no-extensions"}, cleanupTimeout)
}

// ControlStarter runs the repository-less hub control engine.
func ControlStarter(executable string, cleanupTimeout ...time.Duration) Starter {
	return execStarter(executable, "", []string{"--control"}, cleanupTimeout)
}

func execStarter(executable, dir string, mode []string, cleanupTimeout []time.Duration) Starter {
	return func(ctx context.Context) (Process, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		guardian, err := os.Executable()
		if err != nil {
			return nil, err
		}
		budget := DefaultConfig().DrainTimeout
		if len(cleanupTimeout) != 0 && cleanupTimeout[0] > 0 {
			budget = cleanupTimeout[0]
		}
		fence, err := newProcessFence(budget)
		if err != nil {
			return nil, err
		}
		started := false
		defer func() {
			if !started {
				fence.Close()
			}
		}()
		cmd := exec.Command(executable, append([]string{"engine", "--stdio"}, mode...)...)
		cmd.Dir = dir
		// All standard streams use the null device (the nil defaults).
		// Extension subprocesses must never inherit either private RPC channel.
		// Own both protocol pipes so Cmd.Wait cannot close the reply pipe before
		// its final frame has been consumed by the transport reader.
		inRead, inWrite, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		outRead, outWrite, err := os.Pipe()
		if err != nil {
			inRead.Close()
			inWrite.Close()
			return nil, err
		}
		prepareProcess(cmd)
		pipeArgs, err := configureProtocolPipes(cmd, inRead, outWrite)
		if err != nil {
			inRead.Close()
			inWrite.Close()
			outRead.Close()
			outWrite.Close()
			return nil, err
		}
		cmd.Args = append(cmd.Args, pipeArgs...)
		cmd.Args = append(cmd.Args, "--command-guardian", guardian)
		cmd.Args = append(cmd.Args, "--command-fence", fence.Path())
		if err = cmd.Start(); err != nil {
			inRead.Close()
			inWrite.Close()
			outRead.Close()
			outWrite.Close()
			return nil, err
		}
		inRead.Close()
		outWrite.Close()
		terminate, release, err := containProcess(cmd, fence)
		if err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			inWrite.Close()
			outRead.Close()
			return nil, err
		}
		process := &childProcess{cmd: cmd, in: inWrite, out: outRead, terminate: terminate, release: release, fence: fence, reaped: make(chan struct{})}
		started = true
		go func() {
			select {
			case <-fence.Failed():
				_ = process.Kill()
			case <-process.reaped:
			}
		}()
		return process, nil
	}
}
