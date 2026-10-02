(() => {
  const LT = globalThis.LT;
  const $ = (id) => document.getElementById(id);

  let tabId = null;
  let settings = LT.DEFAULTS;
  let status = null;
  let timer = null;
  let busy = false;
  let settingsSave = Promise.resolve();
  let contextReview = null;
  let contextRevision = -1;
  let contextTabVideoId = '';
  let contextLoading = false;
  let textStatus = null;

  const CONN_LABEL = {
    '': '未开始',
    connecting: '连接中…',
    reconnecting: '重连中…',
    rotating: '切换连接…',
    ready: '翻译中',
    stopped: '已停止',
  };

  function fillSelect(el, items, value) {
    el.replaceChildren();
    for (const it of items) {
      const opt = document.createElement('option');
      opt.value = it.id || it.code;
      opt.textContent = it.label;
      el.appendChild(opt);
    }
    el.value = value;
  }

  async function send(type, payload) {
    if (tabId == null) return null;
    try {
      return await chrome.tabs.sendMessage(tabId, { type, payload }, { frameId: 0 });
    } catch (_) {
      return null; // 内容脚本还没注入（比如刚装完扩展没刷新页面）
    }
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  function banner(text, kind) {
    const el = $('banner');
    el.classList.toggle('hidden', !text);
    el.classList.toggle('info', kind === 'info');
    el.textContent = text || '';
  }

  // ---------- 整片字幕区块 ----------

  function renderVideo() {
    const v = status && status.video;
    const show = !!status && status.onWatchPage && !status.isLive && !!v;
    $('vsBox').classList.toggle('hidden', !show);
    if (!show) return;

    const working = v.phase === 'reading' || v.phase === 'translating';
    const pct = v.total ? Math.round((v.done / v.total) * 100) : 0;
    const target = LT.targetLabel(v.targetLang || settings.targetLang);
    const stale = v.staleConfig || (v.targetLang && v.targetLang !== settings.targetLang);
    let state = '';
    let hint = '';
    let startLabel = '翻译整片字幕';
    switch (v.phase) {
      case 'reading':
        state = '读取字幕轨…';
        break;
      case 'translating':
        state = `翻译中 ${pct}%` + (v.frontierIdx >= 0 ? ` · 可看到 ${fmtClock(v.frontierMs)}` : ' · 正在翻译当前位置');
        hint = '翻好的部分会立刻显示，可以边看边等。拖到没翻的地方会优先翻那里；关闭弹窗不影响。';
        break;
      case 'ready':
        state = v.fromCache ? '已就绪（缓存）' : '已就绪';
        hint = stale
          ? `当前缓存：${v.trackLabel || '字幕轨'} → ${target}。设置已变化，按新设置翻译请点「重新翻译」。`
          : `${v.trackLabel || '字幕轨'} → ${target} · 共 ${v.unitCount} 条${v.saveError ? ' · 缓存未保存' : ''}`;
        break;
      case 'partial':
        state = `已翻译 ${v.done}/${v.total} 块` + (v.failed ? `，${v.failed} 块失败` : '');
        startLabel = '继续翻译';
        hint = stale
          ? `当前缓存译成${target}，设置已变化。恢复原设置后可续翻，或点「重新翻译」使用新设置。`
          : '继续会复用已完成的片段，只翻剩下的。';
        break;
      case 'error':
        state = '出错';
        startLabel = '重试';
        hint = v.error || '';
        break;
      default:
        if (v.hasCache) {
          state = v.cachedComplete ? '已有缓存' : '已有部分缓存';
          startLabel = v.cachedComplete ? '加载缓存字幕' : '继续翻译';
        } else {
          state = '未翻译';
          hint = '读取这个视频的字幕轨，用文字模型整片翻译并缓存；再看同一视频不再花额度。';
        }
        break;
    }
    $('vsState').textContent = state;
    $('vsProgress').style.width = `${v.phase === 'ready' ? 100 : pct}%`;
    $('vsProgressBar').setAttribute('aria-valuenow', String(v.phase === 'ready' ? 100 : pct));
    $('vsStart').textContent = startLabel;
    $('vsStart').classList.toggle('hidden', working || v.phase === 'ready');
    $('vsStart').disabled = busy;
    $('vsCancel').classList.toggle('hidden', !working);
    const hasTexts = v.done > 0 || v.frontierIdx >= 0 || v.phase === 'translating';
    $('vsToggle').classList.toggle('hidden', !hasTexts);
    $('vsToggle').textContent = v.visible ? '隐藏字幕' : '显示字幕';
    $('vsRetranslate').classList.toggle('hidden', working || !(v.phase === 'ready' || v.phase === 'partial'));
    $('vsHint').textContent = hint;
  }

  function renderStatus() {
    const running = !!status && status.phase !== 'idle';
    const liveFocus = running || !!status?.isLive;
    $('liveDetails').classList.toggle('hidden', !running);
    $('toggle').classList.toggle('primary', liveFocus);
    $('toggle').classList.toggle('ghost', !liveFocus);
    $('toggle').classList.toggle('secondary', !liveFocus);
    const dot = $('dot');
    // classList.add('') 会抛异常，所以先算出类名再决定加不加
    const dotKind = !status
      ? ''
      : status.error
        ? 'err'
        : status.conn === 'ready'
          ? 'ok'
          : running
            ? 'warn'
            : '';
    dot.className = dotKind ? `dot ${dotKind}` : 'dot';

    $('toggle').textContent = status?.phase === 'starting' ? '取消启动' : running ? '停止实时翻译' : '开始实时翻译';
    $('toggle').classList.toggle('on', running);
    $('toggle').disabled = busy || !status || !status.onWatchPage;
    $('reloadPage').classList.toggle('hidden', !!status || tabId == null);
    $('restart').classList.toggle('hidden', !running);
    $('restart').disabled = busy;
    $('contextBox').classList.toggle('hidden', !status?.onWatchPage);
    $('previewContext').disabled = busy || running || !!status?.previewBusy;
    if (status?.previewBusy) $('contextState').textContent = '正在整理背景与术语…';

    $('stConn').textContent = status?.error || CONN_LABEL[status?.conn || ''] || status.conn;
    $('stConn').style.color = status?.error ? 'var(--err)' : '';
    $('stDir').textContent = status?.direction || `${LT.sourceLabel(settings.sourceLang)} → ${LT.targetLabel(settings.targetLang)}`;
    const qwen = (status?.liveProvider || settings.liveProvider) === 'qwen';
    $('stContext').textContent = status?.contextStatus === 'generated'
      ? `${qwen ? '词表' : 'AI 背景'} · ${status.generatedTerms || 0} 组术语`
      : status?.phase === 'starting' ? '准备中…'
      : status?.contextStatus === 'error' ? '整理失败'
      : qwen ? '无自动词表' : '基础规则';
    $('stTime').textContent = fmtTime(status?.elapsedMs);
    $('level').style.width = `${running ? status.level : 0}%`;

    renderVideo();

    if (!status) {
      $('videoTitle').textContent = tabId == null ? '打开一个 YouTube 直播或视频' : '当前页面尚未连接';
      $('videoMeta').textContent = tabId == null ? '字幕会直接显示在播放器里' : '安装或更新插件后，刷新页面即可恢复';
      $('tempContext').disabled = true;
      $('tempHint').textContent = '';
      $('hint').textContent = 'Alt+T · 开始 / 停止实时翻译';
      banner('', '');
      return;
    }
    if (!status.onWatchPage) {
      $('videoTitle').textContent = '当前不是 YouTube 视频页';
      $('videoMeta').textContent = '打开一个直播或视频页面再试';
    } else {
      $('videoTitle').textContent = status.title || '（正在读取视频信息…）';
      $('videoMeta').textContent = [
        status.isLive ? '直播中' : '录播/点播',
        status.usedMetadata ? '已注入标题简介' : '',
        status.usedTemp ? '已注入临时补充' : '',
        status.mode === 'script-processor' ? '兼容音频模式' : '',
      ]
        .filter(Boolean)
        .join(' · ');
    }

    // 临时补充输入框：状态里存的是内容脚本的当前值，没在打字时才回填，避免打断输入
    const ta = $('tempContext');
    const temp = status.tempContext || '';
    if (document.activeElement !== ta && ta.value !== temp) ta.value = temp;
    ta.disabled = !status.onWatchPage;
    $('tempHint').textContent = qwen
      ? !settings.generateLiveContext || !settings.useMetadata
        ? '千问只接收词表；需启用 AI 整理和标题简介，才能将补充用于词表整理。'
        : running ? '修改后重新开始，会重新整理词表。' : '生成预览或开始时参与词表整理；换视频或刷新后清空。'
      : running ? '修改后点下方「应用当前设置」即可生效。' : '生成预览或开始时生效；换视频或刷新后清空。';

    const liveKey = settings.liveProvider === 'qwen' ? settings.qwenApiKey : LT.Settings.keyList(settings).length;
    if (!liveKey && !LT.Settings.provider(settings).apiKey) {
      const cached = !!status.video?.hasCache && !status.isLive;
      banner(cached ? '缓存可直接观看；翻译新内容需配置 API Key。' : '还没有填 API Key，先去设置里填一个再开始。', cached ? 'info' : '');
    } else if (running && status.phase === 'running') {
      banner('', '');
    } else if (settings.autoStartLive && status.onWatchPage && status.isLive) {
      banner('直播页会自动开始翻译。', 'info');
    } else {
      banner('', '');
    }

    $('hint').textContent = running
      ? ''
      : 'Alt+T · 开始 / 停止实时翻译（音频）';
  }

  async function refresh() {
    status = await send(LT.MSG.QUERY_STATUS);
    textStatus = await send(LT.MSG.QUERY_TEXT_STATUS);
    renderStatus();
    renderTextStatus();
    if ($('contextBox').open) await refreshContext();
  }

  function renderTextStatus() {
    const show = !!status?.onWatchPage;
    $('textBox').classList.toggle('hidden', !show);
    $('chatTranslationToggle').checked = !!settings.enableChatTranslation;
    $('commentTranslationToggle').checked = !!settings.enableCommentTranslation;
    const comments = textStatus?.comments;
    $('translateVisibleComments').disabled = !show || !settings.enableCommentTranslation || !!comments?.busy;
    $('cancelCommentTranslation').disabled = !comments?.busy;
    const chat = textStatus?.chat;
    const chatLabels = { off: '已关闭', waiting: '请在聊天区准备语言包', preparing: '准备/下载语言包中', ready: '本地翻译中', error: '不可用' };
    const lines = [];
    if (settings.enableChatTranslation) lines.push(chat
      ? `聊天：${chat.error || chatLabels[chat.phase] || chat.phase}${chat.translated ? ` · 已译 ${chat.translated} 条` : ''}`
      : '聊天：请在 YouTube 聊天区查看本地翻译状态');
    if (settings.enableCommentTranslation) lines.push(comments?.error ||
      (comments?.busy ? `评论：等待/翻译中 ${comments.pending || 0} 条` : `评论：按需翻译${comments?.translated ? ` · 已译 ${comments.translated} 条` : ''}`));
    $('textState').textContent = lines.join('\n') || '两项独立开关，不需要启动字幕翻译。';
  }

  for (const [id, key] of [['chatTranslationToggle', 'enableChatTranslation'], ['commentTranslationToggle', 'enableCommentTranslation']]) {
    $(id).addEventListener('change', event => {
      const checked = event.target.checked;
      settingsSave = settingsSave.then(async () => {
        settings = await LT.Settings.save({ [key]: checked });
        await send(LT.MSG.SETTINGS_CHANGED);
        await refresh();
      }).catch(() => { $('textState').textContent = '保存失败，请重新打开弹窗后重试。'; });
    });
  }
  $('translateVisibleComments').addEventListener('click', async () => {
    await settingsSave;
    const result = await send(LT.MSG.TRANSLATE_VISIBLE_COMMENTS);
    await refresh();
    if (!result?.ok) $('textState').textContent = result?.error || '页面未响应，请刷新 YouTube 后重试。';
    else if (!result.count) $('textState').textContent = '当前没有可见的文字评论，请滚到评论区或展开回复。';
  });
  $('cancelCommentTranslation').addEventListener('click', async () => {
    await send(LT.MSG.CANCEL_COMMENT_TRANSLATION);
    await refresh();
  });
  $('openTextOptions').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/options.html#text') }));

  function renderContext() {
    const r = contextReview;
    $('contextContent').classList.toggle('hidden', !r);
    $('copyContext').disabled = !r;
    if (!r) {
      $('contextState').textContent = status?.previewBusy ? '正在整理背景与术语…' : '可在开始翻译前生成，检查后再开始。生成会调用单独选定的 AI 整理模型。';
      return;
    }
    const labels = { generated: '已生成背景和术语', disabled: '开播整理已关闭', no_metadata: '没有启用或读到页面资料', unavailable: '文字模型配置不完整，未生成', error: '整理失败，使用基础配置' };
    $('contextState').textContent = (r.phase === 'preview' ? '开播预览 · 尚未开始翻译 · ' : '本场启动时冻结 · ') +
      (labels[r.contextStatus] || r.contextStatus) + (r.generatorModel ? ` · 整理模型：${r.generatorModel}` : '') +
      (r.contextTimeoutSeconds ? ` · 等待上限 ${r.contextTimeoutSeconds} 秒` : '') + (r.contextError ? `：${r.contextError}` : '');
    if (r.stale) $('contextState').textContent = '输入已变化，这份预览已失效；请重新生成，或开始时重新整理。';
    $('contextEffect').textContent = r.provider === 'qwen'
      ? '千问只接收下方术语映射和目标语言；背景说明、场景提示词不发送给千问。'
      : '下方是本场 Gemini 使用的完整提示词。运行中修改设置需重新开始才生效。';
    const terms = Object.entries(r.generated?.phrases || {});
    $('generatedContext').value = [r.generated?.background || '没有生成背景', '', '候选术语：', ...terms.map(([a, b]) => `${a} → ${b}`), ...(terms.length ? [] : ['无'])].join('\n');
    $('effectivePromptLabel').textContent = r.provider === 'qwen' ? '发送给千问的目标语言与术语配置' : '发送给 Gemini 的完整提示词';
    $('effectivePrompt').value = r.provider === 'qwen' ? JSON.stringify({ type: 'session.update', session: { output_modalities: ['text'], translation: r.translation } }, null, 2) : r.prompt;
    $('generatorPrompt').value = r.generatorRequest ? `【系统提示词】\n${r.generatorRequest.system}\n\n【页面资料与补充】\n${r.generatorRequest.user}` : '本次未启用开播整理，没有整理模型输入。';
  }

  async function refreshContext(force = false) {
    if (!status || contextLoading) return;
    if (!force && contextRevision === status.liveReviewRevision && contextTabVideoId === status.videoId) return;
    contextLoading = true;
    const videoId = status.videoId;
    const revision = status.liveReviewRevision;
    try {
      const result = await send(LT.MSG.QUERY_LIVE_CONTEXT);
      if (videoId !== status?.videoId) return;
      contextReview = result?.review || null;
      contextRevision = revision;
      contextTabVideoId = videoId;
      renderContext();
    } finally { contextLoading = false; }
  }

  $('contextBox').addEventListener('toggle', () => { if ($('contextBox').open) refreshContext(true); });
  $('previewContext').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    renderStatus();
    $('contextState').textContent = '正在生成开播预览…';
    try {
      await settingsSave;
      await send(LT.MSG.SET_TEMP_CONTEXT, $('tempContext').value);
      const result = await send(LT.MSG.PREVIEW_LIVE_CONTEXT);
      if (!result?.ok) throw new Error(result?.error || '页面没有响应，请刷新 YouTube 后重试');
      await refresh();
      await refreshContext(true);
    } catch (err) { $('contextState').textContent = err.message || '生成失败'; }
    finally { busy = false; renderStatus(); }
  });
  $('copyContext').addEventListener('click', async () => {
    if (!contextReview) return;
    try {
      await navigator.clipboard.writeText([$('contextState').textContent, $('contextEffect').textContent,
        $('generatedContext').value, $('effectivePrompt').value, $('generatorPrompt').value].join('\n\n'));
      $('contextState').textContent = '已复制背景、术语、整理输入和本场翻译配置。';
    } catch (_) { $('contextState').textContent = '复制失败，请在文本框中全选复制。'; }
  });

  async function init() {
    $('version').textContent = chrome.runtime.getManifest().version;
    settings = await LT.Settings.load();
    fillSelect($('sourceLang'), LT.SOURCE_LANGS, settings.sourceLang);
    fillSelect($('targetLang'), LT.TARGET_LANGS, settings.targetLang);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && /^https:\/\/www\.youtube\.com\//.test(tab.url || '')) {
      tabId = tab.id;
    }
    await refresh();
    timer = setInterval(refresh, 1000);
  }

  async function changeSession(restart = false) {
    if (busy) return;
    const context = $('tempContext').value;
    busy = true;
    renderStatus();
    try {
      await settingsSave;
      const running = !!status && status.phase !== 'idle';
      if (running) await send(LT.MSG.STOP);
      if (!running || restart) {
        await send(LT.MSG.SET_TEMP_CONTEXT, context);
        await send(LT.MSG.START);
      }
      await refresh();
    } finally {
      busy = false;
      renderStatus();
    }
  }
  $('toggle').addEventListener('click', () => changeSession());
  $('restart').addEventListener('click', () => changeSession(true));
  $('reloadPage').addEventListener('click', async () => {
    if (tabId == null) return;
    await chrome.tabs.reload(tabId);
    window.close();
  });

  // ---------- 整片字幕操作 ----------

  async function videoAction(fn) {
    if (busy) return;
    busy = true;
    renderStatus();
    try {
      await settingsSave;
      await fn();
      await refresh();
    } finally {
      busy = false;
      renderStatus();
    }
  }
  $('vsStart').addEventListener('click', () =>
    videoAction(async () => {
      await send(LT.MSG.SET_TEMP_CONTEXT, $('tempContext').value);
      await send(LT.MSG.VS_START, { force: false });
    })
  );
  $('vsRetranslate').addEventListener('click', () => {
    if (!confirm('重新翻译会丢弃这份译文并重新调用模型，消耗额度。继续？')) return;
    videoAction(async () => {
      await send(LT.MSG.SET_TEMP_CONTEXT, $('tempContext').value);
      await send(LT.MSG.VS_START, { force: true });
    });
  });
  $('vsCancel').addEventListener('click', () => videoAction(() => send(LT.MSG.VS_CANCEL)));
  $('vsToggle').addEventListener('click', () =>
    videoAction(() => send(LT.MSG.VS_SET_VISIBLE, !(status && status.video && status.video.visible)))
  );

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('toggleTheme').addEventListener('click', () => {
    const uiTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    const themeRevision = LT.UITheme.apply(uiTheme);
    settingsSave = settingsSave.then(async () => {
      settings = await LT.Settings.save({ uiTheme });
      LT.UITheme.settle(themeRevision, settings.uiTheme);
    }).catch(() => {
      LT.UITheme.settle(themeRevision, settings.uiTheme);
      banner('主题保存失败，请重新打开弹窗后重试。', '');
    });
  });

  for (const [id, key] of [
    ['sourceLang', 'sourceLang'],
    ['targetLang', 'targetLang'],
  ]) {
    $(id).addEventListener('change', (e) => {
      const value = e.target.value;
      settingsSave = settingsSave.then(async () => {
        settings = await LT.Settings.save({ [key]: value });
        await send(LT.MSG.SETTINGS_CHANGED);
        renderStatus();
      }).catch(() => banner('设置保存失败，请重新打开弹窗后重试。', ''));
    });
  }

  // 输入直接送到页面内存，避免立即关掉弹窗时防抖任务来不及执行。
  $('tempContext').addEventListener('input', (e) => {
    send(LT.MSG.SET_TEMP_CONTEXT, e.target.value);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settingsSave.then(async () => {
      settings = await LT.Settings.load();
      $('sourceLang').value = settings.sourceLang;
      $('targetLang').value = settings.targetLang;
      renderStatus();
      renderTextStatus();
    }).catch(() => {});
  });

  window.addEventListener('unload', () => clearInterval(timer));
  init();
})();
