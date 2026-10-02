/**
 * 设置页总控：分区导航、简单字段绑定、场景库、提示词预览、字幕缓存。
 * 文字模型卡片、字幕外观预览、导入导出分别在 options-providers.js / options-style.js / options-data.js。
 */
(() => {
  const LT = globalThis.LT;
  const $ = (id) => document.getElementById(id);

  let settings = LT.DEFAULTS;
  let saveTimer = null;
  let saveQueue = Promise.resolve();
  let pendingThemeRevision = null;

  const PAGES = ['general', 'live', 'video', 'text', 'models', 'style', 'data', 'about'];
  const PAGE_INFO = {
    general: ['语言与背景', '设定翻译方向，补充常用的人名与背景。'],
    live: ['实时翻译', '选择直播模型，设置开播前的背景与术语整理。'],
    video: ['整片字幕', '读取视频字幕，翻译后保存在本机，方便下次观看。'],
    text: ['弹幕与评论', '聊天自动翻译，评论按需翻译；两项分别开启。'],
    models: ['文字模型', '整理用轻量模型，字幕与评论用更强的模型，分别选择。'],
    style: ['字幕外观', '调整双语显示、字体与颜色，直接查看预览效果。'],
    data: ['数据管理', '查看诊断日志、管理字幕缓存，备份你的设置。'],
    about: ['关于流译', '版本信息、快捷键与诊断说明。'],
  };
  const PAGE_KEY = 'lt-options-page';
  const TEXT_FIELDS = ['apiKeys', 'baseUrl', 'qwenWorkspaceHost', 'qwenApiKey', 'manualContext', 'subsExtraInstruction'];
  const SELECT_OPTIONS = {
    uiTheme: [
      { code: 'system', label: '跟随系统（默认）' },
      { code: 'light', label: '浅色' },
      { code: 'dark', label: '深色' },
    ],
    liveProvider: LT.LIVE_PROVIDERS,
    debugLogLevel: LT.LOG_LEVELS,
    sourceLang: LT.SOURCE_LANGS,
    targetLang: LT.TARGET_LANGS,
    liveContextTimeoutSeconds: [
      { code: '30', label: '30 秒' },
      { code: '60', label: '60 秒（默认）' },
      { code: '120', label: '120 秒' },
    ],
  };
  const PROVIDER_SELECTS = {
    liveContextProviderId: 'liveContextProviderId', modelContextProviderId: 'liveContextProviderId',
    subsProviderId: 'subsProviderId', modelSubsProviderId: 'subsProviderId',
  };
  const CHECK_FIELDS = ['autoStartLive', 'pauseOnAd', 'useMetadata', 'echoTargetLanguage', 'generateLiveContext',
    'autoShowCached', 'enableChatTranslation', 'enableCommentTranslation'];
  const RANGE_FIELDS = ['metadataLimit', 'rotateSeconds', 'stabIdleMs', 'stabMaxChars'];

  // ---------- 保存 ----------

  function flashSaved() {
    const el = $('saved');
    el.textContent = '已保存';
    el.classList.add('flash');
    clearTimeout(flashSaved.t);
    flashSaved.t = setTimeout(() => {
      el.textContent = '改动即时保存';
      el.classList.remove('flash');
    }, 1200);
  }

  async function notifyTabs() {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
      for (const tab of tabs) {
        if (tab.id != null) {
          chrome.tabs
            .sendMessage(tab.id, { type: LT.MSG.SETTINGS_CHANGED })
            .catch(() => {});
        }
      }
    } catch (_) {
      /* 没有打开的 YouTube 页面 */
    }
  }

  function queueSave(patch) {
    Object.assign(settings, patch);
    if (Object.hasOwn(patch, 'uiTheme')) pendingThemeRevision = LT.UITheme.apply(settings.uiTheme);
    renderLiveProvider();
    renderPreview();
    renderProviderSelect();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const snapshot = { ...settings };
      const themeRevision = pendingThemeRevision;
      saveQueue = saveQueue.then(async () => {
        // 不要用返回值覆盖 settings：场景与接口配置卡片的事件闭包持有当前这些对象引用，
        // 换成存储里反序列化出来的新对象后，下一次输入就会写丢。
        try {
          const saved = await LT.Settings.save(snapshot);
          if (themeRevision !== null && pendingThemeRevision === themeRevision) {
            pendingThemeRevision = null;
            LT.UITheme.settle(themeRevision, saved.uiTheme);
          }
          flashSaved();
          notifyTabs();
        } catch (_) {
          if (themeRevision !== null && pendingThemeRevision === themeRevision) {
            const saved = await LT.Settings.load().catch(() => LT.DEFAULTS);
            if (pendingThemeRevision === themeRevision) {
              pendingThemeRevision = null;
              settings.uiTheme = saved.uiTheme;
              $('uiTheme').value = saved.uiTheme;
              LT.UITheme.settle(themeRevision, saved.uiTheme);
            }
          }
          $('saved').textContent = '保存失败，请重试';
        }
      });
    }, 250);
  }

  function renderLiveProvider() {
    $('geminiLiveFields').classList.toggle('hidden', settings.liveProvider === 'qwen');
    $('qwenLiveFields').classList.toggle('hidden', settings.liveProvider !== 'qwen');
    $('geminiPromptPreview').classList.toggle('hidden', settings.liveProvider === 'qwen');
  }

  async function refreshQwenPermission() {
    try {
      const allowed = await chrome.permissions.contains({ origins: ['<all_urls>'] });
      $('qwenPermissionState').textContent = allowed ? '已授权，可连接千问。' : '尚未授权，千问连接不能启动。';
      $('grantQwenAccess').disabled = allowed;
    } catch (_) {
      $('qwenPermissionState').textContent = '此预览环境无法检查 Chrome 权限。';
    }
  }

  /** 导入 / 恢复默认：整体写入后重载页面，所有卡片重新建立。 */
  async function replaceSettings(next) {
    clearTimeout(saveTimer);
    await LT.Settings.save(next);
    notifyTabs();
    location.reload();
  }

  // ---------- 分区导航 ----------

  function showPage(name) {
    let page = name;
    if (!PAGES.includes(page)) {
      try {
        page = localStorage.getItem(PAGE_KEY) || 'general';
      } catch (_) {
        page = 'general';
      }
      if (!PAGES.includes(page)) page = 'general';
    }
    for (const el of document.querySelectorAll('.page')) el.classList.toggle('active', el.dataset.page === page);
    $('pageTitle').textContent = PAGE_INFO[page][0];
    $('pageDescription').textContent = PAGE_INFO[page][1];
    for (const a of document.querySelectorAll('.nav a')) {
      if (a.getAttribute('href') === `#${page}`) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    try {
      localStorage.setItem(PAGE_KEY, page);
    } catch (_) {
      /* 无痕模式等 */
    }
    if (page === 'style') style.refresh(); // 隐藏时容器宽度为 0，显示后重算字号
    if (page === 'text') textStyle.refresh();
    if (page === 'data') { renderCache(); dataUI.refreshLogs(); }
  }

  // ---------- 子模块 ----------

  const providers = LT.OptionsUI.mountProviders({
    box: $('providers'),
    settings: () => settings,
    save: () => queueSave({}),
    select: (id, field = 'subsProviderId') => queueSave({ [field]: id }),
  });
  const style = LT.OptionsUI.mountStyle({ $, settings: () => settings, save: queueSave });
  const textStyle = LT.OptionsUI.mountTextStyle({ $, settings: () => settings, save: queueSave });
  const dataUI = LT.OptionsUI.mountData({
    $,
    settings: () => settings,
    replace: replaceSettings,
    version: chrome.runtime.getManifest().version,
  });

  // ---------- AI 整理与字幕翻译：分别选用接口配置 ----------

  function renderProviderSelect() {
    for (const [id, field] of Object.entries(PROVIDER_SELECTS)) {
      const el = $(id);
      el.replaceChildren();
      for (const p of settings.providers) {
        const opt = document.createElement('option');
        opt.value = p.id;
        const name = p.name || (LT.TEXT_API_TYPES.find((t) => t.code === p.apiType) || {}).label || p.apiType;
        opt.textContent = `${name} · ${p.model || '未填写模型名'}`;
        el.appendChild(opt);
      }
      el.value = settings[field];
    }
    const commentModel = LT.Settings.provider(settings);
    $('commentModelSummary').textContent = `${commentModel.name || '字幕翻译配置'} · ${commentModel.model || '未填写模型名'}`;
  }

  // ---------- 场景库 ----------

  function renderScenes() {
    const box = $('scenes');
    box.replaceChildren();

    settings.scenes.forEach((scene) => {
      const isDefault = scene.id === settings.sceneId;
      const card = document.createElement('div');
      card.className = isDefault ? 'scene default' : 'scene';

      const head = document.createElement('div');
      head.className = 'head';

      const name = document.createElement('input');
      name.type = 'text';
      name.value = scene.label;
      name.placeholder = '场景名称';
      // 按 ID 原位更新，不重排、不新建条目
      name.addEventListener('input', () => {
        scene.label = name.value;
        queueSave({});
      });

      head.appendChild(name);

      if (isDefault) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '整片字幕使用';
        head.appendChild(badge);
      } else {
        const use = document.createElement('button');
        use.textContent = '整片字幕改用这项';
        use.addEventListener('click', () => {
          queueSave({ sceneId: scene.id });
          renderScenes();
        });
        head.appendChild(use);
      }

      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '删除';
      del.disabled = settings.scenes.length <= 1;
      del.addEventListener('click', () => {
        if (!confirm(`确定删除场景「${scene.label}」？`)) return;
        settings.scenes = settings.scenes.filter((s) => s.id !== scene.id);
        if (settings.sceneId === scene.id) settings.sceneId = settings.scenes[0].id;
        queueSave({});
        renderScenes();
      });
      head.appendChild(del);

      const instr = document.createElement('textarea');
      instr.rows = 3;
      instr.value = scene.instruction;
      instr.placeholder = '这个场景要告诉模型什么（口吻、术语、专名处理…）';
      instr.addEventListener('input', () => {
        scene.instruction = instr.value;
        queueSave({});
      });

      card.append(head, instr);
      box.appendChild(card);
    });
  }

  // ---------- 提示词预览 ----------

  function renderPreview() {
    const scene = LT.Settings.scene(settings);
    const sampleMeta = {
      title: '（当前视频标题）',
      author: '（频道名）',
      isLive: true,
      category: '（分类）',
      keywords: ['（标签1）', '（标签2）'],
      description: '（视频简介，最多 ' + settings.metadataLimit + ' 字）',
    };
    const metadataText = settings.useMetadata
      ? LT.Prompt.formatMetadata(sampleMeta, settings.metadataLimit)
      : '';
    $('preview').textContent = LT.Prompt.build({
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      metadataText,
      manualContext: settings.manualContext,
    });
    $('previewSubs').textContent = LT.Prompt.buildSubs({
      scene,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      isAsr: true,
      metadataText: settings.useMetadata
        ? LT.Prompt.formatMetadata({ ...sampleMeta, isLive: false }, settings.metadataLimit)
        : '',
      manualContext: settings.manualContext,
      extraInstruction: settings.subsExtraInstruction,
    });
  }

  // ---------- 字幕缓存 ----------

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  async function renderCache() {
    const box = $('cacheList');
    box.replaceChildren();
    let index = {};
    let bytes = 0;
    try {
      index = await LT.SubsCache.listIndex();
      bytes = await LT.SubsCache.bytesInUse();
    } catch (_) {
      box.textContent = '读取缓存失败';
      return;
    }
    const entries = Object.entries(index).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    $('cacheTotal').textContent = entries.length
      ? `共 ${entries.length} 个视频 · 约 ${fmtBytes(bytes)}`
      : '还没有缓存';
    $('clearCache').disabled = entries.length === 0;
    for (const [videoId, item] of entries) {
      const row = document.createElement('div');
      row.className = 'cache-item';

      const info = document.createElement('div');
      info.className = 'cache-info';
      const title = document.createElement('div');
      title.className = 'cache-title';
      title.textContent = item.title || videoId;
      const meta = document.createElement('div');
      meta.className = 'muted small';
      meta.textContent = [
        item.trackLabel ? `${item.trackLabel} → ${LT.targetLabel(item.targetLang)}` : LT.targetLabel(item.targetLang),
        item.complete ? '完整' : '部分',
        item.unitCount ? `${item.unitCount} 条` : '',
        item.model || '',
        item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '',
      ]
        .filter(Boolean)
        .join(' · ');
      info.append(title, meta);

      const open = document.createElement('a');
      open.href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = '打开';
      open.className = 'small';

      const del = document.createElement('button');
      del.className = 'danger small';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        if (!confirm(`删除「${item.title || videoId}」的字幕缓存？`)) return;
        await LT.SubsCache.removeVideo(videoId);
        renderCache();
      });

      row.append(info, open, del);
      box.appendChild(row);
    }
  }

  // ---------- 绑定 ----------

  function syncRangeLabel(id) {
    const label = $(`${id}Val`);
    if (label) label.textContent = String(settings[id]);
  }

  function bind() {
    for (const id of TEXT_FIELDS) {
      const el = $(id);
      el.value = settings[id];
      el.addEventListener('input', () => queueSave({ [id]: el.value }));
    }

    for (const [id, list] of Object.entries(SELECT_OPTIONS)) {
      const el = $(id);
      el.replaceChildren();
      for (const item of list) {
        const opt = document.createElement('option');
        opt.value = item.code;
        opt.textContent = item.label;
        el.appendChild(opt);
      }
      el.value = settings[id];
      el.addEventListener('change', () => queueSave({ [id]: el.value }));
    }
    renderLiveProvider();
    $('grantQwenAccess').addEventListener('click', async () => {
      try {
        await chrome.permissions.request({ origins: ['<all_urls>'] });
      } catch (_) { /* 用户拒绝授权，下面按实际状态显示 */ }
      refreshQwenPermission();
    });
    refreshQwenPermission();

    for (const id of CHECK_FIELDS) {
      const el = $(id);
      el.setAttribute('role', 'switch');
      el.checked = !!settings[id];
      el.addEventListener('change', () => queueSave({ [id]: el.checked }));
    }

    for (const id of RANGE_FIELDS) {
      const el = $(id);
      el.value = settings[id];
      syncRangeLabel(id);
      el.addEventListener('input', () => {
        const v = parseInt(el.value, 10);
        settings[id] = v;
        syncRangeLabel(id);
        queueSave({ [id]: v });
      });
    }

    renderProviderSelect();
    for (const [id, field] of Object.entries(PROVIDER_SELECTS)) {
      $(id).addEventListener('change', () => {
        queueSave({ [field]: $(id).value });
        providers.render();
      });
    }

    $('addProvider').addEventListener('click', () => {
      settings.providers.push(LT.Settings.newProvider({}));
      queueSave({});
      providers.render();
    });

    $('addScene').addEventListener('click', () => {
      settings.scenes.push({
        id: `custom-${Date.now()}`,
        label: '新场景',
        instruction: '',
      });
      queueSave({});
      renderScenes();
    });

    $('resetScenes').addEventListener('click', () => {
      if (!confirm('恢复默认场景模板？你自己加的场景会被清掉。')) return;
      settings.scenes = JSON.parse(JSON.stringify(LT.DEFAULT_SCENES));
      settings.sceneId = settings.scenes[0].id;
      queueSave({});
      renderScenes();
    });

    $('refreshCache').addEventListener('click', renderCache);
    $('clearCache').addEventListener('click', async () => {
      if (!confirm('清空全部字幕缓存？已翻译的视频下次要重新调用模型。')) return;
      await LT.SubsCache.clearAll();
      renderCache();
    });

    $('version').textContent = chrome.runtime.getManifest().version;
    $('openShortcuts').addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });

    window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));
  }

  (async () => {
    settings = await LT.Settings.load();
    bind();
    providers.render();
    style.bind();
    textStyle.bind();
    renderScenes();
    renderPreview();
    showPage(location.hash.slice(1));
  })();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    if (pendingThemeRevision !== null) return;
    settings.uiTheme = LT.Settings.normalize(changes.settings.newValue).uiTheme;
    $('uiTheme').value = settings.uiTheme;
  });
})();
