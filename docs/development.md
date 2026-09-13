# Development notes

This repository contains only the browser extension. The runtime is plain JavaScript, HTML, and CSS; there is no bundler or backend.

## Layout

| Path | Responsibility |
| --- | --- |
| `manifest.json` | MV3 permissions, content-script order, popup, settings, and shortcut |
| `src/common/` | Defaults, editable scenes, local storage, and prompt composition |
| `src/audio/pcm16k.js` | Mono mixing, continuous resampling, and 100 ms PCM blocks |
| `src/main-world/page-bridge.js` | Reads YouTube player metadata in the page's JavaScript world |
| `src/content/main.js` | Session snapshots, navigation, cancellation, and audio gating |
| `src/content/audio-tap.js` | Shared audio context and the capture branch of the audio graph |
| `src/content/gemini-live.js` | Setup, queueing, rotation, reconnection, and socket generations |
| `src/content/stabilizer.js` | Streaming fragments to current and committed caption text |
| `src/content/caption-layer.js` | Captions and status inside `#movie_player` |
| `src/background/` | Installation defaults, per-tab badges, and shortcut forwarding |
| `src/ui/` | Popup and options page |
| `tools/` | Self-tests, lifecycle regression tests, syntax checks, packaging, and icon generation |

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

## Checks and packaging

Use Node.js 22+:

```sh
npm run check
npm run package
git diff --check
```

No dependency installation is needed. The package script writes a deterministic, uncompressed ZIP using the standard ZIP format. It includes only `manifest.json`, `src/`, and `icons/`; it excludes test fixtures, docs, Git metadata, and any local settings.

GitHub Actions also checks ZIP integrity and uploads the archive as a workflow artifact. A release ZIP can be extracted into a permanent directory and loaded unpacked.

For a browser check, reload the extension and then refresh YouTube. In DevTools, select the extension's content-script execution context before using `LT.debug.start()`, `LT.debug.stop()`, or `LT.debug.status()`. The page's default MAIN world does not expose that object. Never paste API keys or private notes into public diagnostics.

The remaining real-world validation is a live-stream soak test covering multiple 505-second rotations, a network interruption, and video navigation. The automated tests exercise state transitions using mocks; they do not establish upstream availability or capture quality.
