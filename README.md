# LiveTranslate for YouTube

[English](README.md) · [简体中文](README.zh-CN.md)

Live streams: translate YouTube live audio into captions inside the player, using your own Gemini API key, while the original audio keeps playing.
Videos and replays: read the video's own YouTube caption track, translate the whole video with a text model, cache the result locally, and start watching as soon as the part around the current position is ready.

[![Checks](https://github.com/xieyuanqing/live-translate-extension/actions/workflows/check.yml/badge.svg)](https://github.com/xieyuanqing/live-translate-extension/actions/workflows/check.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Version 0.2.0.** A standalone Chrome Manifest V3 extension. The current interface is in Simplified Chinese. Install it manually for now; it is not listed in a browser extension store.

## What it does

**Live streams (audio translation)**

- Captures audio from the YouTube player and sends it to Gemini for live translation.
- Shows translated captions inside the player, including fullscreen and theater mode.
- Can start automatically on live streams, with a manual start/stop button and an `Alt+T` shortcut.
- Lets you choose the source language, target language, and an editable scene prompt.
- Can include the title, channel, description, and your own background notes to help with names and context.
- Pauses audio submission while the player is paused, muted, or showing a detected advertisement.

**Videos and replays (whole-video subtitles)**

- Reads the video's caption track: a manual track in the selected source language first, then the auto-generated track. YouTube's auto-translated tracks are never used.
- Regroups auto-generated captions into complete semantic units using word timings before translating. The program owns the timeline; the model only sees numbered lines.
- Translates from the current playback position outward: the block you are watching comes first, then later blocks, then earlier ones. Seeking into an untranslated area raises its priority.
- Caches the source text and translations per video. Reopening a video shows them automatically, and an interrupted run resumes where it stopped.
- Never silently retranslates after you change the model or prompt: the old cache stays in use and is labeled; only **重新翻译** spends credits again.
- The text model can be Gemini `generateContent` or any OpenAI-compatible `chat/completions` endpoint, with a model name you type in.

Both modes share the caption layer and the scene, language, and background settings. Pages that are currently live use the audio mode; ordinary videos and finished replays use whole-video subtitles. A transcription model that does not depend on YouTube's auto captions is deferred until there is a way to obtain the full audio.

## Install

1. Open [Releases](https://github.com/xieyuanqing/live-translate-extension/releases/latest) and download `live-translate-extension-0.2.0.zip`.
2. Extract it into a permanent folder. Keep that folder after installation.
3. Open `chrome://extensions/` and turn on **Developer mode**.
4. Choose **Load unpacked** and select the extracted folder containing `manifest.json`.
5. Refresh any YouTube pages that were already open.

To install from source, clone this repository and load its root directory. No build step, Node.js installation, or Android tools are needed to use the extension.

For updates, replace the files in the same installation folder, reload the extension on `chrome://extensions/`, and refresh YouTube. Keeping the same installation path helps preserve the extension's local settings. A store installation or a different unpacked path may use a different extension ID; local settings are not automatically migrated.

## First-time setup

1. Open the extension popup and select **设置** (Settings).
2. Enter your own Gemini API key. You can create one in [Google AI Studio](https://aistudio.google.com/apikey). Your key must have access to the configured Live Translate model.
3. Make sure your browser can reach `generativelanguage.googleapis.com`, or configure a compatible WSS proxy in Settings.
4. For whole-video subtitles, open **整片字幕翻译** in Settings, pick the API type, and enter a model name. Gemini reuses the Live key unless you enter a separate one; OpenAI-compatible endpoints need their own base URL and key. The default model name is only a placeholder; use a model your account can actually access.
5. Choose a translation direction. The default is **Japanese → Chinese**.
6. Open a YouTube live stream. Automatic start is enabled by default once a key is configured; you can turn it off in Settings.

Live streams use `gemini-3.5-live-translate-preview`. Availability and API usage charges depend on your Gemini access and service plan. Installing this extension does not include API credits.

## Everyday controls

| Control | Behavior |
| --- | --- |
| Start / stop live translation, or `Alt+T` | Controls audio translation in the current tab; original audio keeps playing. |
| 翻译整片字幕 | Shown on non-live video pages. Reads the caption track, translates from the current position first, and caches the result. |
| 取消翻译 / 隐藏字幕 / 重新翻译 | Cancel drops only in-flight requests and keeps finished blocks; hide keeps the cache; retranslate spends credits again. |
| 听什么 / 翻译成 | Selects the source and target language for both modes. |
| 场景 | Chooses a reusable scene prompt, such as VTuber, gaming, or general live streams. |
| 本场补充 | Adds temporary background for this video. It is cleared when you change videos or reload the page. |
| 应用当前设置并重新开始 | Restarts live translation with your updated language, scene, and background. |
| Settings → caption appearance | Changes caption size, position, background, and line count immediately. |
| Settings → 字幕缓存 | Lists cached videos and deletes one or all of them. |

Each session freezes its translation configuration. Reconnecting or rotating a connection keeps that snapshot; editing settings takes effect when you start a new session. Temporary notes are sent to the page as you type, so closing the popup does not discard the input.

While whole-video subtitles are being translated, the player shows the progress and how far from the current position is already watchable. Closing the popup does not affect the task. Changing videos, reloading, or closing the tab cancels unfinished requests; finished blocks are already saved, and **继续翻译** resumes from there.

Scene prompts, persistent background notes, and temporary notes are separate: scene prompts are reusable preferences; persistent notes are included in each session; temporary notes belong only to the current video.

## Data and credentials

There is no project-operated backend. **Translation is not offline:** live audio, caption text, and the enabled background information are sent directly to Gemini or to the text-model endpoint you configure, or through the proxy you configure.

The API key, preferences, scene prompts, and persistent notes are stored in `chrome.storage.local`. The key is currently stored **without application-level encryption**. Temporary notes and live captions stay in page memory. **Whole-video subtitles, both source text and translations, are persisted in the extension's local storage.** They do not expire automatically and can be deleted from Settings.

Use your own key on a computer you trust. Do not put keys in source code, issues, screenshots, or release packages. A custom proxy or third-party endpoint receives the requests routed through it, including the API key. Each provider's handling of submitted data is governed by its own terms; this project cannot promise that a provider never retains data.

Public store distribution, including its consent flow and privacy disclosures, will be handled separately.

## Troubleshooting

| Symptom | Try this |
| --- | --- |
| The popup says the page is not connected | Refresh YouTube after installing or reloading the extension. The popup also provides a refresh button. |
| It cannot connect to Gemini | Check your key, model access, network, and configured proxy. |
| Connected, but no captions | Play spoken audio, unmute the player, and check the input-level bar in the popup. Silence alone does not mean the connection failed. |
| "No caption track" for a video | The video has no captions, or auto captions are not generated yet. Setting 听什么 to auto-detect relaxes track selection. |
| The caption endpoint returned empty content | YouTube's caption endpoint requires the player's own validation parameters. Turn CC on once in the player and retry; if it still fails, the endpoint may have changed. |
| The text model returns 404 / 401 | Check the model name, whether the base URL ends at `/v1`, and whether the key can access that model. |
| A third-party endpoint reports CORS or "not authorized" | Use **授权浏览器访问该域名** in Settings; requests are then relayed through the extension's background worker. |
| Captions overlap YouTube CC | Turn off YouTube CC or adjust the caption bottom position in Settings. |
| The popup shows a compatibility audio mode | AudioWorklet was unavailable and the extension is using ScriptProcessor as a fallback. Heavy page activity may affect capture. |

The implementation rotates connections every 505 seconds by default and reconnects after interruptions. A brief reconnection message can be normal. If a problem persists, [open an issue](https://github.com/xieyuanqing/live-translate-extension/issues) with your Chrome version, extension version, and steps to reproduce. Remove credentials and private background notes from logs.

## Current limits

- Chrome is the tested browser. Other Chromium browsers and their stores have not been validated.
- Standard picture-in-picture does not include the extension's DOM caption layer.
- Live translation can lag, miss speech, or mistranslate names. It is an aid to understanding, not publication-ready subtitles.
- Whole-video subtitles start from YouTube's caption track. Words that the auto captions already misheard can only be guessed from context during translation, not reliably corrected.
- Reading caption tracks relies on undocumented YouTube endpoints and player behavior; server-side changes can break it.
- The current preview-model setup includes `systemInstruction` behavior observed in project testing. Treat it as an experimental dependency; future service changes may affect it.
- Context prompts are best-effort guidance, not a guarantee that a model will ignore all instructions embedded in source material.
- A long live-stream soak test across rotations, and an end-to-end browser test of whole-video subtitles with a real model, are still outstanding.

## Development

Use **Node.js 22 or later**. There are no npm dependencies to install.

```sh
npm run check
npm run package
```

`check` runs JavaScript syntax checks, version consistency, self-tests (audio, live captions, prompts, json3 parsing, segmentation, chunk validation, playback scheduling), session lifecycle regression tests, and whole-video subtitle task regression tests. `package` creates `dist/live-translate-extension-0.2.0.zip` with `manifest.json` at its root and only the runtime files.

The same checks and package verification run in GitHub Actions. Automated tests simulate browser callbacks, WebSockets, caption tracks, and model responses; they do not exercise real Gemini access, live audio capture, or YouTube's caption endpoint.

See [development notes](docs/development.md) for the file layout, protocol setup, and invariants. Keep changes focused and include a regression case when fixing a reproducible bug.

## History and license

This extension was extracted from the browser-extension branch of [LiveTranslate for Android](https://github.com/xieyuanqing/vtuber-live-translate). It now has its own codebase, checks, documentation, and releases. The Android project is not needed to build or run it.

This repository starts with a fresh Git history. The original browser work is available on [`feat/chrome-extension`](https://github.com/xieyuanqing/vtuber-live-translate/tree/feat/chrome-extension); the standalone baseline includes the 0.1.1 stability and popup improvements.

See [CHANGELOG.md](CHANGELOG.md) for release notes. Licensed under the [MIT License](LICENSE).
