# LiveTranslate for YouTube

[English](README.md) · [简体中文](README.zh-CN.md)

Translate YouTube live audio into captions inside the player, using your own Gemini API key. Keep listening to the original audio while reading the translation.

[![Checks](https://github.com/xieyuanqing/live-translate-extension/actions/workflows/check.yml/badge.svg)](https://github.com/xieyuanqing/live-translate-extension/actions/workflows/check.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Version 0.1.1.** A standalone Chrome Manifest V3 extension. The current interface is in Simplified Chinese. Install it manually for now; it is not listed in a browser extension store.

## What it does

- Captures audio from the YouTube player and sends it to Gemini for live translation.
- Shows translated captions inside the player, including fullscreen and theater mode.
- Can start automatically on live streams, with a manual start/stop button and an `Alt+T` shortcut.
- Lets you choose the source language, target language, and an editable scene prompt.
- Can include the title, channel, description, and your own background notes to help with names and context.
- Pauses audio submission while the player is paused, muted, or showing a detected advertisement.

This extension translates **audio**, rather than reading and translating YouTube's existing CC track. YouTube live streams are the primary use case; ordinary videos can be started manually.

## Install

1. Open [Releases](https://github.com/xieyuanqing/live-translate-extension/releases/latest) and download `live-translate-extension-0.1.1.zip`.
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
4. Choose a translation direction. The default is **Japanese → Chinese**.
5. Open a YouTube live stream. Automatic start is enabled by default once a key is configured; you can turn it off in Settings.

The extension currently uses `gemini-3.5-live-translate-preview`. Availability and API usage charges depend on your Gemini access and service plan. Installing this extension does not include API credits.

## Everyday controls

| Control | Behavior |
| --- | --- |
| Start / stop, or `Alt+T` | Controls translation in the current tab; original audio keeps playing. |
| 听什么 / 翻译成 | Selects the source and target language. |
| 场景 | Chooses a reusable scene prompt, such as VTuber, gaming, or general live streams. |
| 本场补充 | Adds temporary background for this video. It is cleared when you change videos or reload the page. |
| 应用当前设置并重新开始 | Restarts translation with your updated language, scene, and background. |
| Settings → caption appearance | Changes caption size, position, background, and line count immediately. |

Each session freezes its translation configuration. Reconnecting or rotating a connection keeps that snapshot; editing settings takes effect when you start a new session. Temporary notes are sent to the page as you type, so closing the popup does not discard the input.

Scene prompts, persistent background notes, and temporary notes are separate: scene prompts are reusable preferences; persistent notes are included in each session; temporary notes belong only to the current video.

## Data and credentials

There is no project-operated backend. **Translation is not offline:** audio and the enabled background information are sent directly to Gemini, or through the proxy you configure.

The API key, preferences, scene prompts, and persistent notes are stored in `chrome.storage.local`. The key is currently stored **without application-level encryption**. Temporary notes and captions stay in page memory; the extension does not save recordings or transcript files.

Use your own key on a computer you trust. Do not put keys in source code, issues, screenshots, or release packages. A custom proxy receives the requests routed through it, including the API key. Gemini's handling of submitted data is governed by the applicable Google service terms; this project cannot promise that the provider never retains data.

Public store distribution, including its consent flow and privacy disclosures, will be handled separately.

## Troubleshooting

| Symptom | Try this |
| --- | --- |
| The popup says the page is not connected | Refresh YouTube after installing or reloading the extension. The popup also provides a refresh button. |
| It cannot connect to Gemini | Check your key, model access, network, and configured proxy. |
| Connected, but no captions | Play spoken audio, unmute the player, and check the input-level bar in the popup. Silence alone does not mean the connection failed. |
| Captions overlap YouTube CC | Turn off YouTube CC or adjust the caption bottom position in Settings. |
| The popup shows a compatibility audio mode | AudioWorklet was unavailable and the extension is using ScriptProcessor as a fallback. Heavy page activity may affect capture. |

The implementation rotates connections every 505 seconds by default and reconnects after interruptions. A brief reconnection message can be normal. If a problem persists, [open an issue](https://github.com/xieyuanqing/live-translate-extension/issues) with your Chrome version, extension version, and steps to reproduce. Remove credentials and private background notes from logs.

## Current limits

- Chrome is the tested browser. Other Chromium browsers and their stores have not been validated.
- Standard picture-in-picture does not include the extension's DOM caption layer.
- Live translation can lag, miss speech, or mistranslate names. It is an aid to understanding, not publication-ready subtitles.
- The current preview-model setup includes `systemInstruction` behavior observed in project testing. Treat it as an experimental dependency; future service changes may affect it.
- Context prompts are best-effort guidance, not a guarantee that a model will ignore all instructions embedded in source material.
- Long sessions across multiple connection rotations still need a dedicated browser soak test.

## Development

Use **Node.js 22 or later**. There are no npm dependencies to install.

```sh
npm run check
npm run package
```

`check` runs JavaScript syntax checks, version consistency, audio/subtitle/prompt self-tests, and session lifecycle regression tests. `package` creates `dist/live-translate-extension-0.1.1.zip` with `manifest.json` at its root and only the runtime files.

The same checks and package verification run in GitHub Actions. Automated tests simulate browser callbacks and WebSockets; they do not exercise real Gemini access or live audio capture.

See [development notes](docs/development.md) for the file layout, protocol setup, and invariants. Keep changes focused and include a regression case when fixing a reproducible bug.

## History and license

This extension was extracted from the browser-extension branch of [LiveTranslate for Android](https://github.com/xieyuanqing/vtuber-live-translate). It now has its own codebase, checks, documentation, and releases. The Android project is not needed to build or run it.

This repository starts with a fresh Git history. The original browser work is available on [`feat/chrome-extension`](https://github.com/xieyuanqing/vtuber-live-translate/tree/feat/chrome-extension); the standalone baseline includes the 0.1.1 stability and popup improvements.

See [CHANGELOG.md](CHANGELOG.md) for release notes. Licensed under the [MIT License](LICENSE).
