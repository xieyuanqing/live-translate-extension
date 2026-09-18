# Changelog

## 0.2.0 — unreleased (updated 2026-09-18)

### Whole-video subtitles

- Added a whole-video subtitle mode for ordinary videos and finished replays, alongside the existing live audio mode. The two modes share the caption layer and settings and are mutually exclusive on a page.
- Read the video's own caption track through the page bridge: the bridge hooks `fetch` and `XMLHttpRequest` at document start to reuse the player's own `timedtext` request, which carries the validation parameters that a bare `baseUrl` request lacks. It prefers an already-fetched body, then refetches the captured URL as `json3`, then temporarily enables the track so the player loads it, restoring the user's CC state afterwards.
- Convert auto-generated captions from word timings into translation units using estimated pauses, a maximum length, and a maximum duration; manual tracks keep their original cues. The program owns the timeline; the model receives and returns numbered lines only.
- Translate in blocks with surrounding context, starting at the current playback position with a small head block so nearby captions appear first, then later blocks, then earlier ones. Translated units are displayed as soon as their request is validated.
- Validate the whole id set of each response. Truncated output retranslates only the missing tail; scattered gaps are topped up by id; rate limits back off with the provider's retry hint; invalid keys or model names stop the task immediately.
- Cache source units and per-block translations in `chrome.storage.local` with `unlimitedStorage`. Blocks are written independently after validation, an interrupted run resumes, and a cache built with a different model or prompt is kept and labeled instead of being silently retranslated.
- Added a text-model configuration (Gemini `generateContent` or OpenAI-compatible `chat/completions`, base URL, key, model name, concurrency, request path). Requests go directly from the page and fall back to a streaming relay through the service worker for endpoints that reject cross-origin requests; custom domains are authorized from Settings via optional host permissions.
- Added a whole-video section to the popup (start, cancel, show/hide, retranslate, progress with the watchable frontier) and cache management to Settings.

### Stability and usability polish — 2026-09-18

- Invalidate pending settings reads on cancellation, navigation, or a switch to live mode; ignore late cache-write callbacks from an older task.
- Validate cached timelines, block boundaries, and non-empty translations. Include source content and endpoint identity in cache fingerprints; keep stale partial caches without silently retranslating them. Build the cache list from independent per-video records to prevent lost entries across tabs.
- Load complete caches without an API key, show the cache's actual target language, and mark changed background/model settings. Hide inactive live statistics on replay pages and keep live translation available as a secondary action.
- Abort text-model requests after two minutes, release cancellation listeners, and avoid treating an interrupted response stream as a cross-origin failure.
- Recognize captured URL objects, reject JSON error bodies as captions, bound caption refetch time, and avoid restoring the old CC state after video navigation.
- Leave the text-model name empty until configured and identify 0.2.0 as an unpublished development version.

### Verification

- Self-tests cover json3 parsing, segmentation, chunk planning and priority, response parsing and validation, playback scheduling, cache fingerprints, subtitle prompts, request building, and SSE parsing.
- Forty regression cases cover live sessions, whole-video tasks, network transport, and the page bridge using simulated browser APIs, caption tracks, model responses, and storage.
- An offline browser check at 360 px popup width covered cached-language labels, show/hide, translation progress, cancel/resume controls, long errors, and the empty model field in Settings. No real provider or YouTube endpoint was exercised.
- These checks do not exercise YouTube's caption endpoint or a real model. Reading a real caption track, translating a real replay, and verifying playback sync in Chrome remain outstanding.

## 0.1.1 — 2026-09-13

### Standalone repository

- Extracted the YouTube extension into its own repository with a fresh Git history.
- Moved the extension to the repository root and added English and Chinese READMEs, development notes, and the MIT license from the original project.
- Added dependency-free checks, reproducible ZIP packaging, and a GitHub Actions workflow. Release archives contain runtime files only.

### Fixes and usability

- Cancel pending startup and audio attachment when stopping, switching videos, or starting a new session. Ignore stale callbacks without affecting a newer session.
- Prevent connection rotation from racing with a scheduled reconnect and leaving an extra socket open.
- Keep connection credentials and translation configuration tied to the session snapshot.
- Ignore stale video metadata after navigation and clear the input-level display when audio submission is paused.
- Widen the popup, group language controls, and show connection errors without truncation.
- Add actions to cancel startup, apply edited settings with a restart, and refresh an unconnected page.
- Send temporary notes immediately and serialize quick-setting saves.

### Verification

- Audio, subtitle, prompt, settings, and manifest self-tests pass.
- Ten lifecycle regression cases pass using simulated browser callbacks and WebSockets.
- An offline headless Chromium check covered popup layout, temporary notes, applying a language change, long error text, and the page-refresh entry point.
- These checks do not validate live Gemini access. A dedicated long-running browser test across multiple rotations remains outstanding.

## 0.1.0 — 2026-09-05

- Initial YouTube live audio capture, Gemini Live connection management, caption stabilization, in-player captions, scene prompts, metadata context, popup, and settings.
- Temporary per-video background notes were added on 2026-09-06 before the standalone split.
- The original project recorded a successful Chrome live-stream test for direct Gemini access, audio passthrough, automatic start, and translated captions. This is a historical result, not a fresh compatibility guarantee.
