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
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	servecontract "github.com/swamp-club/swamp/packages/serve-go"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

const MaxColdWaiters = 64
const MaxSessions = 128

type Config struct {
	StartupTimeout time.Duration
	ControlTimeout time.Duration
	IdleTimeout    time.Duration
	DrainTimeout   time.Duration
	Cooldown       time.Duration
	// PageIdleGrace keeps an engine up this long after its last dashboard
	// session closes, so page navigation does not cold-start it each time.
	PageIdleGrace time.Duration
}

func DefaultConfig() Config {
	return Config{StartupTimeout: 30 * time.Second, ControlTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, DrainTimeout: 30 * time.Second, Cooldown: 5 * time.Second}
}

type Snapshot struct {
	Implementation  string `json:"implementation"`
	Profile         string `json:"profile"`
	ProtocolVersion int    `json:"protocolVersion"`
	State           string `json:"state"`
	Ready           bool   `json:"ready"`
	Generation      string `json:"generation,omitempty"`
	Starts          uint64 `json:"starts"`
}
type Status struct {
	State              string `json:"state"`
	Sessions           int    `json:"sessions"`
	Requests           int    `json:"requests"`
	Runs               int    `json:"runs"`
	Reservations       int    `json:"reservations"`
	PendingWrites      int    `json:"pendingWrites"`
	AuthenticationWork int    `json:"authenticationWork"`
}

func (s Status) Idle() bool {
	return s.Sessions == 0 && s.WorkIdle()
}
func (s Status) WorkIdle() bool {
	return s.Requests == 0 && s.Runs == 0 && s.Reservations == 0 && s.PendingWrites == 0
}

// Supervisor owns admission and process generations, while the engine decides
// whether domain work and persistence are quiescent.
type Supervisor struct {
	config          Config
	start           Starter
	handshake       Handshake
	gate            admissionGate
	mu              sync.Mutex
	client          *Client
	state           string
	validated       bool
	starting        chan struct{}
	startCancel     context.CancelFunc
	launching       *Client
	startError      error
	waiters         int
	starts          uint64
	cooldownUntil   time.Time
	idleSince       time.Time
	sessions        int
	pageSessions    int
	lastPageClose   time.Time
	draining        bool
	cleanupError    error
	uncertain       *Client
	shutdownContext context.Context
}

// Admission waits honor the shutdown deadline without leaving a goroutine
// behind waiting on a sync.RWMutex. Waiting lifecycle controls take priority.
type admissionGate struct {
	mu      sync.Mutex
	readers int
	writer  bool
	waiting int
	changed chan struct{}
}

func (g *admissionGate) acquire(ctx context.Context, write bool) error {
	g.mu.Lock()
	if write {
		g.waiting++
	}
	for {
		if err := ctx.Err(); err != nil {
			if write {
				g.waiting--
				g.notify()
			}
			g.mu.Unlock()
			return err
		}
		if !g.writer && ((write && g.readers == 0) || (!write && g.waiting == 0)) {
			if write {
				g.waiting--
				g.writer = true
			} else {
				g.readers++
			}
			g.mu.Unlock()
			return nil
		}
		if g.changed == nil {
			g.changed = make(chan struct{})
		}
		changed := g.changed
		g.mu.Unlock()
		select {
		case <-ctx.Done():
		case <-changed:
		}
		g.mu.Lock()
	}
}

// notify is called with mu held.
func (g *admissionGate) notify() {
	if g.changed != nil {
		close(g.changed)
		g.changed = nil
	}
}

func (g *admissionGate) release(write bool) {
	g.mu.Lock()
	if write {
		g.writer = false
	} else {
		g.readers--
	}
	g.notify()
	g.mu.Unlock()
}

// Handshake admits a freshly started generation before it serves anything.
type Handshake func(context.Context, *Client) error

// LocalHandshake admits a local-v1 engine; a non-empty repo must be the
// repository the engine reports it bound, so a hub never routes to the wrong one.
func LocalHandshake(repo string) Handshake {
	return func(ctx context.Context, c *Client) error {
		var hello struct {
			Version                 int      `json:"version"`
			Profile                 string   `json:"profile"`
			Operations              []string `json:"operations"`
			EngineVersion           string   `json:"engineVersion"`
			GitSHA                  string   `json:"gitSha"`
			CallerSessionIDs        bool     `json:"callerSessionIds"`
			AuthenticationDeadlines bool     `json:"authenticationDeadlines"`
			Repo                    struct {
				Path string `json:"path"`
			} `json:"repo"`
		}
		if err := c.Call(ctx, "hello", map[string]string{"profile": "local-v1"}, &hello); err != nil {
			return err
		}
		if hello.Version != protocol.Version || hello.Profile != "local-v1" || !hello.CallerSessionIDs || !hello.AuthenticationDeadlines || !supportsProfile(hello.Operations) {
			return protocol.ErrVersion
		}
		if repo != "" && hello.Repo.Path != repo {
			return ErrRepositoryMismatch
		}
		return nil
	}
}

// HubHandshake admits a workspace engine for the hub: it must serve dashboard
// pages, bind the selected repository, and load extensions only if trusted.
func HubHandshake(repo string, extensions bool) Handshake {
	return func(ctx context.Context, c *Client) error {
		var hello struct {
			Version                 int           `json:"version"`
			Profile                 string        `json:"profile"`
			Operations              []string      `json:"operations"`
			CallerSessionIDs        bool          `json:"callerSessionIds"`
			AuthenticationDeadlines bool          `json:"authenticationDeadlines"`
			CallerClasses           []CallerClass `json:"callerClasses"`
			Mode                    string        `json:"mode"`
			Extensions              *bool         `json:"extensions"`
			Repo                    struct {
				Path string `json:"path"`
			} `json:"repo"`
		}
		if err := c.Call(ctx, "hello", map[string]interface{}{"profile": "local-v1", "pages": true}, &hello); err != nil {
			return err
		}
		info := EngineInfo{Mode: hello.Mode, CallerClasses: hello.CallerClasses, Extensions: hello.Extensions != nil && *hello.Extensions}
		if hello.Version != protocol.Version || hello.Profile != "local-v1" || !hello.CallerSessionIDs || !hello.AuthenticationDeadlines || hello.Extensions == nil || !info.Serves(ClassPage) {
			return protocol.ErrVersion
		}
		switch info.Mode {
		case "full":
			if !info.Serves(ClassCLI) || !supportsProfile(hello.Operations) {
				return protocol.ErrVersion
			}
		case "read-only":
			if info.Serves(ClassCLI) {
				return protocol.ErrVersion
			}
		default:
			return protocol.ErrVersion
		}
		if hello.Repo.Path != repo {
			return ErrRepositoryMismatch
		}
		if info.Extensions != extensions {
			return ErrExtensionsMismatch
		}
		c.info.Store(&info)
		return nil
	}
}

func NewSupervisor(config Config, start Starter) *Supervisor {
	return NewSupervisorWith(config, start, LocalHandshake(""))
}

func NewSupervisorWith(config Config, start Starter, handshake Handshake) *Supervisor {
	return &Supervisor{config: config, start: start, handshake: handshake, state: "stopped"}
}

// Call sends one private control to the current generation, starting it if
// needed. Lifecycle controls stay internal to the supervisor.
func (s *Supervisor) Call(ctx context.Context, method string, params, result interface{}) error {
	if err := s.gate.acquire(ctx, false); err != nil {
		return err
	}
	defer s.gate.release(false)
	c, err := s.ensure(ctx)
	if err != nil {
		return err
	}
	return c.Call(ctx, method, params, result)
}

// Activity reports what an eviction decision needs without waking the engine.
type Activity struct {
	Running  bool
	Sessions int
}

func (s *Supervisor) Activity() Activity {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Activity{Running: s.client != nil || s.starting != nil, Sessions: s.sessions}
}

// Reset is the operator's acknowledgement that the commands of an unconfirmed
// generation have stopped; it never discards a live or starting generation.
func (s *Supervisor) Reset() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.draining || s.client != nil || s.starting != nil {
		return ErrUnavailable
	}
	s.cleanupError, s.uncertain = nil, nil
	s.cooldownUntil = time.Time{}
	s.state = "stopped"
	return nil
}

// QuiesceIdle stops an idle generation now instead of after the idle grace;
// the engine still decides whether its work is quiescent.
func (s *Supervisor) QuiesceIdle(ctx context.Context) error {
	return s.tick(ctx, time.Now(), true)
}
func (s *Supervisor) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.state
	if s.client != nil {
		select {
		case <-s.client.Done():
			if state == "ready" {
				state = "broken"
			}
		default:
			if state == "ready" && s.client.Retiring() {
				state = "retiring"
			}
		}
	}
	ready := s.validated && (state == "ready" || state == "stopped") && !s.draining
	result := Snapshot{Implementation: "go", Profile: "local-v1", ProtocolVersion: protocol.Version, State: state, Ready: ready, Starts: s.starts}
	if s.client != nil {
		result.Generation = s.client.generation
	}
	return result
}
func (s *Supervisor) Validate(ctx context.Context) error { _, err := s.ensure(ctx); return err }
func (s *Supervisor) ensure(ctx context.Context) (*Client, error) {
	s.mu.Lock()
	if s.cleanupError != nil {
		err := s.cleanupError
		s.mu.Unlock()
		return nil, err
	}
	if s.draining {
		s.mu.Unlock()
		return nil, ErrUnavailable
	}
	if s.client != nil {
		select {
		case <-s.client.Done():
			// Do not replace a failed generation until the OS has reaped it.
			select {
			case <-s.client.finished:
				if err := s.client.Wait(); err != nil {
					s.cleanupError = err
					s.state = "broken"
					s.mu.Unlock()
					return nil, err
				}
			default:
				s.mu.Unlock()
				return nil, ErrUnavailable
			}
			s.client = nil
			s.state = "cooldown"
			s.cooldownUntil = time.Now().Add(s.config.Cooldown)
		default:
			c := s.client
			s.mu.Unlock()
			if c.Retiring() {
				return nil, ErrRetiring
			}
			return c, nil
		}
	}
	if time.Now().Before(s.cooldownUntil) {
		s.mu.Unlock()
		return nil, ErrUnavailable
	}
	if s.waiters >= MaxColdWaiters {
		s.mu.Unlock()
		return nil, ErrBusy
	}
	if s.starting == nil {
		s.starting = make(chan struct{})
		startup, cancel := context.WithTimeout(context.Background(), s.config.StartupTimeout)
		s.startCancel = cancel
		s.state = "starting"
		s.starts++
		go s.launch(startup, s.starting)
	}
	ready := s.starting
	s.waiters++
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.waiters--; s.mu.Unlock() }()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-ready:
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.startError != nil {
		return nil, s.startError
	}
	if s.draining || s.client == nil {
		return nil, ErrUnavailable
	}
	return s.client, nil
}
func (s *Supervisor) launch(ctx context.Context, ready chan struct{}) {
	var c *Client
	p, err := s.start(ctx)
	if err == nil {
		var nonce [16]byte
		if _, err = rand.Read(nonce[:]); err == nil {
			s.mu.Lock()
			if s.draining || ctx.Err() != nil {
				err = ErrUnavailable
			} else {
				c = NewClient(hex.EncodeToString(nonce[:]), p)
				s.launching = c
			}
			s.mu.Unlock()
			if c == nil {
				c = NewClient("unadmitted", p)
			}
			if err == nil && c != nil {
				err = s.handshake(ctx, c)
			}
		} else {
			c = NewClient("unadmitted", p)
		}
	}
	if err != nil && c != nil {
		cleanupContext := s.startCleanupContext(ctx)
		c.SetCleanupDeadline(cleanupContext)
		c.Stop()
		cleanup := c.WaitContext(cleanupContext)
		s.retainUnconfirmed(c, cleanup)
		err = errors.Join(err, cleanup)
		c = nil
	}
	s.mu.Lock()
	if s.draining && c != nil {
		cleanupContext := s.shutdownContext
		s.mu.Unlock()
		c.Stop()
		c.SetCleanupDeadline(cleanupContext)
		cleanup := c.WaitContext(cleanupContext)
		s.retainUnconfirmed(c, cleanup)
		c = nil
		err = errors.Join(ErrUnavailable, cleanup)
		s.mu.Lock()
	}
	if s.startCancel != nil {
		s.startCancel()
		s.startCancel = nil
	}
	s.launching = nil
	s.client = c
	s.startError = err
	s.starting = nil
	if err != nil {
		s.state = "cooldown"
		s.cooldownUntil = time.Now().Add(s.config.Cooldown)
		if errors.Is(err, ErrUnconfirmedCommandCleanup) {
			s.cleanupError = ErrUnconfirmedCommandCleanup
			s.state = "broken"
		}
	} else {
		s.state = "ready"
		s.validated = true
	}
	close(ready)
	s.mu.Unlock()
}
func (s *Supervisor) Open(ctx context.Context, credential, ip string) (*Session, error) {
	return s.OpenAs(ctx, OpenRequest{Class: ClassCLI, Credential: credential, SourceIP: ip})
}

// Info starts the generation if needed and reports what its hello offered.
func (s *Supervisor) Info(ctx context.Context) (EngineInfo, error) {
	if err := s.gate.acquire(ctx, false); err != nil {
		return EngineInfo{}, err
	}
	defer s.gate.release(false)
	c, err := s.ensure(ctx)
	if err != nil {
		return EngineInfo{}, err
	}
	return c.Info(), nil
}

func (s *Supervisor) OpenAs(ctx context.Context, request OpenRequest) (*Session, error) {
	if err := s.gate.acquire(ctx, false); err != nil {
		return nil, err
	}
	defer s.gate.release(false)
	s.mu.Lock()
	if s.sessions >= MaxSessions {
		s.mu.Unlock()
		return nil, ErrBusy
	}
	s.sessions++
	if request.Class == ClassPage {
		s.pageSessions++
	}
	s.idleSince = time.Time{}
	s.mu.Unlock()
	c, err := s.ensure(ctx)
	if err == nil {
		var session *Session
		authentication, cancelAuthentication := context.WithTimeout(ctx, s.config.ControlTimeout)
		session, err = c.OpenAs(authentication, request)
		cancelAuthentication()
		if err == nil {
			return session, nil
		}
	}
	s.mu.Lock()
	s.release(request.Class)
	s.mu.Unlock()
	return nil, err
}

// release is called with mu held.
func (s *Supervisor) release(class CallerClass) {
	s.sessions--
	if class == ClassPage {
		s.pageSessions--
		if s.pageSessions == 0 {
			s.lastPageClose = time.Now()
		}
	}
}
func (s *Supervisor) Close(ctx context.Context, session *Session) error {
	// Closing cannot admit domain work, so it must not wait behind the idle or
	// shutdown gate. Local accounting is released even if the caller expired;
	// Client retains the remote slot until its reserved cleanup is acknowledged.
	var err error
	session.released.Do(func() {
		defer func() { s.mu.Lock(); s.release(session.Class); s.mu.Unlock() }()
		err = session.Close(ctx)
	})
	return err
}
func (s *Supervisor) Dispatch(ctx context.Context, session *Session, request []byte) error {
	if err := s.gate.acquire(ctx, false); err != nil {
		return err
	}
	defer s.gate.release(false)
	s.mu.Lock()
	draining := s.draining
	s.mu.Unlock()
	if draining {
		return ErrUnavailable
	}
	return session.Dispatch(ctx, request)
}

// Tick is explicit for deterministic tests; Run supplies the production clock.
func (s *Supervisor) Tick(ctx context.Context, now time.Time) error {
	return s.tick(ctx, now, false)
}

func (s *Supervisor) tick(ctx context.Context, now time.Time, force bool) error {
	// Avoid queuing a writer ahead of public admission when no idle decision
	// is possible. Repeat the checks after acquiring the gate to close races.
	idleDisabled := s.config.IdleTimeout == 0 && !force
	s.mu.Lock()
	skip := s.draining || s.client == nil || (!s.client.Retiring() && (idleDisabled || s.sessions != 0 || s.inPageGrace(now, force)))
	if skip {
		s.idleSince = time.Time{}
	}
	s.mu.Unlock()
	if skip {
		return nil
	}
	if err := s.gate.acquire(ctx, true); err != nil {
		return err
	}
	defer s.gate.release(true)
	s.mu.Lock()
	c := s.client
	if s.draining || c == nil || (!c.Retiring() && (idleDisabled || s.sessions != 0 || s.inPageGrace(now, force))) {
		s.idleSince = time.Time{}
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	var status Status
	probe, cancelProbe := context.WithTimeout(ctx, s.config.ControlTimeout)
	err := c.Call(probe, "engine.status", struct{}{}, &status)
	cancelProbe()
	if err != nil {
		s.mu.Lock()
		s.idleSince = time.Time{}
		s.mu.Unlock()
		return err
	}
	s.mu.Lock()
	retiring := status.State == "retiring"
	if retiring {
		c.retiring.Store(true)
	}
	if (!retiring && !status.Idle()) || (retiring && !status.WorkIdle()) {
		s.idleSince = time.Time{}
		s.mu.Unlock()
		return nil
	}
	if !retiring && !force && s.idleSince.IsZero() {
		s.idleSince = now
		s.mu.Unlock()
		return nil
	}
	if !retiring && !force && now.Sub(s.idleSince) < s.config.IdleTimeout {
		s.mu.Unlock()
		return nil
	}
	s.state = "quiescing"
	s.mu.Unlock()
	var result struct {
		Quiescent bool `json:"quiescent"`
	}
	// Quiesce flushes persistence. Give it a fresh drain budget, independent
	// of the read-only probe and of Run cancellation during normal shutdown.
	// Shutdown still enforces its own overall deadline and can fence the child.
	drain, cancelDrain := context.WithTimeout(context.WithoutCancel(ctx), s.config.DrainTimeout)
	defer cancelDrain()
	err = c.Call(drain, "engine.quiesce", map[string]int64{"deadlineMs": engineDeadline(drain, s.config.DrainTimeout)}, &result)
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		// This is the supervisor's deliberate idle-drain deadline, not a public
		// request timeout. Fence a generation whose persistence drain exceeded it.
		c.SetCleanupDeadline(drain)
		c.Stop()
		return errors.Join(err, s.completeClient(c, drain))
	}
	if err == nil && result.Quiescent {
		c.SetCleanupDeadline(drain)
		select {
		case <-c.Exited():
		case <-drain.Done():
			c.Stop()
			err = drain.Err()
		}
		return errors.Join(err, s.completeClient(c, drain))
	}
	s.mu.Lock()
	s.state = "ready"
	s.idleSince = time.Time{}
	s.mu.Unlock()
	return err
}

// inPageGrace is called with mu held. Forced eviction ignores the grace.
func (s *Supervisor) inPageGrace(now time.Time, force bool) bool {
	return !force && s.config.PageIdleGrace > 0 && !s.lastPageClose.IsZero() && now.Sub(s.lastPageClose) < s.config.PageIdleGrace
}

func (s *Supervisor) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			_ = s.Tick(ctx, now)
		}
	}
}
func (s *Supervisor) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	s.draining = true
	s.shutdownContext = ctx
	s.state = "draining"
	starting := s.starting
	if s.startCancel != nil {
		s.startCancel()
	}
	s.mu.Unlock()
	if starting != nil {
		select {
		case <-starting:
		case <-ctx.Done():
			s.stopCurrent(ctx)
			return ctx.Err()
		}
	}
	if err := s.gate.acquire(ctx, true); err != nil {
		s.stopCurrent(ctx)
		return err
	}
	defer s.gate.release(true)
	s.mu.Lock()
	c := s.client
	if c == nil {
		if s.cleanupError == nil {
			s.state = "stopped"
		}
	}
	cleanup := s.cleanupError
	s.mu.Unlock()
	if c == nil {
		return cleanup
	}
	deadline := s.config.DrainTimeout
	if until, ok := ctx.Deadline(); ok && time.Until(until) < deadline {
		deadline = time.Until(until)
	}
	c.SetCleanupDeadline(ctx)
	err := c.Call(ctx, "engine.shutdown", map[string]int64{"deadlineMs": engineDeadline(ctx, deadline)}, nil)
	select {
	case <-c.Exited():
	case <-ctx.Done():
		c.Stop()
		err = errors.Join(err, ctx.Err())
	}
	return errors.Join(err, s.completeClient(c, ctx))
}

// Every path that discards a generation preserves an unconfirmed cleanup proof.
// A transport EOF or a reaped engine alone cannot authorize replacement work.
func (s *Supervisor) completeClient(c *Client, ctx context.Context) error {
	err := c.WaitContext(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.cleanupError = err
		s.uncertain = c
	}
	if s.client == c {
		s.client = nil
		s.idleSince = time.Time{}
		s.state = "stopped"
	}
	if s.cleanupError != nil {
		s.state = "broken"
	}
	return err
}

func (s *Supervisor) retainUnconfirmed(c *Client, err error) {
	if err == nil {
		return
	}
	s.mu.Lock()
	s.cleanupError, s.uncertain, s.state = err, c, "broken"
	s.mu.Unlock()
}

func (s *Supervisor) startCleanupContext(startup context.Context) context.Context {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.shutdownContext != nil {
		return s.shutdownContext
	}
	return startup
}

// Keep a bounded margin for the final response and process exit after the
// engine's own persistence deadline, including when the configured budget is tiny.
func engineDeadline(ctx context.Context, maximum time.Duration) int64 {
	remaining := maximum
	if deadline, ok := ctx.Deadline(); ok {
		remaining = min(remaining, time.Until(deadline))
	}
	remaining = max(0, remaining)
	margin := min(remaining/2, max(time.Second, remaining/10))
	return (remaining - margin).Milliseconds()
}

// A deadline must fence the child even when an earlier Open/Dispatch still
// owns admission. Copy the handles under mu; process reaping never holds mu.
func (s *Supervisor) stopCurrent(ctx context.Context) {
	s.mu.Lock()
	client, launching, uncertain := s.client, s.launching, s.uncertain
	s.mu.Unlock()
	for _, c := range []*Client{client, launching, uncertain} {
		if c != nil {
			c.SetCleanupDeadline(ctx)
			c.Stop()
			_ = s.completeClient(c, ctx)
		}
	}
	s.mu.Lock()
	if s.client == client {
		s.client = nil
	}
	if s.starting == nil && s.cleanupError == nil {
		s.state = "stopped"
	}
	s.mu.Unlock()
}

// Additive capabilities are compatible, but a pair missing a required public
// operation must fail startup before the gateway reports readiness.
func supportsProfile(operations []string) bool {
	offered := make(map[string]bool, len(operations))
	for _, operation := range operations {
		offered[operation] = true
	}
	for _, operation := range servecontract.Operations() {
		if !offered[operation] {
			return false
		}
	}
	return true
}
