(() => {
  const LT = globalThis.LT;
  const $ = (id) => document.getElementById(id);

  let tabId = null;
  let settings = LT.DEFAULTS;
  let status = null;
  let timer = null;
  let busy = false;
  let settingsSave = Promise.resolve();

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
      return await chrome.tabs.sendMessage(tabId, { type, payload });
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
    $('liveDetails').classList.toggle('hidden', !liveFocus);
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

    $('stConn').textContent = status?.error || CONN_LABEL[status?.conn || ''] || status.conn;
    $('stConn').style.color = status?.error ? '#ffb4ab' : '';
    $('stDir').textContent = status?.direction || `${LT.sourceLabel(settings.sourceLang)} → ${LT.targetLabel(settings.targetLang)}`;
    $('stScene').textContent = status?.sceneLabel || LT.Settings.scene(settings).label;
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
    $('tempHint').textContent = running
      ? '修改后点下方「应用当前设置」即可生效。'
      : '开始翻译时生效；换视频或刷新后清空。';

    if (LT.Settings.keyList(settings).length === 0 && !settings.textApiKey) {
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
    renderStatus();
  }

  async function init() {
    $('version').textContent = chrome.runtime.getManifest().version;
    settings = await LT.Settings.load();
    fillSelect($('sourceLang'), LT.SOURCE_LANGS, settings.sourceLang);
    fillSelect($('targetLang'), LT.TARGET_LANGS, settings.targetLang);
    fillSelect($('scene'), settings.scenes, settings.sceneId);

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

  for (const [id, key] of [
    ['sourceLang', 'sourceLang'],
    ['targetLang', 'targetLang'],
    ['scene', 'sceneId'],
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

  window.addEventListener('unload', () => clearInterval(timer));
  init();
})();
