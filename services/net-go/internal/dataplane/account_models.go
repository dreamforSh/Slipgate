package dataplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Per-account model discovery (sub2api "sync upstream models"): asks the provider which models this
// account can use, over the account's own egress. Providers without a listing endpoint, or calls
// that fail, answer Source "default" with no models and a reason; the BFF then offers its built-in list.

const accountModelsTimeout = 20 * time.Second

var (
	// ErrAccountNotSynced means the BFF has not pushed this account to the data plane yet.
	ErrAccountNotSynced = errors.New("dataplane: account is not synchronized to the data plane yet")
	// ErrAccountModelsUnsupported is returned for VM-slot accounts (they answer from their slot).
	ErrAccountModelsUnsupported = errors.New("dataplane: VM slot accounts do not list models from the network service")
)

// AccountModelsResult is the answer of FetchAccountModels.
type AccountModelsResult struct {
	Models  []string `json:"models"`
	Source  string   `json:"source"` // upstream | default
	Message string   `json:"message,omitempty"`
}

func defaultModels(reason string) AccountModelsResult {
	return AccountModelsResult{Models: []string{}, Source: "default", Message: reason}
}

// FetchAccountModels lists the models one account can use.
func (c *Coordinator) FetchAccountModels(ctx context.Context, accountID string) (AccountModelsResult, error) {
	meta, ok := c.accountMetaFor(accountID)
	if !ok {
		return AccountModelsResult{}, ErrAccountNotSynced
	}
	if meta.ExecutionMode == "vm_slot" {
		return AccountModelsResult{}, ErrAccountModelsUnsupported
	}
	sec, ok := c.vault.Get(accountID)
	if !ok {
		return AccountModelsResult{}, ErrAccountSecretNotFound
	}
	prov := strings.ToLower(strings.TrimSpace(meta.Platform))
	if sec.IsMock() {
		return defaultModels("mock account"), nil
	}
	switch prov {
	case "bedrock", "vertex", "command_code":
		return defaultModels("the provider has no per-account model listing"), nil
	case "typesafe":
		return AccountModelsResult{Models: []string{TypeSafeJevLatestModel}, Source: "upstream"}, nil
	case "opencode_go":
		return AccountModelsResult{Models: DefaultOpenCodeGoModelIDs(), Source: "default"}, nil
	case "gemini":
		if strings.EqualFold(meta.AuthKind, "oauth") {
			return defaultModels("Gemini CLI (Code Assist) accounts have no model listing"), nil
		}
	}
	if strings.TrimSpace(sec.APIKey) == "" {
		return defaultModels("account has no credential to list models with"), nil
	}
	// A stale OAuth token only earns a 401; renew it first when it is about to expire.
	if strings.TrimSpace(sec.RefreshToken) != "" && sec.NeedsOAuthRefresh(time.Now()) {
		if renewed, err := c.RefreshAccountOAuth(ctx, accountID, false); err == nil {
			sec = renewed
		}
	}

	reqCtx, cancel := context.WithTimeout(ctx, accountModelsTimeout)
	defer cancel()
	var (
		models []string
		err    error
	)
	switch {
	case prov == "codex" && !strings.EqualFold(meta.AuthKind, "api_key"):
		models, err = c.fetchCodexModels(reqCtx, accountID, meta, sec)
	case prov == "antigravity":
		models, err = c.fetchAntigravityModels(reqCtx, accountID, meta, sec)
	default:
		models, err = c.fetchProviderModelsOnce(reqCtx, accountID, meta, sec)
	}
	if err != nil {
		return defaultModels(err.Error()), nil
	}
	models = dedupSortedStrings(models)
	if len(models) == 0 {
		return defaultModels("the provider returned no models"), nil
	}
	return AccountModelsResult{Models: models, Source: "upstream"}, nil
}

// fetchCodexModels reads the Codex backend's model list (what Codex CLI shows in /model).
func (c *Coordinator) fetchCodexModels(ctx context.Context, accountID string, meta accountMeta, sec AccountSecret) ([]string, error) {
	base := "https://chatgpt.com/backend-api/codex"
	if custom := strings.TrimRight(strings.TrimSpace(sec.BaseURL), "/"); custom != "" {
		base = strings.TrimSuffix(custom, "/responses")
	}
	target := base + "/models?client_version=" + url.QueryEscape(CLICodexVersion())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	pctx := OutboundPersonaContext{Provider: "codex", AuthKind: meta.AuthKind, ExecutionMode: meta.ExecutionMode, AccountID: accountID}
	ApplyCodexSubscriptionHeaders(req, pctx, sec)
	req.Header.Set("Accept", "application/json")
	raw, err := c.readModelListing(ctx, accountID, meta, sec, req)
	if err != nil {
		return nil, err
	}
	var body struct {
		Models []struct {
			Slug string `json:"slug"`
			ID   string `json:"id"`
		} `json:"models"`
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("decode codex model list: %w", err)
	}
	out := make([]string, 0, len(body.Models)+len(body.Data))
	for _, m := range body.Models {
		if id := strings.TrimSpace(firstNonEmpty(m.Slug, m.ID)); id != "" {
			out = append(out, id)
		}
	}
	for _, m := range body.Data {
		if id := strings.TrimSpace(m.ID); id != "" {
			out = append(out, id)
		}
	}
	return out, nil
}

// fetchAntigravityModels calls Cloud Code fetchAvailableModels for the account's project.
func (c *Coordinator) fetchAntigravityModels(ctx context.Context, accountID string, meta accountMeta, sec AccountSecret) ([]string, error) {
	base := resolveProviderBaseURL("antigravity", sec.BaseURL)
	target := joinProviderPath(base, "/v1internal:fetchAvailableModels")
	project := strings.TrimSpace(firstNonEmpty(sec.ProjectID, defaultAntigravityProj))
	payload, _ := json.Marshal(map[string]any{"project": project})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	pctx := OutboundPersonaContext{Provider: "antigravity", AuthKind: meta.AuthKind, ExecutionMode: meta.ExecutionMode, AccountID: accountID}
	ApplyAntigravityHeaders(req, pctx, sec)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	raw, err := c.readModelListing(ctx, accountID, meta, sec, req)
	if err != nil {
		return nil, err
	}
	var body struct {
		Models map[string]json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("decode antigravity model list: %w", err)
	}
	out := make([]string, 0, len(body.Models))
	for id := range body.Models {
		if id = strings.TrimSpace(id); id != "" {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out, nil
}

// readModelListing sends a listing request over the account egress and returns a 2xx body.
func (c *Coordinator) readModelListing(ctx context.Context, accountID string, meta accountMeta, sec AccountSecret, req *http.Request) ([]byte, error) {
	resp, err := c.executeControlHTTPRequest(ctx, accountID, meta, sec, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errors.New(privacyErrorSnippet(resp.StatusCode, raw))
	}
	return raw, nil
}
