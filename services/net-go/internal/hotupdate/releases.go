package hotupdate

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type githubAsset struct {
	Name               string `json:"name"`
	APIURL             string `json:"url"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

type githubRelease struct {
	TagName         string        `json:"tag_name"`
	Name            string        `json:"name"`
	Body            string        `json:"body"`
	Prerelease      bool          `json:"prerelease"`
	PublishedAt     string        `json:"published_at"`
	HTMLURL         string        `json:"html_url"`
	TargetCommitish string        `json:"target_commitish"`
	Assets          []githubAsset `json:"assets"`
}

type buildMeta struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

func (m *Manager) syncRelease(ctx context.Context, opts SyncOptions, channel string) error {
	m.mu.RLock()
	repo := m.cfg.UpdateRepo
	hotDir := m.cfg.HotUpdateDir
	curVersion := m.status.Version
	curCommit := m.status.ActiveCommit
	curTag := m.activeTag
	m.mu.RUnlock()

	relURL := resolveReleaseEndpoint(m.apiBaseURL, repo, channel, opts.TargetTag)
	var rel githubRelease
	if err := m.fetchJSON(ctx, relURL, &rel); err != nil {
		return fmt.Errorf("fetch release metadata (%s): %w", relURL, err)
	}

	remoteTag := strings.TrimSpace(rel.TagName)
	remoteCommit := strings.TrimSpace(rel.TargetCommitish)
	remoteVersion := normalizeReleaseVersion(remoteTag)
	relName := strings.TrimSpace(rel.Name)
	if relName == "" {
		relName = remoteTag
	}
	relBody := rel.Body
	relHTMLURL := strings.TrimSpace(rel.HTMLURL)
	relPublishedAt := strings.TrimSpace(rel.PublishedAt)

	if metaAsset, ok := findAsset(rel.Assets, "BUILD_META.json"); ok {
		if metaRaw, err := m.downloadBytes(ctx, m.assetDownloadURL(metaAsset), maxManifestBytes); err == nil {
			var meta buildMeta
			if json.Unmarshal(metaRaw, &meta) == nil {
				if strings.TrimSpace(meta.Commit) != "" {
					remoteCommit = strings.TrimSpace(meta.Commit)
				}
				if strings.TrimSpace(meta.Version) != "" {
					remoteVersion = strings.TrimSpace(meta.Version)
				}
			}
		}
	}

	if notesAsset, ok := findAsset(rel.Assets, "RELEASE_NOTES.md"); ok && strings.TrimSpace(relBody) == "" {
		if notesRaw, err := m.downloadBytes(ctx, m.assetDownloadURL(notesAsset), maxManifestBytes); err == nil {
			relBody = string(notesRaw)
		}
	}

	chosenAsset := findMatchingReleaseAsset(rel.Assets, remoteTag, channel)

	available := isUpdateAvailable(curVersion, curCommit, curTag, remoteVersion, remoteCommit, remoteTag, channel, opts)

	m.mu.Lock()
	if remoteCommit != "" {
		rc := remoteCommit
		m.status.RemoteCommit = &rc
	} else {
		m.status.RemoteCommit = nil
	}
	if remoteVersion != "" {
		rv := remoteVersion
		m.status.RemoteVersion = &rv
	} else {
		m.status.RemoteVersion = nil
	}
	if remoteTag != "" {
		rt := remoteTag
		m.status.RemoteTag = &rt
	}
	if relName != "" {
		rn := relName
		m.status.ReleaseName = &rn
	}
	if strings.TrimSpace(relBody) != "" {
		rb := relBody
		m.status.ReleaseNotes = &rb
	} else {
		m.status.ReleaseNotes = nil
	}
	if relHTMLURL != "" {
		ru := relHTMLURL
		m.status.ReleaseURL = &ru
	} else {
		m.status.ReleaseURL = nil
	}
	if relPublishedAt != "" {
		rp := relPublishedAt
		m.status.PublishedAtIso = &rp
	} else {
		m.status.PublishedAtIso = nil
	}
	if chosenAsset != nil {
		an := chosenAsset.Name
		m.status.AssetName = &an
		if chosenAsset.Size > 0 {
			as := chosenAsset.Size
			m.status.AssetSizeBytes = &as
		} else {
			m.status.AssetSizeBytes = nil
		}
	} else {
		m.status.AssetName = nil
		m.status.AssetSizeBytes = nil
	}
	m.status.UpdateAvailable = available
	m.mu.Unlock()

	if opts.CheckOnly || (!available && !opts.Force) {
		return nil
	}

	m.setState(StateDownloading, nil)

	sumsAsset, hasSums := findAsset(rel.Assets, "SHA256SUMS.txt")
	if !hasSums {
		return fmt.Errorf("%w: missing SHA256SUMS.txt in release %s", ErrChecksumMismatch, remoteTag)
	}
	sumsBytes, err := m.downloadBytes(ctx, m.assetDownloadURL(sumsAsset), maxManifestBytes)
	if err != nil {
		return fmt.Errorf("download SHA256SUMS.txt: %w", err)
	}

	if chosenAsset == nil {
		return fmt.Errorf("hotupdate: no matching archive asset for %s/%s in release %s", runtime.GOOS, runtime.GOARCH, remoteTag)
	}

	expectedSHA, ok := lookupChecksum(sumsBytes, chosenAsset.Name)
	if !ok {
		return fmt.Errorf("%w: %s absent from SHA256SUMS.txt", ErrChecksumMismatch, chosenAsset.Name)
	}

	tmpDir, err := os.MkdirTemp("", "slipgate-dl-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)

	archivePath := filepath.Join(tmpDir, chosenAsset.Name)
	if err := m.downloadVerifiedFile(ctx, m.assetDownloadURL(*chosenAsset), archivePath, expectedSHA, chosenAsset.Size); err != nil {
		return err
	}

	m.setState(StateApplying, nil)
	dirSlug := shortCommitLabel(remoteCommit)
	if dirSlug == "" {
		dirSlug = sanitizeSlug(remoteTag)
	}
	if dirSlug == "" {
		dirSlug = "release"
	}
	releasesRoot := filepath.Join(hotDir, "releases")
	targetDir := filepath.Join(releasesRoot, fmt.Sprintf("%s-%d", dirSlug, time.Now().UnixNano()))
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return fmt.Errorf("prepare release dir: %w", err)
	}

	if err := extractArchive(archivePath, targetDir); err != nil {
		_ = os.RemoveAll(targetDir)
		return fmt.Errorf("extract archive: %w", err)
	}

	bundleRoot := resolveBundleRoot(targetDir)
	applied, err := m.applyExtractedBundle(ctx, applyBundleRequest{
		BundleRoot:   bundleRoot,
		NewCommit:    nonEmptyOr(remoteCommit, remoteTag),
		NewVersion:   nonEmptyOr(remoteVersion, remoteTag),
		Tag:          remoteTag,
		Channel:      channel,
		Strategy:     "release",
		Action:       "apply",
		AsyncRestart: opts.AsyncRestart,
		FromVersion:  curVersion,
		FromCommit:   curCommit,
	})
	if err != nil {
		_ = os.RemoveAll(targetDir)
		return err
	}
	if applied {
		m.pruneReleasesKeepingHistory(releasesRoot, maxKeepReleases)
		m.invalidateReleasesCache()
	}
	return nil
}

// ListReleases fetches recent GitHub releases for browsing changelogs and installing specific versions.
func (m *Manager) ListReleases(ctx context.Context, forceRefresh bool) (ReleasesResult, error) {
	m.mu.RLock()
	repo := m.cfg.UpdateRepo
	curVersion := m.status.Version
	curCommit := m.status.ActiveCommit
	curTag := m.activeTag
	m.mu.RUnlock()

	if !forceRefresh {
		m.releasesMu.Lock()
		if len(m.cachedReleases) > 0 && time.Since(m.releasesFetched) < releasesCacheTTL {
			items := markCurrentReleases(m.cachedReleases, curVersion, curCommit, curTag)
			fetched := m.releasesFetched.UTC().Format(time.RFC3339)
			m.releasesMu.Unlock()
			return ReleasesResult{
				Repo:           repo,
				CurrentVersion: curVersion,
				CurrentCommit:  curCommit,
				Standalone:     false,
				FetchedAtIso:   &fetched,
				Releases:       items,
			}, nil
		}
		m.releasesMu.Unlock()
	}

	listURL := fmt.Sprintf("%s/repos/%s/releases?per_page=15", m.apiBaseURL, repo)
	var rawReleases []githubRelease
	if err := m.fetchJSON(ctx, listURL, &rawReleases); err != nil {
		return ReleasesResult{}, fmt.Errorf("fetch releases catalog: %w", err)
	}

	items := make([]ReleaseItem, 0, len(rawReleases))
	for _, rel := range rawReleases {
		tag := strings.TrimSpace(rel.TagName)
		if tag == "" {
			continue
		}
		ch := classifyReleaseChannel(tag, rel.Prerelease)
		ver := normalizeReleaseVersion(tag)
		if ver == "" {
			ver = tag
		}
		name := strings.TrimSpace(rel.Name)
		if name == "" {
			name = tag
		}

		var commitPtr *string
		if tc := strings.TrimSpace(rel.TargetCommitish); tc != "" && !strings.EqualFold(tc, "main") {
			commitPtr = &tc
		}
		var pubPtr *string
		if p := strings.TrimSpace(rel.PublishedAt); p != "" {
			pubPtr = &p
		}
		var urlPtr *string
		if u := strings.TrimSpace(rel.HTMLURL); u != "" {
			urlPtr = &u
		}

		_, hasSums := findAsset(rel.Assets, "SHA256SUMS.txt")
		asset := findMatchingReleaseAsset(rel.Assets, tag, ch)
		var assetNamePtr *string
		var assetSizePtr *int64
		if asset != nil {
			n := asset.Name
			assetNamePtr = &n
			if asset.Size > 0 {
				s := asset.Size
				assetSizePtr = &s
			}
		}

		items = append(items, ReleaseItem{
			Tag:            tag,
			Name:           name,
			Version:        ver,
			Commit:         commitPtr,
			Channel:        ch,
			Prerelease:     rel.Prerelease,
			PublishedAtIso: pubPtr,
			HTMLURL:        urlPtr,
			Body:           rel.Body,
			AssetName:      assetNamePtr,
			AssetSizeBytes: assetSizePtr,
			Installable:    hasSums && asset != nil,
		})
	}

	now := time.Now().UTC()
	fetched := now.Format(time.RFC3339)

	m.releasesMu.Lock()
	m.cachedReleases = append([]ReleaseItem(nil), items...)
	m.releasesFetched = now
	m.releasesMu.Unlock()

	return ReleasesResult{
		Repo:           repo,
		CurrentVersion: curVersion,
		CurrentCommit:  curCommit,
		Standalone:     false,
		FetchedAtIso:   &fetched,
		Releases:       markCurrentReleases(items, curVersion, curCommit, curTag),
	}, nil
}

func (m *Manager) invalidateReleasesCache() {
	m.releasesMu.Lock()
	m.cachedReleases = nil
	m.releasesFetched = time.Time{}
	m.releasesMu.Unlock()
}

func markCurrentReleases(items []ReleaseItem, curVersion, curCommit, curTag string) []ReleaseItem {
	out := make([]ReleaseItem, len(items))
	for i, item := range items {
		copyItem := item
		switch {
		case curTag != "" && strings.EqualFold(curTag, item.Tag):
			copyItem.Current = true
		case item.Channel == ChannelDev && item.Commit != nil && commitsEqual(curCommit, *item.Commit):
			copyItem.Current = true
		case item.Channel == ChannelStable && curVersion != "" && compareSemver(curVersion, item.Version) == 0 && !strings.Contains(curVersion, "-dev"):
			copyItem.Current = true
		}
		out[i] = copyItem
	}
	return out
}

func resolveReleaseEndpoint(apiBaseURL, repo, channel, targetTag string) string {
	if strings.TrimSpace(targetTag) != "" {
		return fmt.Sprintf("%s/repos/%s/releases/tags/%s", apiBaseURL, repo, url.PathEscape(strings.TrimSpace(targetTag)))
	}
	if channel == ChannelDev {
		return fmt.Sprintf("%s/repos/%s/releases/tags/dev-latest", apiBaseURL, repo)
	}
	return fmt.Sprintf("%s/repos/%s/releases/latest", apiBaseURL, repo)
}

func classifyReleaseChannel(tag string, prerelease bool) string {
	lower := strings.ToLower(strings.TrimSpace(tag))
	if prerelease || lower == "dev-latest" || strings.Contains(lower, "-dev") || strings.Contains(lower, "nightly") {
		return ChannelDev
	}
	return ChannelStable
}

func normalizeReleaseVersion(tag string) string {
	t := strings.TrimSpace(tag)
	t = strings.TrimPrefix(t, "v")
	return t
}

func isUpdateAvailable(
	curVersion, curCommit, curTag string,
	remoteVersion, remoteCommit, remoteTag string,
	channel string,
	opts SyncOptions,
) bool {
	if opts.TargetTag != "" {
		if opts.Force {
			return true
		}
		if curTag != "" && strings.EqualFold(curTag, remoteTag) {
			if remoteCommit != "" && curCommit != "" && !commitsEqual(curCommit, remoteCommit) {
				return true
			}
			return false
		}
		if remoteCommit != "" && curCommit != "" && curCommit != "dev" && commitsEqual(curCommit, remoteCommit) {
			return false
		}
		if remoteVersion != "" && curVersion != "" && compareSemver(curVersion, remoteVersion) == 0 {
			return false
		}
		return true
	}

	if channel == ChannelDev {
		if remoteCommit != "" {
			return !commitsEqual(remoteCommit, curCommit)
		}
		return remoteVersion != "" && remoteVersion != curVersion
	}

	// Stable channel compares semantic versions first, falling back to commit hashes.
	if remoteVersion != "" {
		cmp := compareSemver(curVersion, remoteVersion)
		if cmp < 0 {
			return true
		}
		if cmp > 0 {
			return false
		}
	}
	if remoteCommit != "" && curCommit != "" && curCommit != "dev" {
		return !commitsEqual(remoteCommit, curCommit)
	}
	return false
}

// compareSemver returns -1 if a < b, 0 if a == b, and +1 if a > b.
func compareSemver(a, b string) int {
	pa, okA := parseSemver(a)
	pb, okB := parseSemver(b)
	if !okA && !okB {
		return strings.Compare(strings.TrimSpace(a), strings.TrimSpace(b))
	}
	if !okA {
		return -1
	}
	if !okB {
		return 1
	}
	for i := 0; i < 3; i++ {
		if pa.nums[i] < pb.nums[i] {
			return -1
		}
		if pa.nums[i] > pb.nums[i] {
			return 1
		}
	}
	if pa.pre == "" && pb.pre != "" {
		return 1
	}
	if pa.pre != "" && pb.pre == "" {
		return -1
	}
	return strings.Compare(pa.pre, pb.pre)
}

type semverParts struct {
	nums [3]int
	pre  string
}

func parseSemver(raw string) (semverParts, bool) {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "v")
	if s == "" || strings.EqualFold(s, "dev") {
		return semverParts{}, false
	}
	if idx := strings.IndexByte(s, '+'); idx >= 0 {
		s = s[:idx]
	}
	var pre string
	if idx := strings.IndexByte(s, '-'); idx >= 0 {
		pre = s[idx+1:]
		s = s[:idx]
	}
	segs := strings.Split(s, ".")
	if len(segs) != 3 {
		return semverParts{}, false
	}
	var parts semverParts
	parts.pre = pre
	for i := 0; i < 3; i++ {
		n, err := strconv.Atoi(segs[i])
		if err != nil || n < 0 {
			return semverParts{}, false
		}
		parts.nums[i] = n
	}
	return parts, true
}

func findMatchingReleaseAsset(assets []githubAsset, tag, channel string) *githubAsset {
	prefixes := make([]string, 0, 4)
	if tag != "" {
		prefixes = append(prefixes, tag)
		trimmed := strings.TrimPrefix(tag, "v")
		if trimmed != tag {
			prefixes = append(prefixes, trimmed)
		}
	}
	if channel == ChannelDev || !containsStr(prefixes, "dev") {
		prefixes = append(prefixes, "dev")
	}

	for _, prefix := range prefixes {
		for _, candidate := range PlatformAssetCandidates(prefix) {
			if asset, ok := findAsset(assets, candidate); ok {
				copyAsset := asset
				return &copyAsset
			}
		}
	}

	// Fallback substring match for tags/prereleases with custom archive naming.
	archToken := fmt.Sprintf("-%s-%s", runtime.GOOS, runtime.GOARCH)
	ext := ".tar.gz"
	if runtime.GOOS == "windows" {
		ext = ".zip"
	}
	for _, a := range assets {
		if strings.HasPrefix(a.Name, "slipgate-") && strings.Contains(a.Name, archToken) && strings.HasSuffix(a.Name, ext) {
			copyAsset := a
			return &copyAsset
		}
	}
	return nil
}

func containsStr(slice []string, target string) bool {
	for _, s := range slice {
		if s == target {
			return true
		}
	}
	return false
}

func (m *Manager) fetchJSON(ctx context.Context, rawURL string, dest any) error {
	if err := validateDownloadURL(rawURL, m.allowCustomHost); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "slipgate-hotupdater")
	if m.cfg.GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+m.cfg.GitHubToken)
	}

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("HTTP %d from %s: %s", resp.StatusCode, rawURL, strings.TrimSpace(string(snippet)))
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxManifestBytes))
	if err != nil {
		return err
	}
	return json.Unmarshal(body, dest)
}

func (m *Manager) assetDownloadURL(a githubAsset) string {
	if m.cfg.GitHubToken != "" && strings.TrimSpace(a.APIURL) != "" {
		return strings.TrimSpace(a.APIURL)
	}
	if strings.TrimSpace(a.BrowserDownloadURL) != "" {
		return strings.TrimSpace(a.BrowserDownloadURL)
	}
	return strings.TrimSpace(a.APIURL)
}

func (m *Manager) downloadBytes(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	if err := validateDownloadURL(rawURL, m.allowCustomHost); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("User-Agent", "slipgate-hotupdater")
	if m.cfg.GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+m.cfg.GitHubToken)
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d downloading %s", resp.StatusCode, rawURL)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func (m *Manager) downloadVerifiedFile(ctx context.Context, rawURL, destPath, expectedSHA string, expectedSize int64) error {
	if err := validateDownloadURL(rawURL, m.allowCustomHost); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("User-Agent", "slipgate-hotupdater")
	if m.cfg.GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+m.cfg.GitHubToken)
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d downloading archive %s", resp.StatusCode, rawURL)
	}

	totalBytes := resp.ContentLength
	if totalBytes <= 0 {
		totalBytes = expectedSize
	}
	if totalBytes < 0 {
		totalBytes = 0
	}

	f, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}

	pw := &progressWriter{
		mgr:   m,
		total: totalBytes,
	}
	pw.publish(true)

	hasher := sha256.New()
	limited := io.LimitReader(resp.Body, maxArchiveBytes+1)
	written, copyErr := io.Copy(io.MultiWriter(f, hasher, pw), limited)
	closeErr := f.Close()
	if copyErr != nil {
		_ = os.Remove(destPath)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(destPath)
		return closeErr
	}
	if written > maxArchiveBytes {
		_ = os.Remove(destPath)
		return fmt.Errorf("archive exceeds %d bytes", maxArchiveBytes)
	}
	pw.publish(true)

	gotSHA := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(gotSHA, strings.TrimSpace(expectedSHA)) {
		_ = os.Remove(destPath)
		return fmt.Errorf("%w: expected %s got %s", ErrChecksumMismatch, expectedSHA, gotSHA)
	}
	return nil
}

type progressWriter struct {
	mgr         *Manager
	downloaded  int64
	total       int64
	lastBytes   int64
	lastPublish time.Time
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n := len(b)
	p.downloaded += int64(n)
	if p.downloaded-p.lastBytes >= 64*1024 || time.Since(p.lastPublish) >= 150*time.Millisecond {
		p.publish(false)
	}
	return n, nil
}

func (p *progressWriter) publish(force bool) {
	now := time.Now()
	if !force && now.Sub(p.lastPublish) < 100*time.Millisecond {
		return
	}
	p.lastBytes = p.downloaded
	p.lastPublish = now

	total := p.total
	if total < p.downloaded && p.total > 0 {
		total = p.downloaded
	}
	percent := 0.0
	if total > 0 {
		percent = float64(p.downloaded) * 100.0 / float64(total)
		if percent > 100 {
			percent = 100
		}
	}

	p.mgr.mu.Lock()
	p.mgr.status.Progress = &Progress{
		Stage:           StateDownloading,
		DownloadedBytes: p.downloaded,
		TotalBytes:      total,
		Percent:         percent,
	}
	p.mgr.mu.Unlock()
}

// PlatformAssetCandidates returns ordered archive names matching the current OS/arch and libc.
func PlatformAssetCandidates(tagPrefix string) []string {
	arch := runtime.GOARCH
	switch runtime.GOOS {
	case "windows":
		return []string{fmt.Sprintf("slipgate-%s-windows-%s.zip", tagPrefix, arch)}
	case "linux":
		musl := fmt.Sprintf("slipgate-%s-linux-%s-musl.tar.gz", tagPrefix, arch)
		glibc := fmt.Sprintf("slipgate-%s-linux-%s.tar.gz", tagPrefix, arch)
		if isMuslLinux() {
			return []string{musl, glibc}
		}
		return []string{glibc, musl}
	default:
		return []string{fmt.Sprintf("slipgate-%s-%s-%s.tar.gz", tagPrefix, runtime.GOOS, arch)}
	}
}

// PlatformAssetName returns the primary asset filename expected for this platform.
func PlatformAssetName(tagPrefix string) string {
	return PlatformAssetCandidates(tagPrefix)[0]
}

func validateDownloadURL(rawURL string, allowCustomHost bool) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	if allowCustomHost {
		if u.Scheme != "http" && u.Scheme != "https" {
			return fmt.Errorf("%w: unsupported scheme %q", ErrUntrustedDownloadHost, u.Scheme)
		}
		return nil
	}
	if u.Scheme != "https" {
		return fmt.Errorf("%w: non-HTTPS scheme %q", ErrUntrustedDownloadHost, u.Scheme)
	}
	host := strings.ToLower(u.Hostname())
	switch host {
	case "api.github.com", "github.com", "objects.githubusercontent.com", "codeload.github.com":
		return nil
	}
	if strings.HasSuffix(host, ".githubusercontent.com") {
		return nil
	}
	return fmt.Errorf("%w: %q", ErrUntrustedDownloadHost, host)
}

func findAsset(assets []githubAsset, name string) (githubAsset, bool) {
	for _, a := range assets {
		if a.Name == name {
			return a, true
		}
	}
	return githubAsset{}, false
}

func lookupChecksum(sumsBytes []byte, fileName string) (string, bool) {
	lines := strings.Split(string(sumsBytes), "\n")
	for _, line := range lines {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 {
			continue
		}
		candidate := strings.TrimPrefix(fields[1], "*")
		candidate = filepath.Base(candidate)
		if candidate == fileName {
			return fields[0], true
		}
	}
	return "", false
}

func extractArchive(archivePath, destDir string) error {
	if strings.HasSuffix(strings.ToLower(archivePath), ".zip") {
		return extractZip(archivePath, destDir)
	}
	return extractTarGz(archivePath, destDir)
}

func extractTarGz(archivePath, destDir string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()

	gzr, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}

		target, err := safeJoin(destDir, hdr.Name)
		if err != nil {
			return err
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			mode := os.FileMode(hdr.Mode) & 0o777
			if mode == 0 {
				mode = 0o644
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(out, io.LimitReader(tr, maxExtractedFile))
			closeErr := out.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		case tar.TypeSymlink, tar.TypeLink:
			return fmt.Errorf("%w: symlink entry %q rejected", ErrUnsafeArchivePath, hdr.Name)
		}
	}
	return nil
}

func extractZip(archivePath, destDir string) error {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer zr.Close()

	for _, zf := range zr.File {
		if zf.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: symlink entry %q rejected", ErrUnsafeArchivePath, zf.Name)
		}
		target, err := safeJoin(destDir, zf.Name)
		if err != nil {
			return err
		}
		if zf.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := zf.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, zf.Mode()&0o777|0o644)
		if err != nil {
			_ = rc.Close()
			return err
		}
		_, copyErr := io.Copy(out, io.LimitReader(rc, maxExtractedFile))
		closeOut := out.Close()
		_ = rc.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeOut != nil {
			return closeOut
		}
	}
	return nil
}

func safeJoin(rootDir, entryName string) (string, error) {
	if strings.HasPrefix(entryName, "/") || strings.HasPrefix(entryName, `\`) {
		return "", fmt.Errorf("%w: absolute entry %q", ErrUnsafeArchivePath, entryName)
	}
	normalized := filepath.FromSlash(strings.ReplaceAll(entryName, `\`, "/"))
	cleaned := filepath.Clean(normalized)
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) || filepath.IsAbs(cleaned) {
		return "", fmt.Errorf("%w: traversal entry %q", ErrUnsafeArchivePath, entryName)
	}
	target := filepath.Join(rootDir, cleaned)
	rel, err := filepath.Rel(rootDir, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%w: escaped root %q", ErrUnsafeArchivePath, entryName)
	}
	return target, nil
}

func resolveBundleRoot(extractDir string) string {
	entries, err := os.ReadDir(extractDir)
	if err != nil {
		return extractDir
	}
	var dirs []string
	hasFiles := false
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		} else {
			hasFiles = true
		}
	}
	if !hasFiles && len(dirs) == 1 {
		return filepath.Join(extractDir, dirs[0])
	}
	return extractDir
}

func isMuslLinux() bool {
	if _, err := os.Stat("/etc/alpine-release"); err == nil {
		return true
	}
	for _, pattern := range []string{"/lib/ld-musl-*.so.1", "/usr/lib/ld-musl-*.so.1"} {
		matches, _ := filepath.Glob(pattern)
		if len(matches) > 0 {
			return true
		}
	}
	return false
}

func sanitizeSlug(raw string) string {
	var b strings.Builder
	for _, r := range raw {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
		}
	}
	return strings.Trim(b.String(), "._-")
}

func nonEmptyOr(primary, fallback string) string {
	if strings.TrimSpace(primary) != "" {
		return strings.TrimSpace(primary)
	}
	return strings.TrimSpace(fallback)
}
