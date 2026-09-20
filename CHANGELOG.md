# Changelog

All notable changes to OmniSnag are documented here.

## [1.8.0] — Rebrand & public release

- **Rebrand**: OmniSniffer → **OmniSnag** (manifest, UI, tooltips, console logs,
  internal bridge identifiers). Storage keys unchanged — existing settings and
  history are preserved on update.
- Sniff **blacklist**: root-domain matching (entry hits itself and all subdomains),
  media-CDN or source-page domain either one blocks. Manual add (domain or URL,
  auto-extracts hostname) and bulk URL import (one per line, deduped, invalid lines
  counted). 300-entry render cap with instant search filter; changes apply
  immediately via `storage.onChanged` without reloading the extension.
- Blacklist large-list protection: paginated rendering, `DocumentFragment`
  mounting, `Set`-based O(1) dedup on import.

## [1.7.6] — CSS structure fixes

- Fixed two unclosed CSS rules that silently swallowed all following styles
  (batch collector layout broken, textarea styles not applied). Added a CSS
  structure gate (brace balance + duplicate rule-head detection) to prevent
  regressions.
- Import textarea polish: monospace font, thin dark scrollbar, focus ring,
  placeholder dimming.

## [1.7.5] — Sniff blacklist

- Domain blacklist in the settings panel; matched domains skip sniffing entirely
  (three guard points: webRequest layer, `registerMediaItem`, `MEDIA_DETECTED`
  message entry). Data in `chrome.storage.local.sniffBlacklist`.

## [1.7.4] — X (Twitter) platform fixes

- Type detection by **pathname** instead of full URL (query strings no longer
  mislead, e.g. `clip.mp4?ts=123`).
- **Per-work grouping**: master / variants / init segment / segments of one video
  collapse into a single entry (`ext_tw_video/{id}` asset root).
- **Idempotent segment folding**: replaying the same video no longer inflates
  segment counts (dedupe key list stored on the parent entry).
- **Playability labels**: init segments (moov-only), video-only / audio-only
  tracks and bare fragments are explicitly marked as not playable standalone.
- fMP4/CMAF segments are byte-concatenated (init segment first) instead of being
  fed to the TS remuxer, which previously produced broken files.

## [1.7.3] — Empty-state DOM fix

- Empty-state nodes are cached and re-mounted per render; `innerHTML = ''` no
  longer permanently removes them, which used to freeze lists (e.g. "clear
  history" cleared the header but left old cards).
- `renderMediaList` same fix; fallback creates a full empty-state structure when
  a node is missing.

## [1.7.2] — Clear-history race

- `historyMutatedSinceLoad` guard against MV3 service-worker restart races;
  clear tombstone (15 s) prevents polling from re-fetching cleared data.

## [1.7.0 – 1.7.1] — History & UI

- Per-domain history buckets with write-time compression: segment folding,
  normalized-URL dedupe, per-domain/domain-count caps, credential truncation
  (measured ~2400:1 on a real site).
- All native `alert`/`confirm` replaced with in-panel dialogs and toasts.

## [1.5.0 – 1.6.x] — VPS bridge & fixes

- Remote download bridge over the fixed `/api/ext/m3u8` contract
  (resolve / submit / tasks / cancel / retry, `X-Ext-Token` auth).
- Task board with progress, speed, segment counts, cancel & retry; polling only
  while tasks are queued/running.
- Variant picker for master playlists, batch push, auto-push option.
