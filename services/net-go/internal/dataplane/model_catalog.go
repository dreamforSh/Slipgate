package dataplane

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const modelCatalogTTL = 10 * time.Minute

type cachedProviderModels struct {
	models    []string
	fetchedAt time.Time
}

type modelCatalogCache struct {
	mu          sync.RWMutex
	byProvider  map[string]cachedProviderModels
	refreshLock sync.Mutex
}

func (mc *modelCatalogCache) snapshot() map[string][]string {
	if mc == nil {
		return nil
	}
	mc.mu.RLock()
	defer mc.mu.RUnlock()
	if len(mc.byProvider) == 0 {
		return nil
	}
	out := make(map[string][]string, len(mc.byProvider))
	for prov, entry := range mc.byProvider {
		if len(entry.models) > 0 {
			out[prov] = append([]string(nil), entry.models...)
		}
	}
	return out
}

func (mc *modelCatalogCache) put(provider string, models []string) {
	if mc == nil || provider == "" || len(models) == 0 {
		return
	}
	uniq := dedupSortedStrings(models)
	mc.mu.Lock()
	if mc.byProvider == nil {
		mc.byProvider = make(map[string]cachedProviderModels)
	}
	mc.byProvider[provider] = cachedProviderModels{
		models:    uniq,
		fetchedAt: time.Now(),
	}
	mc.mu.Unlock()
}

func (mc *modelCatalogCache) isFresh(provider string, now time.Time) bool {
	if mc == nil {
		return false
	}
	mc.mu.RLock()
	defer mc.mu.RUnlock()
	entry, ok := mc.byProvider[provider]
	return ok && len(entry.models) > 0 && now.Sub(entry.fetchedAt) < modelCatalogTTL
}

// DiscoveredModels returns the SWR-cached upstream model list per provider.
func (c *Coordinator) DiscoveredModels() map[string][]string {
	return c.modelCatalog.snapshot()
}

// RefreshUpstreamModelCatalog queries /v1/models (or /v1beta/models for Gemini) once per provider
// using an active non-mock account, updates the SWR cache, and pushes updated providerModels to slipgate-core.
func (c *Coordinator) RefreshUpstreamModelCatalog(ctx context.Context, force bool) map[string][]string {
	c.modelCatalog.refreshLock.Lock()
	defer c.modelCatalog.refreshLock.Unlock()

	c.mu.RLock()
	metas := make(map[string]accountMeta, len(c.accountMetas))
	for id, m := range c.accountMetas {
		metas[id] = m
	}
	c.mu.RUnlock()

	now := time.Now()
	probedProviders := make(map[string]bool)
	updatedAny := false

	for accID, meta := range metas {
		if ctx.Err() != nil {
			break
		}
		prov := strings.ToLower(strings.TrimSpace(meta.Platform))
		if prov == "" || prov == "antigravity" || prov == "codex" || prov == "bedrock" || prov == "vertex" || meta.ExecutionMode == "vm_slot" {
			continue
		}
		if probedProviders[prov] {
			continue
		}
		if !force && c.modelCatalog.isFresh(prov, now) {
			probedProviders[prov] = true
			continue
		}
		if prov == "typesafe" {
			probedProviders[prov] = true
			c.modelCatalog.put(prov, []string{TypeSafeJevLatestModel})
			updatedAny = true
			continue
		}
		sec, ok := c.vault.Get(accID)
		if !ok || sec.IsMock() || strings.TrimSpace(sec.APIKey) == "" {
			if prov == "opencode_go" && !c.modelCatalog.isFresh(prov, now) {
				probedProviders[prov] = true
				c.modelCatalog.put(prov, DefaultOpenCodeGoModelIDs())
				updatedAny = true
			}
			continue
		}
		probedProviders[prov] = true

		models, err := c.fetchProviderModelsOnce(ctx, accID, meta, sec)
		if err == nil && len(models) > 0 {
			c.modelCatalog.put(prov, models)
			updatedAny = true
		} else if prov == "opencode_go" {
			c.modelCatalog.put(prov, DefaultOpenCodeGoModelIDs())
			updatedAny = true
		}
	}

	if updatedAny {
		_ = c.PullSnapshotFromBFF(ctx)
	}
	return c.modelCatalog.snapshot()
}

func (c *Coordinator) fetchProviderModelsOnce(ctx context.Context, accountID string, meta accountMeta, sec AccountSecret) ([]string, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	prov := strings.ToLower(strings.TrimSpace(meta.Platform))
	baseURL := resolveProviderBaseURL(prov, sec.BaseURL)
	if profile := LookupProviderProfile(prov); profile != nil {
		if chatBase := resolveMultiProtocolBaseURL(profile, sec, APIProtocolChatCompletions); chatBase != "" {
			baseURL = chatBase
		}
	}
	targetURL := joinProviderPath(baseURL, "/v1/models")
	if prov == "gemini" {
		targetURL = joinProviderPath(baseURL, "/v1beta/models")
	}

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	pctx := OutboundPersonaContext{
		Provider:      prov,
		AuthKind:      meta.AuthKind,
		ExecutionMode: meta.ExecutionMode,
		AccountID:     accountID,
	}
	applyUpstreamAuthHeaders(req, pctx, sec)
	applyOpenCodeAndCommandCodeHeaders(req, pctx, sec, targetURL, &CanonicalTurn{})
	req.Header.Set("Accept", "application/json")

	resp, err := c.executeControlHTTPRequest(reqCtx, accountID, meta, sec, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if err != nil {
		return nil, err
	}

	if prov == "gemini" {
		var gem struct {
			Models []struct {
				Name string `json:"name"`
			} `json:"models"`
		}
		if json.Unmarshal(raw, &gem) != nil {
			return nil, nil
		}
		out := make([]string, 0, len(gem.Models))
		for _, m := range gem.Models {
			id := strings.TrimPrefix(strings.TrimSpace(m.Name), "models/")
			if id != "" {
				out = append(out, id)
			}
		}
		return out, nil
	}

	var oa struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &oa) != nil {
		return nil, nil
	}
	out := make([]string, 0, len(oa.Data))
	for _, m := range oa.Data {
		if id := strings.TrimSpace(m.ID); id != "" {
			out = append(out, id)
		}
	}
	return out, nil
}

func dedupSortedStrings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	cp := make([]string, 0, len(in))
	for _, s := range in {
		if t := strings.TrimSpace(s); t != "" {
			cp = append(cp, t)
		}
	}
	sort.Strings(cp)
	uniq := cp[:0]
	for _, s := range cp {
		if len(uniq) == 0 || uniq[len(uniq)-1] != s {
			uniq = append(uniq, s)
		}
	}
	return uniq
}
