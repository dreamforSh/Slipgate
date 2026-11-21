package vmslot

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
)

const (
	LocalNodeID       = "local-node"
	terminalTicketTTL = 5 * time.Minute
)

var (
	ErrTicketNotFound = errors.New("vmslot: terminal ticket invalid or expired")
)

// CoordinatorOptions configures the top-level VM fleet coordinator.
type CoordinatorOptions struct {
	Manager   *Manager
	ClashPool *clashpool.Manager
	Store     VmStore
	VMDataDir string
	GuestdBin string
	Logger    *log.Logger
}

// Overview summarizes the entire VM-Slot fleet, cluster hosts, migration log, and enforced invariants.
type Overview struct {
	Nodes      []ClusterNode      `json:"nodes"`
	Slots      []Slot             `json:"slots"`
	Migrations []MigrationJob     `json:"migrations"`
	Invariants OverviewInvariants `json:"invariants"`
	Runtime    OverviewRuntime    `json:"runtime"`
}

type OverviewInvariants struct {
	OneSlotOneEgress    bool `json:"oneSlotOneEgress"`
	MaxSubagentsDefault int  `json:"maxSubagentsDefault"`
	ZeroPromptInjection bool `json:"zeroPromptInjection"`
}

type OverviewRuntime struct {
	VMDataDir       string `json:"vmDataDir"`
	GuestdBin       string `json:"guestdBin"`
	GuestdAvailable bool   `json:"guestdAvailable"`
	LocalNodeID     string `json:"localNodeId"`
}

// RegisterClusterNodeInput defines inputs for creating/updating a remote agentless SSH node.
type RegisterClusterNodeInput struct {
	ID            string            `json:"id,omitempty"`
	Name          string            `json:"name"`
	DriverKind    string            `json:"driverKind,omitempty"` // "ssh" | "local"
	SSHAddr       string            `json:"sshAddr"`
	SSHUser       string            `json:"sshUser,omitempty"`
	SSHKeyPEM     string            `json:"sshKeyPem,omitempty"`
	Arch          string            `json:"arch,omitempty"`
	KVMCapable    bool              `json:"kvmCapable"`
	DockerCapable bool              `json:"dockerCapable"`
	MaxSlots      int               `json:"maxSlots,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
}

// ProvisionSlotInput configures VM slot creation bound strictly to one Clash exit.
type ProvisionSlotInput struct {
	ID             string           `json:"slotId,omitempty"`
	ClusterNodeID  string           `json:"clusterNodeId,omitempty"`
	AccountID      string           `json:"accountId"`
	ClashNodeID    string           `json:"clashNodeId,omitempty"`
	HypervisorKind HypervisorKind   `json:"hypervisorKind,omitempty"`
	MaxSubagents   uint32           `json:"maxSubagents,omitempty"`
	MemoryMiB      uint32           `json:"memoryMiB,omitempty"`
	TelemetryMode  TelemetryMode    `json:"telemetryMode,omitempty"`
	CleanseMode    string           `json:"cleanseMode,omitempty"`
	Timezone       string           `json:"timezone,omitempty"`
	DoHURL         string           `json:"dohUrl,omitempty"`
	CPUModel       string           `json:"cpuModel,omitempty"`
	CPUCores       uint32           `json:"cpuCores,omitempty"`
	Persona        *HardwarePersona `json:"persona,omitempty"`
}

// UpdateSeedInput updates sanitized settings/env/bootstrap artifacts pushed into a slot.
type UpdateSeedInput struct {
	SettingsJSONRaw      *string `json:"settingsJsonRaw,omitempty"`
	CustomSettingRaw     *string `json:"customSettingRaw,omitempty"`
	ProxyEnvRaw          *string `json:"proxyEnvRaw,omitempty"`
	BootstrapScriptRaw   *string `json:"bootstrapScriptRaw,omitempty"`
	RejectClientSettings *bool   `json:"rejectClientSettings,omitempty"`
	RejectClientIdentity *bool   `json:"rejectClientIdentity,omitempty"`
}

// TerminalTicket grants single-use WebSocket access to a slot's diagnostic console.
type TerminalTicket struct {
	Ticket    string    `json:"ticket"`
	SlotID    string    `json:"slotId"`
	Actor     string    `json:"actor"`
	WSPath    string    `json:"wsPath"`
	ExpiresAt time.Time `json:"expiresAtIso"`
}

// Coordinator ties VM-slot lifecycle, Clash egress enforcement, PG/memory persistence, and OS drivers together.
type Coordinator struct {
	mgr       *Manager
	clashPool *clashpool.Manager
	store     VmStore
	localDrv  *LocalSlotDriver
	sshDrv    *AgentlessSSHDriver
	logger    *log.Logger

	ticketMu sync.Mutex
	tickets  map[string]TerminalTicket
}

func NewCoordinator(opts CoordinatorOptions) *Coordinator {
	if opts.Store == nil {
		opts.Store = NewMemoryVmStore()
	}
	if opts.Manager == nil {
		opts.Manager = NewManager(opts.ClashPool)
	}
	if opts.Logger == nil {
		opts.Logger = log.Default()
	}
	return &Coordinator{
		mgr:       opts.Manager,
		clashPool: opts.ClashPool,
		store:     opts.Store,
		localDrv:  NewLocalSlotDriver(opts.VMDataDir, opts.GuestdBin),
		sshDrv:    NewAgentlessSSHDriver(),
		logger:    opts.Logger,
		tickets:   make(map[string]TerminalTicket),
	}
}

// Bootstrap initializes backing store, registers local-node, and restores persisted VM slots.
func (c *Coordinator) Bootstrap(ctx context.Context) error {
	if err := c.store.Init(ctx); err != nil {
		return err
	}

	localNode := ClusterNode{
		ID:            LocalNodeID,
		Name:          "Local Control Node",
		DriverKind:    "local",
		SSHAddr:       "127.0.0.1:22",
		SSHUser:       "slipgate",
		Arch:          normalizeArch(runtime.GOARCH),
		KVMCapable:    runtime.GOOS == "linux",
		DockerCapable: true,
		Status:        "online",
		MaxSlots:      32,
		Labels:        map[string]string{"builtin": "true", "os": runtime.GOOS},
	}
	if existing, err := c.store.GetClusterNode(ctx, LocalNodeID); err == nil {
		localNode.CreatedAt = existing.CreatedAt
	}
	if err := c.store.UpsertClusterNode(ctx, localNode); err != nil {
		return fmt.Errorf("vmslot: ensure local-node: %w", err)
	}

	slots, err := c.store.ListSlots(ctx)
	if err != nil {
		return fmt.Errorf("vmslot: restore persisted slots: %w", err)
	}
	for _, s := range slots {
		c.mgr.UpsertRestoredSlot(s)
	}
	return nil
}

// Shutdown stops locally spawned slipgate-guestd processes cleanly.
func (c *Coordinator) Shutdown() {
	for _, s := range c.mgr.Snapshot() {
		_ = c.localDrv.StopSlot(context.Background(), ClusterNode{ID: s.ClusterNodeID}, s)
	}
}

func (c *Coordinator) Overview(ctx context.Context) (Overview, error) {
	nodes, err := c.store.ListClusterNodes(ctx)
	if err != nil {
		return Overview{}, err
	}
	if nodes == nil {
		nodes = []ClusterNode{}
	}
	migrations, err := c.store.ListMigrations(ctx)
	if err != nil {
		return Overview{}, err
	}
	if migrations == nil {
		migrations = []MigrationJob{}
	}
	return Overview{
		Nodes:      nodes,
		Slots:      c.mgr.Snapshot(),
		Migrations: migrations,
		Invariants: OverviewInvariants{
			OneSlotOneEgress:    true,
			MaxSubagentsDefault: 20,
			ZeroPromptInjection: true,
		},
		Runtime: OverviewRuntime{
			VMDataDir:       c.localDrv.vmDataDir,
			GuestdBin:       c.localDrv.guestdBin,
			GuestdAvailable: c.localDrv.GuestdAvailable(),
			LocalNodeID:     LocalNodeID,
		},
	}, nil
}

func (c *Coordinator) ListClusterNodes(ctx context.Context) ([]ClusterNode, error) {
	nodes, err := c.store.ListClusterNodes(ctx)
	if err != nil {
		return nil, err
	}
	if nodes == nil {
		return []ClusterNode{}, nil
	}
	return nodes, nil
}

func (c *Coordinator) RegisterClusterNode(ctx context.Context, in RegisterClusterNodeInput) (ClusterNode, error) {
	in.Name = strings.TrimSpace(in.Name)
	in.SSHAddr = strings.TrimSpace(in.SSHAddr)
	if in.Name == "" || in.SSHAddr == "" {
		return ClusterNode{}, errors.New("vmslot: node name and sshAddr are required")
	}
	id := strings.TrimSpace(in.ID)
	if id == "" {
		id = "node-" + randomHex(4)
	}
	driverKind := strings.ToLower(strings.TrimSpace(in.DriverKind))
	if driverKind == "" {
		if id == LocalNodeID {
			driverKind = "local"
		} else {
			driverKind = "ssh"
		}
	}
	if driverKind != "local" && driverKind != "ssh" {
		return ClusterNode{}, fmt.Errorf("vmslot: unsupported driverKind %q", driverKind)
	}
	arch := normalizeArch(in.Arch)
	maxSlots := in.MaxSlots
	if maxSlots <= 0 {
		maxSlots = 16
	}
	node := ClusterNode{
		ID:            id,
		Name:          in.Name,
		DriverKind:    driverKind,
		SSHAddr:       in.SSHAddr,
		SSHUser:       defaultIfEmpty(in.SSHUser, "root"),
		SSHKeyPEM:     in.SSHKeyPEM,
		HasSSHKey:     strings.TrimSpace(in.SSHKeyPEM) != "",
		Arch:          arch,
		KVMCapable:    in.KVMCapable,
		DockerCapable: in.DockerCapable || !in.KVMCapable,
		Status:        "online",
		MaxSlots:      maxSlots,
		Labels:        in.Labels,
	}
	if err := c.store.UpsertClusterNode(ctx, node); err != nil {
		return ClusterNode{}, err
	}
	return c.store.GetClusterNode(ctx, node.ID)
}

func (c *Coordinator) DeleteClusterNode(ctx context.Context, nodeID string) error {
	if nodeID == LocalNodeID {
		return ErrClusterNodeProtected
	}
	for _, s := range c.mgr.Snapshot() {
		if s.ClusterNodeID == nodeID {
			return fmt.Errorf("%w: active slot %s resides on node", ErrClusterNodeProtected, s.ID)
		}
	}
	return c.store.DeleteClusterNode(ctx, nodeID)
}

func (c *Coordinator) ListSlots() []Slot {
	return c.mgr.Snapshot()
}

func (c *Coordinator) ProvisionSlot(ctx context.Context, in ProvisionSlotInput) (Slot, error) {
	in.AccountID = strings.TrimSpace(in.AccountID)
	in.ClusterNodeID = strings.TrimSpace(in.ClusterNodeID)
	in.ClashNodeID = strings.TrimSpace(in.ClashNodeID)

	if in.AccountID == "" {
		return Slot{}, fmt.Errorf("%w: accountId is required", ErrInvalidHardwarePersona)
	}
	if in.ClusterNodeID == "" {
		in.ClusterNodeID = LocalNodeID
	}
	node, err := c.store.GetClusterNode(ctx, in.ClusterNodeID)
	if err != nil {
		return Slot{}, err
	}

	var targetPtr *clashpool.DialTarget
	if in.ClashNodeID == "" {
		if c.clashPool == nil {
			return Slot{}, ErrSlotEgressUnavailable
		}
		dialTarget, dialErr := c.clashPool.ResolveDialTarget(in.AccountID)
		if dialErr != nil {
			return Slot{}, fmt.Errorf("%w: %v", ErrSlotEgressUnavailable, dialErr)
		}
		in.ClashNodeID = dialTarget.NodeID
		targetPtr = &dialTarget
	} else if c.clashPool != nil {
		if clashNode, ok := c.clashPool.GetNode(in.ClashNodeID); ok {
			targetPtr = &clashpool.DialTarget{
				NodeID:        clashNode.ID,
				ProxySlotID:   clashNode.ProxySlotID,
				SOCKSAddr:     fmt.Sprintf("127.0.0.1:%d", clashNode.ListenerPort),
				SocksUsername: clashNode.SocksUsername,
				SocksPassword: clashNode.SocksPassword,
				ExitIP:        clashNode.ExitIP,
			}
		}
	}

	slotID := strings.TrimSpace(in.ID)
	if slotID == "" {
		slotID = "vm-" + randomHex(4)
	}

	var persona HardwarePersona
	if in.Persona != nil {
		persona = *in.Persona
	} else {
		persona, err = GeneratePersona(in.CPUModel, in.Timezone, in.DoHURL, in.CPUCores)
		if err != nil {
			return Slot{}, err
		}
	}

	hv := in.HypervisorKind
	if hv == "" {
		if node.KVMCapable {
			hv = HypervisorKVM
		} else {
			hv = HypervisorDocker
		}
	}
	tm := in.TelemetryMode
	if tm == "" {
		tm = TelemetryIsolated
	}
	cleanse := strings.TrimSpace(in.CleanseMode)
	if cleanse == "" {
		cleanse = "zero"
	}

	spec := Slot{
		ID:            slotID,
		ClusterNodeID: node.ID,
		AccountID:     in.AccountID,
		ClashNodeID:   in.ClashNodeID,
		Hypervisor:    hv,
		State:         StateProvisioning,
		MaxSubagents:  in.MaxSubagents,
		MemoryMiB:     in.MemoryMiB,
		Telemetry:     tm,
		CleanseMode:   cleanse,
		Persona:       persona,
	}

	slot, err := c.mgr.ProvisionSlot(spec)
	if err != nil {
		return Slot{}, err
	}

	seed := defaultSlotSeed(slot, targetPtr)
	drv := c.driverForNode(node)
	rollback := func() {
		_ = drv.DestroySlot(context.Background(), node, slot)
		_ = c.mgr.DeleteSlot(slot.ID)
	}

	slot, err = drv.MaterializeSlot(ctx, node, slot, seed, targetPtr)
	if err != nil {
		rollback()
		return Slot{}, err
	}
	slot, err = drv.StartSlot(ctx, node, slot)
	if err != nil {
		rollback()
		return Slot{}, err
	}
	startedState := slot.State
	if slot, err = c.mgr.UpdateGuestRuntime(slot.ID, slot.RootDir, slot.GuestUDSPath, slot.DaemonVersion, slot.GuestPID, slot.LastHeartbeat); err != nil {
		rollback()
		return Slot{}, err
	}
	if slot, err = c.mgr.SetState(slot.ID, startedState); err != nil {
		rollback()
		return Slot{}, err
	}
	if err := c.store.UpsertSlot(ctx, slot); err != nil {
		rollback()
		return Slot{}, err
	}
	if err := c.store.UpsertSeed(ctx, seed, "system"); err != nil {
		rollback()
		return Slot{}, err
	}
	return slot, nil
}

func (c *Coordinator) StartSlot(ctx context.Context, slotID string) (Slot, error) {
	slot, ok := c.mgr.GetSlot(slotID)
	if !ok {
		return Slot{}, ErrSlotNotFound
	}
	node, err := c.store.GetClusterNode(ctx, slot.ClusterNodeID)
	if err != nil {
		return Slot{}, err
	}
	drv := c.driverForNode(node)
	updated, err := drv.StartSlot(ctx, node, slot)
	if err != nil {
		return Slot{}, err
	}
	if updated, err = c.mgr.UpdateGuestRuntime(updated.ID, updated.RootDir, updated.GuestUDSPath, updated.DaemonVersion, updated.GuestPID, updated.LastHeartbeat); err != nil {
		return Slot{}, err
	}
	if updated, err = c.mgr.SetState(updated.ID, StateReady); err != nil {
		return Slot{}, err
	}
	_ = c.store.UpsertSlot(ctx, updated)
	return updated, nil
}

func (c *Coordinator) StopSlot(ctx context.Context, slotID string) (Slot, error) {
	slot, ok := c.mgr.GetSlot(slotID)
	if !ok {
		return Slot{}, ErrSlotNotFound
	}
	node, err := c.store.GetClusterNode(ctx, slot.ClusterNodeID)
	if err != nil {
		return Slot{}, err
	}
	if err := c.driverForNode(node).StopSlot(ctx, node, slot); err != nil {
		return Slot{}, err
	}
	updated, err := c.mgr.SetState(slot.ID, StateStopped)
	if err != nil {
		return Slot{}, err
	}
	_ = c.store.UpsertSlot(ctx, updated)
	return updated, nil
}

func (c *Coordinator) DeleteSlot(ctx context.Context, slotID string) error {
	slot, ok := c.mgr.GetSlot(slotID)
	if !ok {
		return ErrSlotNotFound
	}
	if node, err := c.store.GetClusterNode(ctx, slot.ClusterNodeID); err == nil {
		if destroyErr := c.driverForNode(node).DestroySlot(ctx, node, slot); destroyErr != nil {
			return destroyErr
		}
	}
	if err := c.mgr.DeleteSlot(slotID); err != nil {
		return err
	}
	return c.store.DeleteSlot(ctx, slotID)
}

func (c *Coordinator) GetSeed(ctx context.Context, slotID string) (SlotSeed, error) {
	slot, ok := c.mgr.GetSlot(slotID)
	if !ok {
		return SlotSeed{}, ErrSlotNotFound
	}
	seed, err := c.store.GetSeed(ctx, slotID)
	if err == nil {
		return seed, nil
	}
	if !errors.Is(err, ErrSeedNotFound) {
		return SlotSeed{}, err
	}
	seed = defaultSlotSeed(slot, nil)
	_ = c.store.UpsertSeed(ctx, seed, "system")
	return seed, nil
}

func (c *Coordinator) UpdateSeed(ctx context.Context, slotID string, in UpdateSeedInput, actor string) (SlotSeed, error) {
	slot, ok := c.mgr.GetSlot(slotID)
	if !ok {
		return SlotSeed{}, ErrSlotNotFound
	}
	current, err := c.GetSeed(ctx, slotID)
	if err != nil {
		return SlotSeed{}, err
	}
	if in.SettingsJSONRaw != nil {
		if !json.Valid([]byte(*in.SettingsJSONRaw)) {
			return SlotSeed{}, errors.New("vmslot: settingsJsonRaw must be valid JSON")
		}
		current.SettingsJSONRaw = *in.SettingsJSONRaw
	}
	if in.CustomSettingRaw != nil {
		current.CustomSettingRaw = *in.CustomSettingRaw
	}
	if in.ProxyEnvRaw != nil {
		current.ProxyEnvRaw = *in.ProxyEnvRaw
	}
	if in.BootstrapScriptRaw != nil {
		current.BootstrapScriptRaw = *in.BootstrapScriptRaw
	}
	if in.RejectClientSettings != nil {
		current.RejectClientSettings = *in.RejectClientSettings
	}
	if in.RejectClientIdentity != nil {
		current.RejectClientIdentity = *in.RejectClientIdentity
	}
	current.TelemetryMode = slot.Telemetry
	current.TelemetryDaemonRunning = slot.Telemetry == TelemetryIsolated
	current.SyncedAtUnixMs = time.Now().UTC().UnixMilli()

	if node, nErr := c.store.GetClusterNode(ctx, slot.ClusterNodeID); nErr == nil {
		if syncErr := c.driverForNode(node).SyncSeed(ctx, node, slot, current, nil); syncErr != nil {
			return SlotSeed{}, syncErr
		}
	}
	if err := c.store.UpsertSeed(ctx, current, actor); err != nil {
		return SlotSeed{}, err
	}
	return current, nil
}

func (c *Coordinator) UpdateTelemetry(ctx context.Context, slotID string, telemetryMode TelemetryMode, cleanseMode string) (Slot, error) {
	if telemetryMode != "" && telemetryMode != TelemetryEnabled && telemetryMode != TelemetryIsolated && telemetryMode != TelemetryDisabled {
		return Slot{}, fmt.Errorf("vmslot: invalid telemetryMode %q", telemetryMode)
	}
	if cleanseMode != "" && cleanseMode != "zero" && cleanseMode != "official" && cleanseMode != "template" {
		return Slot{}, fmt.Errorf("vmslot: invalid cleanseMode %q", cleanseMode)
	}
	updated, err := c.mgr.SetTelemetry(slotID, telemetryMode, cleanseMode)
	if err != nil {
		return Slot{}, err
	}
	_ = c.store.UpsertSlot(ctx, updated)

	if seed, seedErr := c.GetSeed(ctx, slotID); seedErr == nil {
		seed.TelemetryMode = updated.Telemetry
		seed.TelemetryDaemonRunning = updated.Telemetry == TelemetryIsolated
		seed.SyncedAtUnixMs = time.Now().UTC().UnixMilli()
		if node, nErr := c.store.GetClusterNode(ctx, updated.ClusterNodeID); nErr == nil {
			_ = c.driverForNode(node).SyncSeed(ctx, node, updated, seed, nil)
		}
		_ = c.store.UpsertSeed(ctx, seed, "telemetry-update")
	}
	return updated, nil
}

func (c *Coordinator) MigrateOrResizeSlot(ctx context.Context, slotID, targetClusterNodeID string, targetMemoryMiB uint32) (Slot, MigrationJob, error) {
	existing, ok := c.mgr.GetSlot(slotID)
	if !ok {
		return Slot{}, MigrationJob{}, ErrSlotNotFound
	}
	targetNode := strings.TrimSpace(targetClusterNodeID)
	if targetNode != "" {
		if _, err := c.store.GetClusterNode(ctx, targetNode); err != nil {
			return Slot{}, MigrationJob{}, err
		}
	} else {
		targetNode = existing.ClusterNodeID
	}

	now := time.Now().UTC()
	job := MigrationJob{
		ID:              "mig-" + randomHex(4),
		SlotID:          slotID,
		SourceNodeID:    existing.ClusterNodeID,
		TargetNodeID:    targetNode,
		TargetMemoryMiB: max(512, targetMemoryMiB),
		Status:          "completed",
		CreatedAt:       now,
		CompletedAt:     &now,
	}

	migrated, err := c.mgr.MigrateOrResizeSlot(slotID, targetNode, targetMemoryMiB)
	if err != nil {
		job.Status = "failed"
		job.ErrorMessage = err.Error()
		_ = c.store.RecordMigration(ctx, job)
		return Slot{}, job, err
	}

	if dstNode, nErr := c.store.GetClusterNode(ctx, migrated.ClusterNodeID); nErr == nil {
		seed, _ := c.GetSeed(ctx, migrated.ID)
		_, _ = c.driverForNode(dstNode).MaterializeSlot(ctx, dstNode, migrated, seed, nil)
	}
	_ = c.store.UpsertSlot(ctx, migrated)
	_ = c.store.RecordMigration(ctx, job)
	return migrated, job, nil
}

func (c *Coordinator) IssueTerminalTicket(slotID, actor string) (TerminalTicket, error) {
	if _, ok := c.mgr.GetSlot(slotID); !ok {
		return TerminalTicket{}, ErrSlotNotFound
	}
	token := randomHex(16)
	t := TerminalTicket{
		Ticket:    token,
		SlotID:    slotID,
		Actor:     defaultIfEmpty(actor, "admin"),
		WSPath:    "/ws/admin/vms/terminal/" + token,
		ExpiresAt: time.Now().UTC().Add(terminalTicketTTL),
	}
	c.ticketMu.Lock()
	c.sweepExpiredTicketsLocked(time.Now().UTC())
	c.tickets[token] = t
	c.ticketMu.Unlock()
	return t, nil
}

func (c *Coordinator) ConsumeTerminalTicket(ticket string) (TerminalTicket, error) {
	now := time.Now().UTC()
	c.ticketMu.Lock()
	defer c.ticketMu.Unlock()
	c.sweepExpiredTicketsLocked(now)
	t, ok := c.tickets[ticket]
	if !ok {
		return TerminalTicket{}, ErrTicketNotFound
	}
	delete(c.tickets, ticket)
	if now.After(t.ExpiresAt) {
		return TerminalTicket{}, ErrTicketNotFound
	}
	return t, nil
}

func (c *Coordinator) ExecSlotCommand(ctx context.Context, slotID, actor, command string) (DriverExecResult, error) {
	slot, ok := c.mgr.GetSlot(slotID)
	if !ok {
		return DriverExecResult{}, ErrSlotNotFound
	}
	node, err := c.store.GetClusterNode(ctx, slot.ClusterNodeID)
	if err != nil {
		return DriverExecResult{}, err
	}
	seed, _ := c.GetSeed(ctx, slotID)
	res, err := c.driverForNode(node).ExecTerminalCommand(ctx, node, slot, seed, command)
	preview := strings.TrimSpace(command)
	if len(preview) > 120 {
		preview = preview[:120]
	}
	_ = c.store.RecordTerminalAudit(ctx, TerminalAuditEntry{
		SlotID:         slotID,
		Actor:          defaultIfEmpty(actor, "admin"),
		CommandPreview: preview,
		ExitCode:       res.ExitCode,
	})
	return res, err
}

func (c *Coordinator) sweepExpiredTicketsLocked(now time.Time) {
	for k, v := range c.tickets {
		if now.After(v.ExpiresAt) {
			delete(c.tickets, k)
		}
	}
}

func (c *Coordinator) driverForNode(node ClusterNode) SlotDriver {
	if strings.EqualFold(node.DriverKind, "ssh") {
		return c.sshDrv
	}
	return c.localDrv
}

func defaultSlotSeed(slot Slot, target *clashpool.DialTarget) SlotSeed {
	settingsBytes, _ := json.MarshalIndent(map[string]any{
		"cleanupPeriodDays":   30,
		"includeCoAuthoredBy": false,
		"permissions": map[string]any{
			"allow": []string{},
			"deny":  []string{},
		},
	}, "", "  ")
	customSetting := fmt.Sprintf("cleanse_mode=%s\ntelemetry=%s\nguest_machine_id=%s\n",
		defaultIfEmpty(slot.CleanseMode, "zero"),
		defaultIfEmpty(string(slot.Telemetry), string(TelemetryIsolated)),
		slot.Persona.GuestMachineID,
	)
	proxyEnv := ""
	if target != nil && target.SOCKSAddr != "" {
		proxyURL := fmt.Sprintf("socks5h://%s:%s@%s", target.SocksUsername, target.SocksPassword, target.SOCKSAddr)
		proxyEnv = fmt.Sprintf("HTTP_PROXY=%s\nHTTPS_PROXY=%s\nALL_PROXY=%s\n", proxyURL, proxyURL, proxyURL)
	}
	return SlotSeed{
		SlotID:                 slot.ID,
		SettingsJSONRaw:        string(settingsBytes),
		CustomSettingRaw:       customSetting,
		RejectClientSettings:   true,
		RejectClientIdentity:   true,
		TelemetryMode:          slot.Telemetry,
		TelemetryDaemonRunning: slot.Telemetry == TelemetryIsolated,
		ProxyEnvRaw:            proxyEnv,
		BootstrapScriptRaw:     fmt.Sprintf("#!/bin/sh\nset -e\necho \"Slipgate slot %s ready\"\n", slot.ID),
		SyncedAtUnixMs:         time.Now().UTC().UnixMilli(),
	}
}

func normalizeArch(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "arm64", "aarch64":
		return "arm64"
	default:
		return "amd64"
	}
}

func randomHex(byteLen int) string {
	b := make([]byte, byteLen)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
