# Development notes

This repository contains only the browser extension. The runtime is plain JavaScript, HTML, and CSS; there is no bundler or backend.

## Layout

| Path | Responsibility |
| --- | --- |
| `manifest.json` | MV3 permissions, content-script order, popup, settings, and shortcut |
| `src/common/` | Defaults, editable scenes, local storage, and prompt composition |
| `src/audio/pcm16k.js` | Mono mixing, continuous resampling, and 100 ms PCM blocks |
| `src/main-world/page-bridge.js` | Reads player metadata and caption tracks in the page's JavaScript world; hooks `fetch` / XHR to reuse the player's own `timedtext` requests |
| `src/content/main.js` | Session snapshots, navigation, cancellation, audio gating, and wiring for both modes |
| `src/content/audio-tap.js` | Shared audio context and the capture branch of the audio graph |
| `src/content/gemini-live.js` | Setup, queueing, rotation, reconnection, and socket generations |
| `src/content/stabilizer.js` | Streaming fragments to current and committed caption text |
| `src/content/caption-layer.js` | Captions and status inside `#movie_player`; timed mode for whole-video subtitles |
| `src/content/video-subs.js` | Whole-video task: read track, plan blocks, translate with priority, validate, cache, display by time |
| `src/subs/json3.js` | YouTube `json3` caption parsing into timed word fragments |
| `src/subs/segmenter.js` | Auto-caption regrouping into translation units; manual cues kept as-is |
| `src/subs/chunker.js` | Block planning, priority, request text, response parsing and validation |
| `src/subs/scheduler.js` | Unit lookup by playback time and the watchable frontier |
| `src/subs/net.js` | Direct fetch or streaming relay through the service worker; SSE parsing |
| `src/subs/text-model.js` | Gemini `generateContent` and OpenAI-compatible request/response handling |
| `src/subs/cache.js` | `chrome.storage.local` layout, fingerprints, and cache management |
| `src/background/` | Installation defaults, per-tab badges, shortcut forwarding, and the request relay |
| `src/ui/` | Popup and options page |
| `tools/` | Self-tests, lifecycle and whole-video regression tests, syntax checks, packaging, and icon generation |

## Audio and page lifecycle

`createMediaElementSource(video)` routes the element's audio through an AudioContext. Always preserve the source-to-destination connection so the original audio remains audible. Stop only the capture branch; do not close the shared context. Reuse each video's media source.

AudioWorklet is preferred, with ScriptProcessor as the existing fallback. The output is PCM16 little-endian, mono, 16 kHz: 1,600 samples / 3,200 bytes every 100 ms. Pausing, muting, and detected ads gate audio submission.

`start()` has several asynchronous waits. A session generation invalidates an old start after stop or navigation; AudioTap separately invalidates unfinished node attachment. Stale completion and error paths must not tear down a newer session.

Read video details through the page bridge and `getPlayerResponse()`. Navigation metadata must still match the current video before it can be used. Mount captions inside `#movie_player` so fullscreen and theater mode include them.

## Session configuration

Scenes contain a name and instruction. Source and target language are separate settings. Persistent notes live in local storage; temporary notes live only in the content script's page memory.

Build the prompt once per session from the configuration read at startup. Reconnection and rotation reuse it. Appearance settings can update immediately; changing the translation configuration requires starting another session.

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

**Reading the track.** The page bridge runs at `document_start` in the MAIN world and wraps `window.fetch` and `XMLHttpRequest` to record the player's `/api/timedtext` requests and bodies. Since 2025 those requests carry a `pot` parameter; a bare `baseUrl` from the player response returns an empty 200. Resolution order: an already-captured `json3` body for the same video, language, and kind; refetching the captured URL with `fmt=json3`; enabling the track through the player API so the player loads it (the user's CC state is restored afterwards); reusing another captured request for the same video with the track parameters swapped, which works because `lang`, `kind`, and `fmt` are not in `sparams`; finally the `baseUrl`. Auto-translated tracks (`tlang`) are never selected. The bridge's own refetches are excluded from capture to avoid loops. This is undocumented YouTube behavior and must be verified in a real browser after YouTube changes.

**Units.** `Json3.parse` flattens events into words with absolute times and skips `aAppend` rolling markers. For auto captions, `Segmenter.build` groups words by estimated pauses (word end is estimated from character count because `json3` has no word end times), splits over-long or over-long-duration groups at the largest pause near the middle, merges tiny fragments into the next unit, and ends each unit before the next one starts. Manual tracks keep their cues. Ids are sequential from 1; the model never sees times. Changing any segmentation rule requires bumping `LT.SUBS.SEG_VERSION`, which is part of the cache fingerprint and the source-cache validity check.

**Blocks and order.** `Chunker.plan` splits by unit count and character count. Workers pick the block containing the playback position first, then later blocks by distance, then earlier ones. The block containing the position is requested as a head range of `HEAD_UNITS` starting at the position, then the rest, then the part before the position. Each request carries `CONTEXT_UNITS` of surrounding source text as reference only. Displayed text comes straight from the in-memory unit array, so a unit is watchable as soon as its request validated; the "complete" flag only gates zero-request cache hits.

**Validation.** Responses are `id<TAB>text` lines. The whole id set is checked, empty translations count as missing, and extra ids are ignored. A finish reason of length, or a missing suffix, is treated as truncation: only the tail is retranslated, or the range is halved when nothing usable came back. Scattered gaps are topped up with a request for the missing ids; leftover very short units or bracketed tags fall back to the source text. Rate limits set a shared cooldown from `Retry-After` or Gemini's `retryDelay`; 5xx and network errors back off exponentially; 400/401/403/404 are fatal and stop the task.

**Cache.** Keys are `vs:index`, `vs:m:<videoId>` (track, target, fingerprint, block bounds, complete flag), `vs:s:<videoId>:<trackKey>` (packed units), and `vs:c:<videoId>:<fp>:<i>` (one array per block, written only after the block is complete). The fingerprint covers the segmentation version, block parameters, track, target language, API type, model, and the full system prompt. A complete cache with a different fingerprint is loaded and labeled as stale; only an explicit retranslate removes the old blocks. Meta writes are small; block writes never rewrite each other.

**Network.** `Net.post` tries a direct `fetch` from the page (Gemini and OpenAI official endpoints allow cross-origin requests) and falls back to a `chrome.runtime.connect` port to the service worker on a network-level failure, remembering the origin for the rest of the page. The worker checks `chrome.permissions.contains` for the origin, streams the response back in chunks, and aborts when the port closes. Streaming keeps the worker's 30-second idle and 5-minute request limits out of the way for ordinary requests; long non-streaming responses would not be safe there. Custom domains are granted from Settings through `optional_host_permissions`.

For a browser check, `LT.debug.videoSubs` exposes the controller and `LT.debug.startVideoSubs(force)` starts a task; `LT.debug.videoSubs.status()` shows requests made, which should be zero on a cache hit. The outstanding real-world validation is reading a real caption track (manual, auto, and multi-language), translating at least one replay longer than an hour with the selected model, checking playback sync at the start, middle, and end, and confirming behavior across popup close, video switching, tab close, and browser restart.

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
