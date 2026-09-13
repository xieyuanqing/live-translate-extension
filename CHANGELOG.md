# Changelog

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
