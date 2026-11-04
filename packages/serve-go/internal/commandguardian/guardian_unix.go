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

//go:build linux || darwin

package commandguardian

import (
	"errors"
	"github.com/swamp-club/swamp/packages/serve-go/internal/processgroup"
	"golang.org/x/sys/unix"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

type managedProcess interface {
	observeExit() error
	signalGroup(syscall.Signal) error
	reap() (int, error)
	confirmExit() error
}

type commandProcess struct{ cmd *exec.Cmd }

func (p commandProcess) observeExit() error {
	return processgroup.WaitWithoutReaping(p.cmd.Process.Pid)
}
func (p commandProcess) signalGroup(signal syscall.Signal) error {
	err := syscall.Kill(-p.cmd.Process.Pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
func (p commandProcess) reap() (int, error) {
	err := p.cmd.Wait()
	if err == nil {
		return 0, nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		status := exit.Sys().(syscall.WaitStatus)
		if status.Signaled() {
			return 128 + int(status.Signal()), nil
		}
		return exit.ExitCode(), nil
	}
	return 125, err
}

// Reaping only the leader is insufficient: a killed descendant may still be
// exiting. Confirmation sends no further signals after the PID is released.
func (p commandProcess) confirmExit() error { return confirmGroupExit(p.cmd.Process.Pid) }

// Go constructs os.Stdin before it knows this is an owned lifetime pipe. Make
// a fresh nonblocking file so Close reliably interrupts the pending read.
func pollableInput(input io.ReadCloser) (io.ReadCloser, error) {
	file, ok := input.(*os.File)
	if !ok {
		return input, nil
	}
	fd, err := unix.Dup(int(file.Fd()))
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(fd)
	if err := unix.SetNonblock(fd, true); err != nil {
		unix.Close(fd)
		return nil, err
	}
	result := os.NewFile(uintptr(fd), "command guardian lifetime")
	_ = file.Close()
	return result, nil
}

// Register before creating a target. The socket remains owned until cleanup
// completes; loss of its supervisor is itself a reason to kill the target.
func registerFence(path string) (net.Conn, error) {
	conn, err := net.DialTimeout("unix", path, 5*time.Second)
	if err != nil {
		return nil, err
	}
	if err := registerConnection(conn); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

func registerConnection(conn net.Conn) error {
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	if _, err := conn.Write([]byte{'R'}); err != nil {
		return err
	}
	var reply [1]byte
	if _, err := io.ReadFull(conn, reply[:]); err != nil || reply[0] != 'A' {
		return errors.New("command fence refused registration")
	}
	return conn.SetDeadline(time.Time{})
}

// Match POSIX executable search without changing the target environment.
// Deno's execvp uses libc defaults only when PATH is absent; an explicitly
// empty component searches cwd. Go LookPath otherwise rejects relative PATH
// results and has no missing-PATH fallback.
func targetPath(name, search string, present bool) (string, error) {
	if name == "" {
		return "", errors.New("empty command")
	}
	if strings.ContainsRune(name, '/') {
		return name, nil
	}
	if !present {
		search = "/bin:/usr/bin"
		if runtime.GOOS == "darwin" {
			search = "/usr/bin:/bin"
		}
	}
	for _, directory := range strings.Split(search, ":") {
		candidate := filepath.Join(directory, name)
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() && unix.Faccessat(unix.AT_FDCWD, candidate, unix.X_OK, unix.AT_EACCESS) == nil {
			return filepath.Abs(candidate)
		}
	}
	return "", errors.New("command executable unavailable")
}

func targetCommand(path string, args []string, stdout, stderr io.Writer) *exec.Cmd {
	return &exec.Cmd{Path: path, Args: args, Stdout: stdout, Stderr: stderr, SysProcAttr: &syscall.SysProcAttr{Setpgid: true}}
}

func runCommand(invocation invocation, input io.ReadCloser, stdout, stderr io.Writer) (int, error) {
	args, grace := invocation.command, invocation.grace
	if err := prepareContainment(); err != nil {
		return 125, err
	}
	input, err := pollableInput(input)
	if err != nil {
		return 125, err
	}
	defer input.Close()
	fence, err := registerFence(invocation.fence)
	if err != nil {
		return 125, err
	}
	lostSupervisor := make(chan struct{})
	monitorDone := make(chan struct{})
	go func() { defer close(monitorDone); defer close(lostSupervisor); var b [1]byte; _, _ = fence.Read(b[:]) }()
	defer func() { _ = fence.Close(); <-monitorDone }()
	acknowledge := func() error {
		if err := fence.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return err
		}
		_, err := fence.Write([]byte{'C'})
		return err
	}
	select {
	case <-lostSupervisor:
		return 125, errors.Join(errors.New("command supervisor unavailable"), acknowledge())
	default:
	}
	search, present := os.LookupEnv("PATH")
	path, err := targetPath(args[0], search, present)
	if err != nil {
		return 125, errors.Join(err, acknowledge())
	}
	cmd := targetCommand(path, args, stdout, stderr)
	// nil stdin is /dev/null. ExtraFiles is empty: neither the lifetime pipe
	// nor private engine protocol descriptors can reach the command.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer signal.Stop(signals)
	err = cmd.Start()
	if errors.Is(err, syscall.ENOEXEC) {
		// execvp falls back to the shell for an executable text file with no shebang.
		cmd = targetCommand("/bin/sh", append([]string{args[0], path}, args[1:]...), stdout, stderr)
		err = cmd.Start()
	}
	if err != nil {
		return 125, errors.Join(err, acknowledge())
	}
	timer := time.NewTimer(grace)
	if !timer.Stop() {
		<-timer.C
	}
	defer timer.Stop()
	return finishSupervision(commandProcess{cmd}, input, signals, lostSupervisor, func() <-chan time.Time { timer.Reset(grace); return timer.C }, acknowledge)
}

func finishSupervision(process managedProcess, input io.ReadCloser, signals <-chan os.Signal, lostSupervisor <-chan struct{}, startGrace func() <-chan time.Time, acknowledge func() error) (int, error) {
	code, err := supervise(process, input, signals, lostSupervisor, startGrace)
	if err == nil {
		err = acknowledge()
	}
	return code, err
}

type reapResult struct {
	code int
	err  error
}

// Uncertain ownership never authorizes another signal. Keep one reaper, but
// let this guardian report failed supervision within its cleanup budget.
func reapWithin(process managedProcess, deadline <-chan time.Time) (int, error) {
	result := make(chan reapResult, 1)
	go func() { code, err := process.reap(); result <- reapResult{code, err} }()
	select {
	case reaped := <-result:
		return reaped.code, reaped.err
	case <-deadline:
		return 125, errors.New("command reap unconfirmed")
	}
}

// Keep the root waitable until the final group kill. Reaping first would let
// its PID/PGID be reused and could signal an unrelated process group.
func supervise(process managedProcess, input io.ReadCloser, signals <-chan os.Signal, lostSupervisor <-chan struct{}, startGrace func() <-chan time.Time) (int, error) {
	exited := make(chan error, 1)
	go func() { exited <- process.observeExit() }()
	control := make(chan struct{}, 1)
	lostOwner := make(chan struct{})
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer close(lostOwner)
		var b [1]byte
		for {
			n, err := input.Read(b[:])
			if n > 0 {
				select {
				case control <- struct{}{}:
				default:
				}
			}
			if err != nil {
				return
			}
		}
	}()
	defer func() { _ = input.Close(); <-readerDone }()
	var deadline <-chan time.Time
	var observation error
	observed := false
waiting:
	for {
		select {
		case observation = <-exited:
			if observation != nil {
				// A failed observer cannot prove that this PID remains ours.
				// Do not signal its group or acknowledge clean containment.
				timer := time.NewTimer(5 * time.Second)
				code, reapError := reapWithin(process, timer.C)
				timer.Stop()
				return code, errors.Join(observation, reapError)
			}
			observed = true
			break waiting
		case <-lostOwner:
			break waiting
		case <-lostSupervisor:
			break waiting
		case <-deadline:
			break waiting
		case <-control:
			if deadline == nil {
				_ = process.signalGroup(syscall.SIGTERM)
				deadline = startGrace()
			}
		case <-signals:
			if deadline == nil {
				_ = process.signalGroup(syscall.SIGTERM)
				deadline = startGrace()
			}
		}
	}
	killError := process.signalGroup(syscall.SIGKILL)
	if !observed {
		observation = <-exited
	}
	code, reapError := process.reap()
	confirmationError := process.confirmExit()
	return code, errors.Join(observation, killError, reapError, confirmationError)
}
