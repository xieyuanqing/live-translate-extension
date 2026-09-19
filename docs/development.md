# Development notes

This repository contains only the browser extension. The runtime is plain JavaScript, HTML, and CSS; there is no bundler or backend.

## Layout

| Path | Responsibility |
| --- | --- |
| `manifest.json` | MV3 permissions, content-script order, popup, settings, and shortcut |
| `src/common/` | Defaults, editable scenes, local storage, and prompt composition |
| `src/audio/pcm16k.js` | Mono mixing, continuous resampling, and 100 ms PCM blocks |
| `src/main-world/page-bridge.js` | Reads player metadata and caption tracks in the page's JavaScript world; hooks `fetch` / XHR, reads `getAudioTrack()` URLs, composes `pot` URLs, triggers CC, and records every attempt |
| `src/content/main.js` | Session snapshots, navigation, cancellation, audio gating, and wiring for both modes |
| `src/content/audio-tap.js` | Shared audio context and the capture branch of the audio graph |
| `src/content/gemini-live.js` | Setup, queueing, rotation, reconnection, and socket generations |
| `src/content/stabilizer.js` | Streaming fragments to current and committed caption text |
| `src/content/caption-layer.js` | Captions and status inside `#movie_player`; timed mode for whole-video subtitles; display mode and appearance via CSS variables; also drives the Settings preview |
| `src/content/video-subs.js` | Whole-video task: read track, plan blocks, translate with priority, validate, cache, display by time |
| `src/subs/json3.js` | YouTube `json3` caption parsing into timed word fragments |
| `src/subs/segmenter.js` | Auto-caption regrouping into translation units; manual cues kept as-is |
| `src/subs/chunker.js` | Block planning, priority, request text, response parsing and validation |
| `src/subs/scheduler.js` | Unit lookup by playback time and the watchable frontier |
| `src/subs/net.js` | Direct fetch or streaming relay through the service worker; SSE parsing |
| `src/subs/text-model.js` | Gemini `generateContent` and OpenAI-compatible request/response handling |
| `src/subs/cache.js` | `chrome.storage.local` layout, fingerprints, and cache management |
| `src/background/` | Installation defaults, per-tab badges, shortcut forwarding, and the request relay |
| `src/ui/` | Popup and the Settings page: `options.js` (navigation, simple fields, scenes, previews, cache list), `options-providers.js` (text-model configurations), `options-style.js` (appearance and preview), `options-data.js` (export, import, reset) |
| `tools/` | Self-tests, regression tests (lifecycle, whole-video, network, page bridge, track selection, Settings cards), syntax checks, packaging, icon generation, and `preview.js` for an offline Settings preview |

## Audio and page lifecycle

`createMediaElementSource(video)` routes the element's audio through an AudioContext. Always preserve the source-to-destination connection so the original audio remains audible. Stop only the capture branch; do not close the shared context. Reuse each video's media source.

AudioWorklet is preferred, with ScriptProcessor as the existing fallback. The output is PCM16 little-endian, mono, 16 kHz: 1,600 samples / 3,200 bytes every 100 ms. Pausing, muting, and detected ads gate audio submission.

`start()` has several asynchronous waits. A session generation invalidates an old start after stop or navigation; AudioTap separately invalidates unfinished node attachment. Stale completion and error paths must not tear down a newer session.

Read video details through the page bridge and `getPlayerResponse()`. Navigation metadata must still match the current video before it can be used. Mount captions inside `#movie_player` so fullscreen and theater mode include them.

## Session configuration

Scenes contain a name and instruction. Source and target language are separate settings. Persistent notes live in local storage; temporary notes live only in the content script's page memory.

Build the prompt once per session from the configuration read at startup. Reconnection and rotation reuse it. Appearance settings can update immediately; changing the translation configuration requires starting another session.

Appearance is delivered to the caption layer as CSS variables (`--lt-font-family`, `--lt-weight`, `--lt-color`, `--lt-source-color`, `--lt-source-scale`, plus the existing size, bottom, and opacity). `captionDisplayMode` (`bilingual`, `translationOnly`, `originalOnly`) and `captionTranslationPosition` are applied in `CaptionLayer.render()` only: they filter and order the lines and never stop a translation. The whole-video controller always passes the source text with each unit, so bilingual and original-only modes show the source before its translation arrives; live mode records input transcription unless the mode is translation-only. The Settings preview mounts the same `CaptionLayer` into a mock player, so it renders through the same path as the YouTube page. `subsExtraInstruction` is appended to the whole-video system prompt after the scene instruction and therefore changes the cache fingerprint.

The Settings page is split into hash-routed sections; the last visited section is remembered in `localStorage`. Settings are stored flat; `normalize()` clamps ranges and fills defaults and there is no migration between field layouts, so a renamed field simply falls back to its default.

Page metadata and user background are wrapped as untrusted context, followed by a restatement of the translation task. This is a prompting strategy, not a security boundary with guaranteed model behavior.

The current UI labels are Chinese and some are also used in prompt composition. Before adding UI localization, separate presentation labels from stable prompt labels so a language toggle cannot silently change model instructions.

## Current Live setup

The following structure matches the existing implementation and earlier project tests. It is not a substitute for checking current service documentation and actual model access before changing the protocol.

```json
{
  "setup": {
    "model": "models/gemini-3.5-live-translate-preview",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "translationConfig": {
        "targetLanguageCode": "zh",
        "echoTargetLanguage": true
      }
    },
    "inputAudioTranscription": {},
    "outputAudioTranscription": {},
    "systemInstruction": {
      "parts": [{ "text": "<frozen session prompt>" }]
    }
  }
}
```

The transcription fields are at setup level; `translationConfig` is inside `generationConfig`. Earlier project tests found these positions significant. `systemInstruction` in this translation mode is an experimental dependency based on observed behavior; do not promise strict instruction following or permanent support.

Audio chunks use `realtimeInput.audio`, a base64 payload, and MIME type `audio/pcm;rate=16000`. The extension reads transcription text and ignores generated audio.

## Connection invariants

- Default rotation: 505 seconds, configurable from 120 to 580 seconds.
- Queue: at most 200 audio chunks, approximately 20 seconds. Drop the oldest when full.
- Abrupt disconnections can prepend the last ten sent chunks, approximately one second.
- Handshake watchdog: 12 seconds. Reconnect delay starts at one second and backs off to 15 seconds.
- Creating a connection cancels old timers, advances its generation, and closes the previous socket.
- Scheduling a reconnect cancels the rotation timer. Stop clears all timers and the current socket.
- No transcript output during silence is normal; it is not a disconnect detector.

Rotation is a reconnect with queued audio, not overlapping seamless connections.

## Whole-video subtitles

The task lives in the content script, like the live session, and is cancelled by navigation, reload, or the user. Everything that finished validation is already in storage, so cancelling loses only in-flight requests. Starting either mode deactivates the other because they share the caption layer.

**Reading the track.** The page bridge runs at `document_start` in the MAIN world and wraps `window.fetch` and `XMLHttpRequest` to record the player's `/api/timedtext` requests and bodies. Since 2025 those requests carry a `pot` parameter; a bare `baseUrl` from the player response returns an empty 200. The bridge first tries everything that does not touch the player, cheapest first: an already-captured `json3` body for the same video, language, and kind; the captured URL refetched with `fmt=json3`; the matching track URL from `player.getAudioTrack().captionTracks`, which usually carries `pot` without any prior request; the track's own `baseUrl` completed with a `pot` from any source plus the `c`, `cplayer`, `xorb`/`xobt`/`xovt`, device (`ytcfg.get('DEVICE')`), and `cver` parameters that read-frog uses; and another captured request for the same video with the track parameters swapped, which works because `lang`, `kind`, and `fmt` are not in `sparams`. Only then does it trigger the player: it turns CC on (`player.toggleSubtitles()` or the CC button) while hiding the native caption container, and after three seconds without activity also selects the track through `setOption`. While waiting it polls every 200 ms but re-runs the candidates only when something changed (a new captured request or new audio-track URLs), and each candidate URL is requested at most once. The whole read has a 20-second deadline (the content script waits 25 seconds), the wait after triggering is capped at 12 seconds, and the last fallback is the bare `baseUrl`, kept as a diagnostic control. CC is restored only when the video and player node are unchanged and CC is still on; if the user turned it off meanwhile it is left alone. Reads are serialized in the bridge, and `KIND_CANCEL` from the content script (sent on cancel or navigation) aborts the current read at its next check. Every step is recorded in `tried` (source, elapsed time, error), which is returned with both success and failure, logged by `readTrack`, and named in the user-facing error text. Auto-translated tracks (`tlang`) are never selected; the player's currently selected track is preferred when it matches the configured source language, and it is the first choice in auto-detect mode. The bridge's own refetches are excluded from capture to avoid loops. This is undocumented YouTube behavior and must be verified in a real browser after YouTube changes.

**Units.** `Json3.parse` flattens events into words with absolute times and skips `aAppend` rolling markers. `Json3.detectFormat` labels the raw events as `standard`, `scrolling-asr`, `karaoke`, or `animated` for logs and `probeCaptions()` only; it does not change parsing, so it does not affect `SEG_VERSION`. For auto captions, `Segmenter.build` groups words by estimated pauses (word end is estimated from character count because `json3` has no word end times), splits over-long or over-long-duration groups at the largest pause near the middle, merges tiny fragments into the next unit, and ends each unit before the next one starts. Manual tracks keep their cues. Ids are sequential from 1; the model never sees times. Changing any segmentation rule requires bumping `LT.SUBS.SEG_VERSION`, which is part of the cache fingerprint and the source-cache validity check.

**Blocks and order.** `Chunker.plan` splits by unit count and character count. Workers pick the block containing the playback position first, then later blocks by distance, then earlier ones. The block containing the position is requested as a head range of `HEAD_UNITS` starting at the position, then the rest, then the part before the position. Each request carries `CONTEXT_UNITS` of surrounding source text as reference only. Displayed text comes straight from the in-memory unit array, so a unit is watchable as soon as its request validated; the "complete" flag only gates zero-request cache hits.

**Validation.** Responses are `id<TAB>text` lines. The whole id set is checked, empty translations count as missing, and extra ids are ignored. A finish reason of length, or a missing suffix, is treated as truncation: only the tail is retranslated, or the range is halved when nothing usable came back. Scattered gaps are topped up with a request for the missing ids; leftover very short units or bracketed tags fall back to the source text. Rate limits set a shared cooldown from `Retry-After` or Gemini's `retryDelay`; 5xx and network errors back off exponentially; 400/401/403/404 are fatal and stop the task.

**Cache.** Keys are `vs:m:<videoId>` (track, target, fingerprints, block bounds, complete flag), `vs:s:<videoId>:<trackKey>` (packed units), and `vs:c:<videoId>:<fp>:<i>` (one array per validated block). The settings-page list is derived from per-video meta records, avoiding a shared read-modify-write index across tabs. The fingerprint covers the segmentation version, source content and timeline, block parameters, track, target language, API type, endpoint, model, and full system prompt. Cached source version, bounds, and non-empty translations are validated before reuse. A usable cache with different translation settings, even if partial, is kept and labeled; restore its original settings to resume or explicitly retranslate. Invalid source data is read again and cannot reuse old numbered translations. Complete caches do not require credentials to load. Late writes may finish saving the old video's data but must never mutate the new task's state or status text.

**Network.** `Net.request` (and its `Net.post` shorthand) first tries a direct `fetch` with the requested method, with an automatic service-worker fallback only for a network failure before receiving a response. A broken response stream must not be mistaken for CORS rejection. A two-minute deadline covers the entire request, including its body, unless the caller passes a shorter `timeoutMs`; timeout is retryable, while user cancellation is not. Completion releases abort listeners and stream reader locks. The service worker checks the origin's host permission, relays chunks with the requested method (GET and HEAD carry no body), and aborts when the port closes. Port messages count as worker activity, but a provider that stays silent can still outlast the worker's idle lifetime; streaming alone is not a lifetime guarantee. Custom domains are granted from Settings through `optional_host_permissions`.

**Text-model configuration.** Endpoints are stored as a list of provider configurations (`settings.providers`, selected by `subsProviderId`; each carries its own concurrency and request path), and `TextModel.resolve(settings, providerId)` picks one. `normalize()` only clamps ranges, removes duplicate ids, and guarantees one default Gemini entry; there is no migration from earlier field layouts. The Settings page offers two checks per configuration: `TextModel.probe` queries model metadata (Gemini) or the model list (OpenAI-compatible) over GET and proves only that the key can reach the query endpoint and that the model name exists, while `TextModel.generateTest` sends one tiny request through `translate`, so it exercises streaming, SSE parsing, and routing at a small quota cost. `TextModel.listModels` feeds the model-name picker from the account's own list; nothing is pre-filled.

**Caption bridge safeguards.** A captured body must contain actual `json3` text events, not just begin with a JSON brace. Each refetch has a 3.5-second deadline and the whole read a 20-second one. Navigation or cancellation stops further attempts, and the temporary CC change is restored only while the original video and player are still current and CC is still on. Simulated bridge tests cover the capture, audio-track, composed-URL, trigger, user-intervention, deadline, dedupe, cancel, and navigation paths; they do not prove current YouTube endpoint compatibility.

For a browser check, run `await LT.debug.probeCaptions()` first in the content-script console context: it reads and segments the chosen track without calling a model or writing cache and returns the track list, the player's selected track, whether a `pot` is available, the source that worked, the `tried` log, the detected format, and sample units. `LT.debug.videoSubs` exposes the controller and `LT.debug.startVideoSubs(force)` starts a task; `LT.debug.videoSubs.status()` shows requests made, which should be zero on a cache hit. The outstanding real-world validation is reading a real caption track (manual, auto, and multi-language), translating at least one replay longer than an hour with the selected model, checking playback sync at the start, middle, and end, and confirming behavior across popup close, video switching, tab close, and browser restart.

## Checks and packaging

Use Node.js 22+:

```sh
npm run check
npm run package
git diff --check
```

No dependency installation is needed. The package script writes a deterministic, uncompressed ZIP using the standard ZIP format. It includes only `manifest.json`, `src/`, and `icons/`; it excludes test fixtures, docs, Git metadata, and any local settings.

GitHub Actions also checks ZIP integrity and uploads the archive as a workflow artifact. A release ZIP can be extracted into a permanent directory and loaded unpacked.

For a browser check, reload the extension and then refresh YouTube. In DevTools, select the extension's content-script execution context before using `LT.debug.start()`, `LT.debug.stop()`, `LT.debug.status()`, or `LT.debug.videoSubs`. The page's default MAIN world does not expose that object. Never paste API keys or private notes into public diagnostics.

The remaining real-world validation is a live-stream soak test covering multiple 505-second rotations, a network interruption, and video navigation, plus the whole-video checks listed above. The automated tests exercise state transitions using mocks; they do not establish upstream availability, caption-endpoint behavior, or translation quality.
