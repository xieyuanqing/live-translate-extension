# Changelog

## 0.2.0 — unreleased (updated 2026-09-19)

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

### Caption reading hardening — 2026-09-19

- Try every source that does not touch the player before triggering it: the captured body, the captured URL refetched as `json3`, the matching URL from `player.getAudioTrack()` (which usually carries `pot`), the track's `baseUrl` completed with a `pot` from any source plus the client, device, and version parameters, and another captured request with the track swapped.
- Trigger the player by turning CC on (player API or the CC button) with the native caption container hidden meanwhile, then select the track through `setOption` if nothing happens within three seconds. Poll only for state changes, request each candidate URL at most once, and bound the whole read to 20 seconds.
- Restore CC only when the video and player are unchanged and CC is still on, so a user who turned it off while waiting is not overridden. Serialize reads in the bridge and let the content script cancel an in-flight read on cancel or navigation.
- Return a `tried` log with every result, print it in the console, and name the attempted paths in the error text. Prefer the player's currently selected track when it matches the configured source language; return absolute `baseUrl` values.
- Add `LT.debug.probeCaptions()`, which reads and segments the chosen track without calling a model or writing cache, and `Json3.detectFormat`, which labels standard, scrolling-asr, karaoke, and animated tracks for logs only. Parsing output and `SEG_VERSION` are unchanged.

### Text-model configuration — 2026-09-19

- Replace the single text-model configuration with a list of provider configurations (name, type, base URL, key, model, concurrency, request path). Each can be tested and any one can be marked for whole-video subtitles; concurrency and request path belong to the configuration. The earlier `text*` fields are dropped without migration: enter the configuration once more.
- Add two checks per configuration: a metadata or model-list query over GET that costs nothing and proves only that the key reaches the query endpoint and the model name exists, and a generation test that sends one tiny request through the real translation path. Add a model-name picker fed by the account's own model list; nothing is pre-filled.
- Carry the HTTP method through both the direct and the relayed request paths so GET probes work through the service worker, and allow per-request timeouts.

### Settings page — 2026-09-19

- Reorganize Settings into seven sections with side navigation (a tab strip on narrow windows) and hash routing: 通用, 实时翻译, 整片字幕, 文字模型, 字幕外观, 数据, 关于. Live-only advanced parameters are collapsed by default.
- Caption appearance: display mode (bilingual, translation only, original only), translation position, font family stack, weight, translation and source colors, source font ratio, plus a live preview rendered by the real caption layer in a responsive mock player. The display mode only filters what is shown; it does not stop translation, and original-only still needs a running task or a cache. In bilingual and original-only modes the whole-video mode now shows the source line for units whose translation has not arrived yet. `showSource` is replaced by `captionDisplayMode`.
- Whole-video subtitles get an optional extra instruction that is appended after the scene prompt and therefore enters the cache fingerprint.
- Data: export settings as JSON (keys excluded unless opted in), import with confirmation (files without keys keep the current keys), and reset to defaults with an option to keep keys and endpoint configurations. Caches are untouched by all three.
- About: version, links, a button to Chrome's shortcut settings, and the console diagnostic hint. `tools/preview.js` builds an offline preview of the page with stubbed `chrome.*` APIs for layout checks.

### Verification

- Self-tests cover json3 parsing, segmentation, chunk planning and priority, response parsing and validation, playback scheduling, cache fingerprints, subtitle prompts, request building, and SSE parsing.
- Sixty-five regression cases cover live sessions, whole-video tasks, network transport (including GET relay and per-request timeouts), the page bridge (capture, audio-track and composed URLs, CC trigger and restore, deadline, dedupe, cancel, navigation), track selection, the text-model configuration cards (rendered against a minimal fake DOM), and settings export/import using simulated browser APIs, caption tracks, model responses, and storage.
- An offline browser check at 360 px popup width covered cached-language labels, show/hide, translation progress, cancel/resume controls, long errors, and the empty model field in Settings. Headless Chrome screenshots of the offline Settings preview (`tools/preview.js`) at 1280 px and 600 px covered all seven sections, the provider cards, and the caption preview. No real provider or YouTube endpoint was exercised.
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
