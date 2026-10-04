# Changelog

## 0.4.5 — unreleased (2026-10-05)

- Add text-interface presets for DeepSeek, SiliconFlow, Ark, Bailian (Beijing/Singapore), OpenRouter, Groq and Moonshot alongside OpenAI/Gemini. Presets create independent configurations without changing credentials or feature assignments.
- Replace the native model datalist with an editable, searchable combobox. Opening the arrow shows all fetched models even when a model is already filled in; support keyboard selection and unrestricted manual IDs. Keep the popup within the viewport and discard stale requests after editing or switching configurations.
- Add custom header name/value rows for both text protocols, model discovery and generation, direct requests and background relay. Support header-only authentication across captions, background generation, comments and selection translation. Hide values by default; omit headers from default backups, preserve local headers during credential-free imports, and redact them from diagnostics.
- Add a chat-interface tab and folded, explicitly unavailable live/chat/MT/TTS candidate entries. Existing live, local chat and speech providers remain the only working implementations.
- Syntax/self-tests and 155 simulated regressions pass. Isolated Chromium checks at 1440/390 px in both themes cover list/filter/keyboard/manual entry, custom headers, preset isolation and candidate entries without script errors or horizontal overflow. Permission/network substitutes do not verify native dialogs or real accounts.

- Preserve a metadata description limit of zero instead of replacing it with the default of 1,200 characters.
- Consolidate purpose-specific provider normalization and use a no-op live logger when diagnostics are disabled.
- Remove redundant exception handling around socket closure, cancellation and fixed DOM operations; report subtitle status callback failures while preserving external-data and session-race handling.
- Split live and whole-video startup into named stages, keeping frozen inputs, generation checks, cache reuse and playback-position priority.
- Keep development notes focused on structure and invariants, and clarify third-party provenance wording without changing license obligations. Existing features and storage field names remain unchanged.
- Each refactoring step passes syntax checks, self-tests and all 144 simulated regressions; the zero-limit fix adds two self-test assertions. Packaging and source/archive consistency checks pass. Real Chrome/YouTube/model smoke testing remains pending because browser automation could not reliably identify the active URL and stopped before interaction.

## 0.4.4 — unreleased (2026-10-04)

- Reorganize the nine Settings pages into Start, Features, and Appearance & Data. Keep existing routes and credentials, rename the API section to 接口, and use one interface dropdown on each feature page. Interface editing contains addresses, keys, models, browser permission and tests.
- Add an independent comment interface choice. Older settings initially inherit the subtitle interface, then save comments separately; keep the new choice through backup/import/reset rules and invalidate pending comment requests when it changes.
- Combine selected-text translation and reading under 划词与朗读. Move the shared theme, subtitle controls and comment/chat appearance into 外观 with three tabs; group subtitle controls into layout, text and background, with a desktop-only sticky preview.
- Fold prompt previews, diagnostic logs and developer commands into 高级与关于. Remove duplicate introductions and nested card styling, use monochrome navigation, and show a compact permission scope/status/action row with folded help. Keep Qwen's all-sites scope visible and preserve request cancellation after denied or stale authorization.
- Expand the selected live configuration while allowing manual editing of alternatives without switching usage. Use dropdown navigation and a text-interface picker at narrow widths. Add first-use guidance that distinguishes missing fields, host permission and exact-configuration generation-test results.
- Share port-free host permission patterns across Settings authorization, background relays, selected-text translation and Gemini TTS. Keep ports in actual request URLs, fixing local gateways that were authorized in Settings but still rejected by runtime permission checks.
- When restoring defaults with interfaces kept, retain text/live/speech keys, addresses, configurable models, provider choices and independent feature ids.
- Syntax checks for 66 JavaScript files, self-tests and all 144 simulated regressions pass. An isolated in-memory Chromium fixture passes all nine pages, independent assignments, denied permission, stale test results and three appearance tabs at 1440/1024/390 px in both themes, with no script errors or horizontal overflow. For two example interfaces with advanced details folded and first-use guidance visible, the 390 px text-interface page measures 1,413 px versus the earlier 2,314 px screenshot. Permission/model substitutes do not verify native Chrome dialogs, service accounts or current YouTube flows.

## 0.4.3 — unreleased (2026-10-03)

- Consolidate text, live and speech connection settings under Services & APIs. Keep independent configurations and feature selections; feature pages link directly to the relevant connection category. Edit one text configuration at a time in a list-and-editor layout.
- Put domain authorization immediately below the endpoint, with a shared status/control for text APIs, Gemini TTS and Qwen's special connection permission. Model queries and generation tests request the required host permission first; denial prevents a request. Endpoint changes invalidate pending permission checks. Only concurrency and request routing remain under Advanced.
- Distinguish endpoint/model queries from a small paid generation test. Existing addresses, keys, model choices and optional permissions remain intact. Browser UI checks use isolated fixtures; real account and native permission-dialog validation remain separate.
- Syntax/self-tests and 124 simulated regressions pass. Isolated Chromium checks all Settings pages, service navigation, independent assignments, denied authorization and changed endpoints in both themes at 1440/1024/390 px. Delayed checks or grants cannot authorize the new endpoint or launch a model query there.

## 0.4.2 — unreleased (2026-10-03)

- Redraw the selection panel's action icons and dropdown chevrons with consistent rounded strokes. The pin now has a clear pushpin outline: tilted when free, upright with a subtle fill when fixed.
- Redesign the right-click selection panel around two compact cards: original speech beside the original, icon-only copy/retranslate beside the translation, and translation-model/speech-provider selectors in one footer. Move speech rate out of the panel; the existing speech Settings page remains its control.
- Add a target-language selector and a position pin to the header. Cancel and restart translation when the target changes; validate and freeze the target per request. Show a small in-card loading state, use the speaker itself to stop playback, show short toasts for provider changes, collapse long originals to five lines, and leave translations unconstrained except by the viewport.
- One new simulated target-language regression passes. An isolated Chromium fixture checks provider and language routing, pinning, speech stop, loading, long-text expansion, and 390 px fit. Real YouTube and Gemini TTS validation remain pending.

## 0.4.1 — unreleased (2026-10-03)

- Put the original-text speaker and its playback stop control beside the original in the selection panel. Add independent dropdowns for selection translation-model configurations and Microsoft/Gemini speech; switching the text model cancels the previous request, persists the choice and retranslates. Older settings inherit the prior subtitle model once, then keep the selection independently.
- Replace the colorful ON/OFF badge and adjacent play/stop control in YouTube with one monochrome, native-sized button. It starts/stops live translation, starts/cancels whole-video translation, and toggles finished whole-video captions. Live caption visibility is now also available in the extension popup.
- Syntax/self-tests and 120 simulated regressions pass. An isolated Chromium fixture checks the one-button control, speaker placement, model routing and persistence, speech switching, and a 390 px selection panel. The updated control has not yet been tested on a real YouTube page; real Gemini TTS and live/whole-video model actions remain unverified.

## 0.4.0 — unreleased (updated 2026-10-03)

- Move chat translation status and the first-use local-model preparation control into the extension popup; remove the injected toolbar above YouTube chat. The popup starts required Chrome model downloads from its own click before asking the chat frame to resume.
- Place a Liuyi ON/OFF caption button and a separate translation play/stop button inline in YouTube's bottom right player controls, following Read Frog's control-bar placement. Remove the former top-right overlay and its menu; other settings remain in the extension. Hiding live captions does not stop capture or model usage.
- Compact the selection translation panel and make its header draggable, retaining a manually chosen position through content changes and scrolling.
- Syntax/self-tests and 118 simulated regressions pass. Isolated Chromium fixtures verify the inline player controls do not toggle playback, live-caption hiding survives the gate timer, the chat toolbar stays absent, the popup fits at 420 px, and the selection panel stays positioned after dragging and translation growth. A real YouTube watch page in isolated Chromium confirms the buttons mount as the first child of `.ytp-right-controls`, without a floating menu. First-use Chrome language-pack downloads and live/whole-video model actions still need user testing.
- Add right-click selection translation using the existing subtitle text model and target language, plus reading the original text in Japanese/English. Latin-only letters use English; all other selections use Japanese, including Han-only words. No pronunciation dictionary or separate language-detection model.
- Add Microsoft consumer Neural speech as the default (Nanami/Jenny) and configurable Gemini TTS as a second provider, with independent keys/models/voices, key reuse, language-specific previews, and three playback speeds. Support legacy PCM-to-WAV output and newer WAV responses. Actual free quota depends on the Gemini project.
- Add a light/dark panel beside the selected sentence showing original/translation, with manual playback, stop, replay, copy and provider switching. A single **翻译与朗读** menu injects into the selected frame; a restricted frame can use its parent page, without opening another page/window. Reposition for translation height, scrolling and viewport edges. Background synthesis/offscreen playback share one cancellable task, bounded memory cache, stale-result checks and resource cleanup. Pending previews also cancel while settings are still saving.
- Retain the original MIT core; attribute the Read Frog-derived Microsoft adapter and include its source and GPLv3 license in the repository and runtime package. The combined package is not described as entirely MIT; see `docs/third-party-tts.md`.
- Syntax/self-tests and all 113 simulated regressions pass, covering language rules, UTF-8 splitting, request schemas/audio formats, key redaction, cancel/replay/navigation races, selected frames, same-page frame fallback, pending settings saves and audio URL release. Real Microsoft Japanese/English synthesis and offscreen playback pass in isolated Chromium. A real AudioTap worklet stays silent while offscreen speech plays with a silent video; offscreen recreation also passes. Gemini/selection-model browser checks use network substitutes; real Gemini synthesis, subjective voice quality and the user's current YouTube integration remain unverified.
- Make the speech replay regression wait for synthesis/playback milestones instead of fixed event-loop turns, so native WebCrypto completion does not race the assertions on Linux CI.

## 0.3.5 — unreleased (2026-10-02)

- Fixed black comment translations on dark YouTube pages when the actual source text color is scoped to an inner attributed-string node. Read the original text's computed color instead of relying on a generic YouTube variable inherited by the injected sibling. Theme changes update existing results without new requests, including hidden results.
- Gave comment actions, status text, focus outlines, and disabled controls explicit readable light/dark colors following YouTube's own theme. The extension popup theme remains independent; custom translation styles are retained.
- Syntax/self-tests and all 101 simulated regressions pass. Offline Chrome fixtures reproduce the 0.3.4 black-text failure with scoped original colors, then verify 0.3.5 at 1440/390 px under both themes, live theme switching without retranslation, collapsed comments, replies, chat, and all existing appearance presets. Actual user Chrome/YouTube validation remains outstanding.

## 0.3.4 — unreleased (2026-10-02)

- Fixed custom YouTube emote names and hover-tooltip text being treated as message/comment text. Preserve original images and Unicode emoji, ignore custom image names and tooltip DOM, and translate only the actual message. Emote-only messages remain skipped; hovering does not change the translation/cache identity.
- Fixed the action popup collapsing into a narrow column by setting a 420 px intrinsic root/body width and removing its viewport-dependent maximum. Keep the brand and header controls on one line.
- Protected pending theme choices from late reads and earlier save events; Settings writes run serially so rapid changes retain the last selection.
- Added a shared system/light/dark preference to General settings and a popup theme toggle. Dark surfaces use soft neutral grays, readable text, and restrained blue actions. Settings, controls, errors, model cards, and prompts follow the selected theme; webpage translation-style previews remain independent.

- Syntax/self-tests and all 100 simulated regressions pass. Offline Chrome covers eight Settings sections at 1440/1024/390 px, system/manual themes, delayed saves, popup states at 420 px, and image-emote hover filtering with actual content scripts against simulated DOM/models. Real YouTube/native model validation remains outstanding.

## 0.3.3 — unreleased (2026-10-02)

- Redesigned Settings and the extension popup with a shared iOS-inspired light palette, white rounded groups, blue actions, native inputs styled as switches, consistent spacing, and readable warning/error colors. The interface stays light even when the operating system uses dark mode.
- Added grouped sidebar navigation with icons and retained the narrow-screen scrolling navigation. Updated model cards, text-style choices, segmented controls, prompts, logs, caches, and subtitle preview surfaces to match the light interface. Translation-style previews start with a light webpage; an optional dark webpage sample remains available.
- Moved popup language choices above the translation action and placed expandable context details after the chat/comment shortcuts. Connection statistics and audio level appear while translation is active, leaving idle controls compact. Existing settings, session behavior, caches, and translation styles are retained.
- Syntax/self-tests and all 96 simulated regressions pass. Offline Chrome checks cover eight Settings sections at 1440/1024/390 px under light/dark system appearance, all translation-style choices, switch/language saves, and popup live/video/error/no-tab states including context preview, start/stop, and subtitle cancellation. Real YouTube/native model validation remains outstanding.

## 0.3.2 — unreleased (2026-10-02)

- Added 12 translation appearance presets in Settings → chat/comments: plain, text color, underline, dotted, dashed, wavy, highlight, marker, quote, border, bold, and muted. Comments and chat independently save a preset and accent color; existing settings retain the plain appearance.
- Added visual preset cards, dark/light page previews using the production renderer/CSS, a color picker, and reset for the selected scope, inspired by the preset-and-preview settings in Read Frog and KISS Translator.
- Changes apply immediately to existing results and subsequent translations without another model call, resetting chat language models, losing collapsed comments, or invalidating prepared live context. The presets retain source typography and paid-message colors except when a text-color or bold/muted preset is explicitly selected.
- Syntax/self-tests and all 96 simulated regressions pass. Offline Chrome checks cover all presets, independent saves/colors, scope-specific reset, keyboard selection, dark/light previews and 1440/390 px layouts. Runtime checks confirm style changes preserve result text, collapsed comments and model request counts. Real YouTube/native model validation remains outstanding.


## 0.3.1 — unreleased (2026-10-02)

- Chat skips emoji-only/image-emote messages, numeric-only spam, laughter (`www`, `草`), and standalone short reactions such as KAWAII, LOL, NT, NICE, and GG before queueing or language detection. Matching ignores case, full-width forms, punctuation, and surrounding emoji; normal sentences containing those words still translate.
- Reworked comment and chat translation display to follow the original text with matching typography, using the bilingual insertion approach in KISS Translator and Read Frog as a reference. Removed comment result borders, per-result language labels, and boxed translation buttons. Comment actions now follow the translation and include hide/show without another model request.
- Placed comment results outside YouTube's collapsed-text container. Chat results are plain spans inside their source message, preserving paid/membership colors and avoiding outer flex-layout displacement. Source extraction excludes injected translations and preserves line breaks, link text, and image-emoji alternatives; message redraws can restore cached results.
- Offline Chrome layout checks cover dark/light themes at 1440/390 px, long comments, expanded replies, paid/membership messages, hide/show, chat redraws/recycled nodes, and replay chat. Reaction tests also confirm filtered messages never reach translation, normal sentences still translate, and recycled rows lose their old translation when replaced with a reaction. Native Chrome translation models and current YouTube DOM compatibility still require real-browser validation.
- Syntax checks, algorithm self-tests, and all 94 simulated regressions pass. The runtime ZIP and stable unpacked loading directory contain the updated 0.3.1 source; preview/test data are excluded.

## 0.3.0 — unreleased (2026-10-01)

- Refreshed Settings with a clearer sidebar, section headings, softer dark colors, consistent controls and spacing, and two prominent model-role selectors. Offline browser checks cover all eight sections at desktop and narrow widths, independent model saves, feature switches, and popup startup; real YouTube/model testing remains outstanding.
- Added independently enabled YouTube chat and comment translation, both off by default. Chat uses Chrome's local Translator API with language-pack preparation, optional language detection, a bounded queue, and translations below the original message. Comments and expanded replies use the subtitle text model on individual clicks or for currently visible comments, validate the complete numbered response, and support cancellation and page-memory reuse. Settings and the popup expose both switches. Automated checks passed; actual chat API availability and live comment translation require real-browser validation.
- Removed scene-template selection from live translation and scene text from Gemini live prompts. Combined temporary notes with the stream-context viewer, and replaced the scene statistic with actual context/term status. Existing scene preferences remain under advanced whole-video subtitle settings.
- Separated AI context-generation and whole-video subtitle model selections. Both use OpenAI-compatible chat/completions or Gemini endpoints; new configurations default to OpenAI-compatible format and existing API types are preserved. Replaced the context generator's eight-second abort with a configurable 30/60/120-second deadline (60 by default), and added the actual generator model, deadline, and error to its review and diagnostics.
- Added a popup viewer for pre-session generator inputs/results and the exact frozen Gemini prompt or Qwen translation configuration, with copy support. A pre-start preview captures no audio and is reused once if its inputs match; input changes and navigation invalidate it. Saved detailed logs also expose a prompt viewer.
- Prioritized verified streamer names/readings and current-stream terms in context generation, reserving a term slot for the channel name when identifiable. This is a terminology safeguard, not a claim of improved recognition accuracy.
- Fixed Qwen's 120-second rotation referencing an undefined socket: send `session.finish`, accept tail results, and wait up to three seconds before replacing the connection. Qwen captions now preserve legitimate repetitions and deduplicate by protocol identifiers instead of guessing text overlap; Gemini retains its existing stabilizer behavior.
- Added generator input, playback position, Qwen event/output identifiers, close reasons, and sent/queued/dropped audio counts to diagnostic logs. Added simulated preview-reuse/cancellation, rotation-tail, and repetition regressions; live model quality still requires fresh stream validation.

- Added a live-model selector. Gemini 3.5 remains the default; Qwen 3.8 LiveTranslate uses its Bailian workspace WebSocket, text-only output, source transcription, and optional terminology pairs. The existing whole-video caption mode is unchanged.
- Added an optional pre-session text-model request that condenses the current video's title and description into short context and up to 12 candidate terms. Gemini receives the result in its session prompt; Qwen receives only its supported term mappings. Failed or unavailable requests do not prevent a live session from starting.
- Qwen WebSocket authentication uses an optional Chrome host permission and a temporary, tab- and URL-scoped request-header rule. The rule is removed after handshake, on cancellation, and after a service-worker restart.
- Tightened the Gemini live prompt to preserve speakers, questions, negation, and uncertain proper names. Added simulated protocol, authorization, and session-cancellation regressions; these do not establish real-browser quality or sustained upstream availability.
- Added opt-in live diagnostic logs with basic state/timing mode and detailed prompt/transcription/translation mode. Logs are saved per session in local extension storage, bounded to 3,000 events and the 20 most recent completed sessions, redact configured API keys, and can be exported per session or in bulk from Settings. Raw audio is not recorded.

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
