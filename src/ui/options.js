/**
 * 设置页总控：分区导航、字段绑定、翻译偏好、提示词预览与配置引导。
 * 文字模型卡片、字幕外观预览、导入导出分别在 options-providers.js / options-style.js / options-data.js。
 */
(() => {
  const LT = globalThis.LT;
  const $ = (id) => document.getElementById(id);

  let settings = LT.DEFAULTS;
  let saveTimer = null;
  let saveQueue = Promise.resolve();
  let pendingThemeRevision = null;
  let currentPage = 'general', appearanceTab = 'caption', setupRevision = 0;
  let expandedLiveProvider = '', expandedSpeechProvider = '';
  const testedProviders = new Map();

  const PAGES = ['general', 'live', 'video', 'text', 'speech', 'models', 'style', 'data', 'about'];
  const PAGE_INFO = {
    general: ['语言与背景', '设定翻译方向，补充常用的人名与背景。'],
    live: ['实时翻译', '选择直播接口，设置开播前的背景与术语整理。'],
    video: ['整片字幕', '读取视频字幕，翻译后保存在本机，方便下次观看。'],
    text: ['聊天与评论', '聊天使用本地翻译，评论按需调用所选接口。'],
    speech: ['划词与朗读', '选择划词翻译和原文朗读接口，调整音色与语速。'],
    models: ['接口', ''],
    style: ['外观', '设置界面主题、字幕和评论／聊天译文的样式。'],
    data: ['数据与备份', '管理字幕缓存，导入或导出设置。'],
    about: ['高级与关于', '查看提示词、诊断日志和版本信息。'],
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
    modelContextProviderId: 'liveContextProviderId',
    modelSubsProviderId: 'subsProviderId',
    modelSelectionProviderId: 'selectionProviderId',
    modelCommentProviderId: 'commentProviderId',
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
    renderSetup();
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
    $('geminiPromptPreview').classList.toggle('hidden', settings.liveProvider === 'qwen');
    $('qwenModeHint').classList.toggle('hidden', settings.liveProvider !== 'qwen');
    $('liveServiceSummary').textContent = LT.LIVE_PROVIDERS.find(provider => provider.code === settings.liveProvider)?.label || '';
    // 首次显示和切换用途时展开当前接口；编辑备用接口不会切换功能选用。
    if (expandedLiveProvider !== settings.liveProvider) {
      expandedLiveProvider = settings.liveProvider;
      $('geminiLiveFields').open = settings.liveProvider === 'gemini';
      $('qwenLiveFields').open = settings.liveProvider === 'qwen';
    }
    if (expandedSpeechProvider !== settings.ttsProvider) {
      expandedSpeechProvider = settings.ttsProvider;
      $('geminiSpeechConfig').open = settings.ttsProvider === 'gemini';
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
    let [page, serviceTab] = name.split('/');
    if (!PAGES.includes(page)) {
      try {
        page = localStorage.getItem(PAGE_KEY) || 'models';
      } catch (_) {
        page = 'models';
      }
      if (!PAGES.includes(page)) page = 'models';
    }
    for (const el of document.querySelectorAll('.page')) el.classList.toggle('active', el.dataset.page === page);
    $('pageTitle').textContent = PAGE_INFO[page][0];
    $('pageDescription').textContent = PAGE_INFO[page][1];
    $('pageDescription').hidden = !PAGE_INFO[page][1];
    currentPage = page;
    $('mobilePageSelect').value = page;
    for (const a of document.querySelectorAll('.nav a')) {
      if (a.getAttribute('href') === `#${page}`) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    try {
      localStorage.setItem(PAGE_KEY, page);
    } catch (_) {
      /* 无痕模式等 */
    }
    if (page === 'style') showAppearance(appearanceTab); // 隐藏时容器宽度为 0，显示后重算字号
    if (page === 'data') renderCache();
    if (page === 'about') dataUI.refreshLogs();
    if (page === 'models') {
      if (!['text', 'live', 'speech'].includes(serviceTab)) serviceTab = 'text';
      for (const panel of document.querySelectorAll('[data-service-panel]')) panel.hidden = panel.dataset.servicePanel !== serviceTab;
      for (const tab of document.querySelectorAll('[data-service-tab]')) {
        if (tab.dataset.serviceTab === serviceTab) tab.setAttribute('aria-current', 'true');
        else tab.removeAttribute('aria-current');
      }
    }
    renderSetup();
  }

  function showAppearance(name) {
    appearanceTab = ['caption', 'comment', 'chat'].includes(name) ? name : 'caption';
    for (const button of $('appearanceTabs').querySelectorAll('[data-appearance-tab]')) {
      button.setAttribute('aria-pressed', String(button.dataset.appearanceTab === appearanceTab));
    }
    for (const panel of document.querySelectorAll('[data-appearance-panel]')) {
      panel.hidden = panel.dataset.appearancePanel !== (appearanceTab === 'caption' ? 'caption' : 'text');
    }
    if (appearanceTab === 'caption') style.refresh();
    else textStyle.selectScope(appearanceTab);
  }

  // ---------- 子模块 ----------

  const providers = LT.OptionsUI.mountProviders({
    box: $('providers'),
    list: $('providerList'),
    picker: $('providerPicker'),
    settings: () => settings,
    save: () => queueSave({}),
    onTest: ({ providerId, signature, settingsSignature, ok }) => {
      // 迟到的生成结果只能验证实际使用过的配置，不能把后来编辑的地址或模型标为通过。
      try {
        const snapshot = LT.Settings.normalize(settings);
        if (settingsSignature !== LT.OptionsUI.providerSignature(snapshot, providerId)) return;
        const actual = JSON.parse(signature), current = LT.TextModel.resolve(snapshot, providerId);
        const provider = snapshot.providers.find(p => p.id === providerId);
        if (!provider) return;
        const keys = provider.apiKey ? [provider.apiKey] : LT.Settings.keyList(snapshot);
        const actualKey = actual.key;
        delete actual.key; delete current.key;
        if (!keys.includes(actualKey) || JSON.stringify(actual) !== JSON.stringify(current)) return;
        if (ok) testedProviders.set(providerId, LT.OptionsUI.providerSignature(snapshot, providerId));
        else testedProviders.delete(providerId);
        renderSetup();
      } catch (_) { /* 已作废的测试结果 */ }
    },
  });
  const style = LT.OptionsUI.mountStyle({ $, settings: () => settings, save: queueSave });
  const textStyle = LT.OptionsUI.mountTextStyle({ $, settings: () => settings, save: queueSave });
  const speech = LT.OptionsUI.mountSpeech({ $, settings: () => settings, save: queueSave, flush: async () => {
    clearTimeout(saveTimer);
    await saveQueue;
    await LT.Settings.save({ ...settings });
  } });
  const dataUI = LT.OptionsUI.mountData({
    $,
    settings: () => settings,
    replace: replaceSettings,
    version: chrome.runtime.getManifest().version,
  });

  // ---------- 各功能分别选用接口配置 ----------

  function renderProviderSelect() {
    for (const [id, field] of Object.entries(PROVIDER_SELECTS)) {
      const el = $(id);
      el.replaceChildren();
      for (const p of settings.providers) {
        const opt = document.createElement('option');
        opt.value = p.id;
        const name = p.name || (p.apiType === 'gemini' ? 'Gemini' : 'OpenAI 兼容');
        opt.textContent = `${name} · ${p.model || '未填写模型名'}`;
        el.appendChild(opt);
      }
      el.value = settings[field];
      el.title = el.selectedOptions[0]?.textContent || '';
    }
  }

  async function renderSetup() {
    const revision = ++setupRevision;
    const snapshot = LT.Settings.normalize(settings);
    const describe = LT.OptionsUI.connectionState;
    const checks = new Map();
    async function permission(state) {
      if (!state.complete || !state.origins.length) return state;
      const key = JSON.stringify(state.origins);
      if (!checks.has(key)) checks.set(key, chrome.permissions.contains({ origins: state.origins }).catch(() => false));
      return { ...state, authorized: await checks.get(key) };
    }
    const purposes = [
      ['liveSetupState', '实时翻译', describe(snapshot, 'live')],
      ['contextSetupState', 'AI 整理', describe(snapshot, 'text', snapshot.liveContextProviderId), snapshot.liveContextProviderId],
      ['subsSetupState', '整片字幕', describe(snapshot, 'text', snapshot.subsProviderId), snapshot.subsProviderId],
      ['selectionSetupState', '划词翻译', describe(snapshot, 'text', snapshot.selectionProviderId), snapshot.selectionProviderId],
      ['commentSetupState', '评论翻译', describe(snapshot, 'text', snapshot.commentProviderId), snapshot.commentProviderId],
      ['speechSetupState', '原文朗读', describe(snapshot, 'speech')],
    ];
    const states = await Promise.all(purposes.map(async ([id, label, state, providerId]) => [id, label, await permission(state), providerId]));
    const allText = await Promise.all(snapshot.providers.map(p => permission(describe(snapshot, 'text', p.id))));
    if (revision !== setupRevision) return;
    const editingId = $('providerPicker').value;
    const editingIndex = snapshot.providers.findIndex(p => p.id === editingId);
    if (editingIndex >= 0) states.push(['providerSetupState', '当前接口', allText[editingIndex], editingId]);
    const ready = state => state.complete && state.authorized !== false;
    for (const [id, label, state, providerId] of states) {
      const node = $(id);
      node.replaceChildren();
      if (id === 'providerSetupState') {
        const tested = testedProviders.get(providerId) === LT.OptionsUI.providerSignature(snapshot, providerId);
        node.textContent = !state.complete ? `当前接口尚缺${state.missing.join('、')}。`
          : tested ? '本次生成测试通过。' : '配置已填写，生成测试可验证实际可用性。';
        node.dataset.state = !state.complete ? 'missing' : tested ? 'tested' : 'ready';
        continue;
      }
      const message = !state.complete ? `尚缺${state.missing.join('、')}` : state.authorized === false ? '尚需浏览器授权'
        : providerId && testedProviders.get(providerId) === LT.OptionsUI.providerSignature(snapshot, providerId) ? '本次生成测试通过'
        : id === 'speechSetupState' && snapshot.ttsProvider === 'microsoft' ? '微软接口无需 Key，可直接试听' : '已配置，实际可用性需测试';
      node.textContent = `${label}：${message}`;
      node.dataset.state = !ready(state) ? 'missing' : message === '本次生成测试通过' ? 'tested' : 'ready';
      if (!ready(state)) {
        const link = document.createElement('a'); link.href = state.route; link.textContent = '去配置';
        link.addEventListener('click', () => { if (providerId) providers.edit(providerId); });
        node.append(' · ', link);
      }
    }
    const live = states[0][2], text = states[2][2], selection = states[3][2], comment = states[4][2], speechState = states[5][2];
    let required = null, message = '';
    if (currentPage === 'live' && !ready(live)) { required = live; message = '实时翻译接口尚未配置完成。'; }
    if (currentPage === 'video' && !ready(text)) { required = text; message = '整片字幕接口尚未配置完成。'; }
    if (currentPage === 'text' && snapshot.enableCommentTranslation && !ready(comment)) { required = comment; message = '评论接口尚未配置完成；本地聊天翻译不受影响。'; }
    if (currentPage === 'speech' && (!ready(selection) || !ready(speechState))) {
      required = !ready(selection) ? selection : speechState;
      message = !ready(selection) ? '划词翻译接口尚未配置完成。' : '朗读接口尚未配置完成。';
    }
    if (!required && !ready(live) && !allText.some(ready) && ['general', 'models'].includes(currentPage)) {
      required = currentPage === 'models' && location.hash === '#models/live' ? live : text;
      message = '先配置一个翻译接口，再到 YouTube 打开流译开始翻译。';
    }
    $('setupBanner').hidden = !required;
    $('setupMessage').textContent = message;
    $('setupLink').href = required?.route || '#models/text';
    $('setupLink').onclick = () => {
      const purpose = currentPage === 'text' ? snapshot.commentProviderId : currentPage === 'speech' ? snapshot.selectionProviderId : snapshot.subsProviderId;
      if (required?.route === '#models/text') providers.edit(purpose);
    };
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
      name.placeholder = '翻译偏好名称';
      name.setAttribute('aria-label', '翻译偏好名称');
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
        if (!confirm(`确定删除翻译偏好「${scene.label}」？`)) return;
        settings.scenes = settings.scenes.filter((s) => s.id !== scene.id);
        if (settings.sceneId === scene.id) settings.sceneId = settings.scenes[0].id;
        queueSave({});
        renderScenes();
      });
      head.appendChild(del);

      const instr = document.createElement('textarea');
      instr.rows = 3;
      instr.value = scene.instruction;
      instr.placeholder = '翻译口吻、术语和专名处理…';
      instr.setAttribute('aria-label', '翻译偏好指令');
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
    LT.OptionsUI.mountHostAccess({ container: $('qwenAccess'), buttonId: 'grantQwenAccess', statusId: 'qwenPermissionState',
      getTarget: () => ({ origins: ['<all_urls>'], label: 'Chrome 所有网站权限（用于千问连接认证）', scopeLabel: '所有网站权限', button: '授权', missingText: '请先授权，再启动千问直播翻译。' }) });

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
      const provider = LT.Settings.newProvider({});
      settings.providers.push(provider);
      queueSave({});
      providers.render(provider.id);
    });

    $('addScene').addEventListener('click', () => {
      settings.scenes.push({
        id: `custom-${Date.now()}`,
        label: '新翻译偏好',
        instruction: '',
      });
      queueSave({});
      renderScenes();
    });

    $('resetScenes').addEventListener('click', () => {
      if (!confirm('恢复默认翻译偏好？你自己添加的偏好会被清掉。')) return;
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
    $('mobilePageSelect').addEventListener('change', event => { location.hash = event.target.value; });
    $('providerPicker').addEventListener('change', renderSetup);
    $('providerList').addEventListener('click', renderSetup);
    for (const button of $('appearanceTabs').querySelectorAll('[data-appearance-tab]')) {
      button.addEventListener('click', () => showAppearance(button.dataset.appearanceTab));
    }
    for (const event of [chrome.permissions.onAdded, chrome.permissions.onRemoved]) event?.addListener(renderSetup);
    window.addEventListener('focus', renderSetup);
  }

  (async () => {
    settings = await LT.Settings.load();
    bind();
    providers.render();
    style.bind();
    textStyle.bind();
    speech.bind();
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
