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
  const testedProviders = new Map();

  const PAGES = ['live', 'video', 'text', 'speech', 'models', 'general', 'style', 'data', 'about'];
  const PAGE_INFO = {
    live: ['直播实时翻译', '直接抓取直播间播放器音频，实时生成双语字幕。'],
    video: ['视频翻译', '面向点播视频与回放：先由云端转写或字幕轨获取原文，再整片翻译并本地缓存。'],
    text: ['聊天与评论', '其它辅助功能：直播弹幕自动翻译与评论区按需翻译。'],
    speech: ['划词与朗读', '其它辅助功能：全网右键划词翻译与日语／英语原文朗读。'],
    models: ['API 与模型', '按「直播实时翻译 / 视频翻译 / 其它功能」分配接口与模型，并管理提供商连接。'],
    general: ['语言与背景', '设定翻译方向，补充常用的人名与背景。'],
    style: ['外观', '设置界面主题、字幕和评论／聊天译文的样式。'],
    data: ['数据与备份', '管理字幕缓存，导入或导出设置。'],
    about: ['高级与关于', '查看诊断日志、开发工具和版本信息。'],
  };
  const PAGE_KEY = 'lt-options-page';
  const TEXT_FIELDS = ['manualContext', 'videoAsrBaseUrl', 'videoAsrToken'];
  const SELECT_OPTIONS = {
    uiTheme: [
      { code: 'system', label: '跟随系统（默认）' },
      { code: 'light', label: '浅色' },
      { code: 'dark', label: '深色' },
    ],
    debugLogLevel: LT.LOG_LEVELS,
    sourceLang: LT.SOURCE_LANGS,
    targetLang: LT.TARGET_LANGS,
    liveContextTimeoutSeconds: [
      { code: '30', label: '30 秒' },
      { code: '60', label: '60 秒（默认）' },
      { code: '120', label: '120 秒' },
    ],
  };
  const PURPOSES = [
    { id: 'live', section: 'live', title: '实时音频翻译', tier: '实时流', tierTone: 'live', description: '从直播间播放器音频直接生成实时双语字幕。', icon: '实', kind: 'live', providerField: 'liveProviderId', stateId: 'liveSetupState', page: 'live' },
    { id: 'context', section: 'live', title: '直播背景整理', tier: '高精度', tierTone: 'accuracy', description: '开播前从标题简介提炼背景和专名表，建议选理解力强的模型。', icon: '整', kind: 'text', providerField: 'liveContextProviderId', modelField: 'liveContextModel', stateId: 'contextSetupState', page: 'live' },
    { id: 'subs', section: 'video', title: '视频翻译模型', tier: '高精度', tierTone: 'accuracy', description: '步骤 2：把云端转写或字幕轨原文整片翻译为目标语言，建议选上下文理解强的模型。', icon: '视', kind: 'text', providerField: 'subsProviderId', modelField: 'subsModel', stateId: 'subsSetupState', page: 'video' },
    { id: 'comment', section: 'other', title: '评论翻译', tier: '均衡', tierTone: 'balanced', description: '按需翻译评论与回复，建议选速度与质量均衡的模型。', icon: '评', kind: 'text', providerField: 'commentProviderId', modelField: 'commentModel', stateId: 'commentSetupState', page: 'text' },
    { id: 'selection', section: 'other', title: '划词翻译', tier: '均衡', tierTone: 'balanced', description: '翻译网页上选中的文字，建议选响应快的均衡模型。', icon: '划', kind: 'text', providerField: 'selectionProviderId', modelField: 'selectionModel', stateId: 'selectionSetupState', page: 'speech' },
    { id: 'chat', section: 'other', title: '聊天弹幕', tier: '极速', tierTone: 'fast', description: '自动翻译滚动消息，推荐免费的 Chrome 本地翻译或极速轻量模型。', icon: '聊', kind: 'text', providerField: 'chatProviderId', modelField: 'chatModel', stateId: 'chatSetupState', page: 'text' },
    { id: 'speech', section: 'other', title: '原文朗读', tier: '语音', tierTone: 'speech', description: '在划词浮窗朗读选中的日语或英语原文。', icon: '读', kind: 'speech', providerField: 'ttsProviderId', stateId: 'speechSetupState', page: 'speech' },
  ];
  const modelControls = [];
  let pendingAddPurposeField = '';
  let videoAsrAccess = null;
  let videoAsrTestRev = 0;
  let videoAsrTestController = null;
  // 本页会话内的 VPS 实时状态：idle 未检测 / checking / ok / error；改地址或令牌即重置。
  let videoAsrLive = { state: 'idle', text: '未检测' };
  let videoAsrDefaultModel = '';
  let videoAsrAuthorized = true;
  const CHECK_FIELDS = ['autoStartLive', 'pauseOnAd', 'useMetadata', 'echoTargetLanguage', 'generateLiveContext',
    'autoShowCached', 'videoAsrSendContext', 'enableChatTranslation', 'enableCommentTranslation'];
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
    renderVideoAsr();
    renderVideoAsrModels();
    speech.render?.();
    renderPreview();
    renderProviderSelect();
    renderPurposeSummaries();
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
    const snapshot = LT.Settings.normalize(settings);
    $('geminiPromptPreview').classList.toggle('hidden', snapshot.liveProvider === 'qwen');
    $('qwenModeHint').classList.toggle('hidden', snapshot.liveProvider !== 'qwen');
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
    let [page, serviceTab, purposeId] = name.split('/');
    // 旧聊天接口页已并入聊天功能页，保留已有书签的入口。
    if (page === 'models' && serviceTab === 'chat') {
      page = 'text';
      history.replaceState(null, '', '#text');
    }
    if (!PAGES.includes(page)) {
      try {
        page = localStorage.getItem(PAGE_KEY) || 'live';
      } catch (_) {
        page = 'live';
      }
      if (!PAGES.includes(page)) page = 'live';
    }
    const previousPage = currentPage;
    for (const el of document.querySelectorAll('.page')) el.classList.toggle('active', el.dataset.page === page);
    $('pageTitle').textContent = PAGE_INFO[page][0];
    $('pageDescription').textContent = PAGE_INFO[page][1];
    $('pageDescription').hidden = !PAGE_INFO[page][1];
    currentPage = page;
    $('mobilePageSelect').value = page;
    document.querySelector('.pages').dataset.pageActive = page;
    // 离开视频页作废进行中的探活；进入时静默探活一次。
    if (page !== 'video' && videoAsrTestController) invalidateVideoAsrTest();
    if (page === 'video' && previousPage !== 'video') probeVideoAsr(true);
    for (const a of document.querySelectorAll('.nav a')) {
      if (a.getAttribute('href') !== `#${page}`) { a.removeAttribute('aria-current'); continue; }
      a.setAttribute('aria-current', 'page');
      $('pageIcon').replaceChildren(a.querySelector('svg').cloneNode(true));
      document.querySelector('.pages').dataset.hue = a.dataset.hue;
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
      const providersVisible = ['providers', 'text', 'live', 'speech'].includes(serviceTab);
      $('purposePage').hidden = providersVisible;
      $('providerPage').hidden = !providersVisible;
      $('purposeTab').setAttribute('aria-selected', String(!providersVisible));
      $('providerTab').setAttribute('aria-selected', String(providersVisible));
      if (providersVisible) providers.render();
      if (['text', 'live', 'speech'].includes(serviceTab)) {
        const provider = settings.providers.find(item => item.kind === serviceTab);
        if (provider) providers.edit(provider.id);
        history.replaceState(null, '', '#models/providers');
      }
      const purpose = serviceTab === 'purpose' ? PURPOSES.find(item => item.id === purposeId) : null;
      for (const row of document.querySelectorAll('.purpose-row')) row.classList.toggle('targeted', row.id === `purpose-${purpose?.id}`);
      if (purpose) requestAnimationFrame(() => {
        const row = $(`purpose-${purpose.id}`);
        row.scrollIntoView({ block: 'center' });
        row.focus({ preventScroll: true });
      });
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
    onCatalogChange: () => refreshModelControls(),
    onTest: ({ providerId, signature, settingsSignature, ok }) => {
      // 迟到的生成结果只能验证实际使用过的配置，不能把后来编辑的地址或模型标为通过。
      try {
        const snapshot = LT.Settings.normalize(settings);
        if (settingsSignature !== LT.OptionsUI.providerSignature(snapshot, providerId)) return;
        const actual = JSON.parse(signature), current = LT.TextModel.resolve(snapshot, providerId, actual.model);
        const provider = snapshot.providers.find(p => p.id === providerId);
        if (!provider) return;
        const keys = provider.apiKey ? [provider.apiKey] : provider.apiType === 'gemini' ? LT.Settings.keyList(snapshot) : [''];
        if (!keys.length) keys.push('');
        const actualKey = actual.key;
        delete actual.key; delete current.key;
        if (!keys.includes(actualKey) || JSON.stringify(actual) !== JSON.stringify(current)) return;
        const testId = `${providerId}/${current.model}`;
        if (ok) testedProviders.set(testId, LT.OptionsUI.providerSignature(snapshot, providerId));
        else testedProviders.delete(testId);
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

  // ---------- 集中分配各功能的接口和模型 ----------

  function providerName(provider) {
    return provider.name || LT.PROVIDER_PRESETS.find(item => item.code === provider.preset)?.label || '自定义 API';
  }

  function renderProviderSelect() {
    for (const purpose of PURPOSES) {
      const el = $(`purposeProvider-${purpose.providerField}`);
      el.replaceChildren();
      if (purpose.id === 'chat') {
        const local = document.createElement('option');
        local.value = 'local'; local.textContent = 'Chrome 本地翻译（免费·低延迟）';
        el.appendChild(local);
      }
      for (const provider of settings.providers) {
        if (provider.kind !== purpose.kind) continue;
        if (provider.enabled === false && provider.id !== settings[purpose.providerField]) continue;
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = `${providerName(provider)}${provider.enabled === false ? '（已停用）' : ''}`;
        option.disabled = provider.enabled === false;
        el.appendChild(option);
      }
      const addOption = document.createElement('option');
      addOption.value = '__add__';
      addOption.textContent = '＋ 添加新的提供商…';
      el.appendChild(addOption);
      el.value = settings[purpose.providerField];
      el.title = el.selectedOptions[0]?.textContent || '';
    }
  }

  function renderPurposeSummaries() {
    for (const purpose of PURPOSES) {
      const node = document.querySelector(`[data-purpose-summary="${purpose.id}"]`);
      const id = settings[purpose.providerField];
      if (purpose.id === 'chat' && id === 'local') {
        node.textContent = 'Chrome 本地翻译';
        continue;
      }
      const provider = settings.providers.find(item => item.id === id);
      const name = provider ? `${providerName(provider)}${provider.enabled === false ? '（已停用）' : ''}` : '未选择接口';
      node.textContent = purpose.modelField ? `${name} · ${settings[purpose.modelField] || '未选择模型'}` : name;
    }
  }

  function mountModelControl(host, purpose) {
    const field = purpose.modelField;
    const input = document.createElement('input');
    input.type = 'text'; input.id = `${host.id}-input`;
    input.setAttribute('aria-label', `${purpose.title}使用的模型`);
    input.placeholder = '选择或填写模型 ID';
    input.value = settings[field];
    const picker = LT.OptionsUI.modelPicker(input, `choices-${host.id}`, value => {
      settings[field] = value.trim();
      queueSave({});
      refreshApplyButtons();
    });
    host.appendChild(picker.root);
    modelControls.push({ input, picker, field, providerField: purpose.providerField });
  }

  function refreshApplyButtons() {
    for (const purpose of PURPOSES) {
      if (!purpose.modelField) continue;
      const btn = $(`purposeApply-${purpose.id}`);
      if (!btn) continue;
      const providerId = settings[purpose.providerField];
      const model = settings[purpose.modelField];
      btn.hidden = !providerId || providerId === 'local' || !model;
    }
  }

  function refreshModelControls(providerField) {
    for (const control of modelControls) {
      if (providerField && control.providerField !== providerField) continue;
      const provider = settings.providers.find(p => p.id === settings[control.providerField]);
      control.input.value = settings[control.field];
      control.input.disabled = control.providerField === 'chatProviderId' && settings.chatProviderId === 'local';
      control.picker.setItems(provider?.models || []);
    }
    $('purposeModel-chatModel').hidden = settings.chatProviderId === 'local';
    $('purposeLocal-chat').hidden = settings.chatProviderId !== 'local';
    $('chatLocalState').hidden = settings.chatProviderId !== 'local';
    $('chatCloudState').hidden = settings.chatProviderId === 'local';
    refreshApplyButtons();
  }

  function choosePurposeProvider(providerField, id) {
    if (id === '__add__') {
      $(`purposeProvider-${providerField}`).value = settings[providerField];
      pendingAddPurposeField = providerField;
      location.hash = '#models/providers';
      showPage('models/providers');
      $('addProvider').click();
      return;
    }
    if (settings[providerField] === id) return;
    settings[providerField] = id;
    const purpose = PURPOSES.find(item => item.providerField === providerField);
    if (purpose?.modelField) {
      const provider = settings.providers.find(p => p.id === id);
      if (id === 'local') settings[purpose.modelField] = '';
      else if (provider?.models?.length === 1) settings[purpose.modelField] = provider.models[0];
      else if (!provider?.models?.includes(settings[purpose.modelField])) settings[purpose.modelField] = '';
    }
    queueSave({});
    refreshModelControls(providerField);
  }

  function applyTextPurposeToOthers(sourcePurpose, button) {
    const providerId = settings[sourcePurpose.providerField];
    const model = settings[sourcePurpose.modelField];
    if (!providerId || providerId === 'local' || !model) return;
    for (const purpose of PURPOSES) {
      if (purpose.kind !== 'text' || purpose.id === sourcePurpose.id) continue;
      if (purpose.id === 'chat' && settings.chatProviderId === 'local') continue;
      settings[purpose.providerField] = providerId;
      settings[purpose.modelField] = model;
    }
    queueSave({});
    refreshModelControls();
    const prev = button.textContent;
    button.textContent = '✓ 已套用到其余文字项';
    setTimeout(() => { button.textContent = prev; }, 1400);
  }

  function mountPurposeAssignments() {
    const box = $('purposeAssignments');
    const SECTIONS = {
      live: { label: '一、直播实时翻译', hue: 'red' },
      video: { label: '二、视频翻译', hue: 'violet' },
      other: { label: '三、其它功能', hue: 'green' },
    };
    let lastSection = '';
    let currentCard = null;
    for (const purpose of PURPOSES) {
      if (purpose.section !== lastSection) {
        const info = SECTIONS[purpose.section];
        const sectionWrap = document.createElement('section');
        sectionWrap.className = 'purpose-section';
        const group = document.createElement('div');
        group.className = 'purpose-group';
        group.dataset.section = purpose.section;
        group.dataset.hue = info.hue;
        const dot = document.createElement('span');
        dot.className = 'purpose-group-dot';
        dot.setAttribute('aria-hidden', 'true');
        group.append(dot, info.label);
        currentCard = document.createElement('div');
        currentCard.className = 'purpose-section-card';
        sectionWrap.append(group, currentCard);
        box.appendChild(sectionWrap);
        lastSection = purpose.section;
        if (purpose.section === 'video') {
          const asrRow = document.createElement('div');
          asrRow.className = 'purpose-row purpose-row-asr';
          asrRow.id = 'purpose-video-asr';
          const asrIdentity = document.createElement('div');
          asrIdentity.className = 'purpose-identity';
          const asrIcon = document.createElement('span');
          asrIcon.className = 'purpose-icon';
          asrIcon.setAttribute('aria-hidden', 'true');
          asrIcon.textContent = '转';
          const asrCopy = document.createElement('div');
          const asrTitle = document.createElement('div');
          asrTitle.className = 'purpose-title';
          asrTitle.append('云端音频转写（VPS）');
          const asrTier = document.createElement('span');
          asrTier.className = 'purpose-tier';
          asrTier.textContent = '步骤 1';
          asrTitle.append(asrTier);
          asrCopy.append(asrTitle);
          asrIdentity.append(asrIcon, asrCopy);
          const asrControls = document.createElement('div');
          asrControls.className = 'purpose-asr-summary';
          const asrSummaryLine = document.createElement('div');
          asrSummaryLine.className = 'purpose-asr-line';
          const asrSummary = document.createElement('strong');
          asrSummary.id = 'purposeVideoAsrSummary';
          const asrLive = document.createElement('span');
          asrLive.id = 'purposeVideoAsrLive';
          asrLive.className = 'asr-live-state compact';
          asrSummaryLine.append(asrSummary, asrLive);
          const asrNote = document.createElement('span');
          asrNote.id = 'purposeVideoAsrMeta';
          asrNote.className = 'purpose-description';
          asrControls.append(asrSummaryLine, asrNote);
          const asrState = document.createElement('span');
          asrState.id = 'purposeState-video-asr';
          asrState.className = 'purpose-state';
          const asrFooter = document.createElement('div');
          asrFooter.className = 'purpose-footer-links';
          const asrLink = document.createElement('a');
          asrLink.className = 'purpose-settings-link';
          asrLink.href = '#video';
          asrLink.textContent = '配置原文来源与 VPS ›';
          asrFooter.appendChild(asrLink);
          asrRow.append(asrIdentity, asrControls, asrState, asrFooter);
          currentCard.appendChild(asrRow);
        }
      }
      const row = document.createElement('div');
      row.className = 'purpose-row';
      row.dataset.kind = purpose.kind;
      row.id = `purpose-${purpose.id}`;
      row.tabIndex = -1;
      const identity = document.createElement('div');
      identity.className = 'purpose-identity';
      const icon = document.createElement('span');
      icon.className = 'purpose-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = purpose.icon;
      const copy = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'purpose-title';
      title.append(purpose.title);
      if (purpose.tier) {
        const tier = document.createElement('span');
        tier.className = 'purpose-tier';
        tier.dataset.tier = purpose.tierTone;
        tier.textContent = purpose.tier;
        title.appendChild(tier);
      }
      if (purpose.description) {
        const tip = document.createElement('span');
        tip.className = 'info-tip';
        tip.tabIndex = 0;
        tip.setAttribute('data-tip', purpose.description);
        title.appendChild(tip);
      }
      copy.append(title); identity.append(icon, copy);
      const controls = document.createElement('div');
      controls.className = 'purpose-controls';
      const serviceBox = document.createElement('div');
      const serviceLabel = document.createElement('label');
      serviceLabel.className = 'purpose-control-label sr-only';
      serviceLabel.htmlFor = `purposeProvider-${purpose.providerField}`;
      serviceLabel.textContent = '接口';
      const service = document.createElement('select');
      service.id = `purposeProvider-${purpose.providerField}`;
      service.addEventListener('change', () => choosePurposeProvider(purpose.providerField, service.value));
      serviceBox.append(serviceLabel, service); controls.appendChild(serviceBox);
      const modelControl = document.createElement('div');
      if (purpose.modelField) {
        const modelLabel = document.createElement('label');
        modelLabel.className = 'purpose-control-label sr-only';
        modelLabel.htmlFor = `purposeModel-${purpose.modelField}-input`;
        modelLabel.textContent = '模型';
        const modelBox = document.createElement('div');
        modelBox.id = `purposeModel-${purpose.modelField}`;
        mountModelControl(modelBox, purpose);
        modelControl.append(modelLabel, modelBox);
        if (purpose.id === 'chat') {
          const localNote = document.createElement('div');
          localNote.id = 'purposeLocal-chat'; localNote.className = 'purpose-description purpose-fixed-note';
          localNote.textContent = '免模型 · 不耗 API 额度';
          modelControl.appendChild(localNote);
        }
      } else {
        modelControl.className = 'purpose-description purpose-fixed-note';
        modelControl.textContent = purpose.kind === 'live' ? '内置实时音频模型' : '音色在提供商中设置';
      }
      controls.appendChild(modelControl);
      const state = document.createElement('span');
      state.id = `purposeState-${purpose.id}`; state.className = 'purpose-state';
      const footerLinks = document.createElement('div');
      footerLinks.className = 'purpose-footer-links';
      const link = document.createElement('a');
      link.className = 'purpose-settings-link'; link.href = '#models/providers';
      link.textContent = '配置接口 ›';
      link.addEventListener('click', () => {
        const id = settings[purpose.providerField];
        if (id && id !== 'local') providers.edit(id);
      });
      footerLinks.appendChild(link);
      if (purpose.modelField) {
        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.id = `purposeApply-${purpose.id}`;
        applyBtn.className = 'purpose-apply-others ghost small';
        applyBtn.textContent = '套用到其余文字项';
        applyBtn.title = '将该接口与模型一键应用到其余云端文字功能（不改变已设为本地翻译的弹幕）';
        applyBtn.addEventListener('click', () => applyTextPurposeToOthers(purpose, applyBtn));
        footerLinks.appendChild(applyBtn);
      }
      const featureLink = document.createElement('a');
      featureLink.className = 'purpose-feature-link';
      featureLink.href = `#${purpose.page}`;
      featureLink.textContent = `${PAGE_INFO[purpose.page][0]} ›`;
      footerLinks.appendChild(featureLink);
      row.append(identity, controls, state, footerLinks);
      currentCard.appendChild(row);
    }
    renderProviderSelect(); refreshModelControls(); renderPurposeSummaries();
  }

  // ---------- 视频翻译：步骤 1 原文获取与 VPS 云端转写 ----------

  function invalidateVideoAsrTest() {
    videoAsrTestRev++;
    videoAsrTestController?.abort();
    videoAsrTestController = null;
    $('videoAsrTest').disabled = false;
    videoAsrDefaultModel = '';
    setVideoAsrLive({ state: 'idle', text: '未检测' });
  }

  function setVideoAsrLive(next) {
    videoAsrLive = next;
    renderVideoAsrLive();
    renderVideoAsrModels();
  }

  /** 设置页状态栏与「功能分配」卡片共用同一份实时状态。 */
  function renderVideoAsrLive() {
    const bar = $('videoAsrTestState');
    bar.textContent = videoAsrLive.text;
    bar.setAttribute('data-state', videoAsrLive.state);
    const chip = $('purposeVideoAsrLive');
    if (!chip) return;
    const mode = settings.videoTranscriptMode || 'auto';
    const hasUrl = Boolean(String(settings.videoAsrBaseUrl || '').trim());
    const [state, text] = mode === 'youtube' || !hasUrl ? ['idle', '']
      : !videoAsrAuthorized ? ['warn', '待授权']
      : videoAsrLive.state === 'ok' ? ['ok', `在线 · ${videoAsrLive.ms} ms`]
      : videoAsrLive.state === 'error' ? ['error', '断线']
      : videoAsrLive.state === 'checking' ? ['checking', '检测中…'] : ['idle', '未检测'];
    chip.textContent = text;
    chip.setAttribute('data-state', state);
    chip.title = videoAsrLive.state === 'error' ? videoAsrLive.text : '';
    chip.hidden = !text;
  }

  function videoAsrModelName(snapshot) {
    const models = Array.isArray(snapshot.videoAsrModels) ? snapshot.videoAsrModels : [];
    const id = snapshot.videoAsrModel;
    if (!id) {
      const def = models.find(m => m.id === videoAsrDefaultModel);
      return def ? `后端默认（${def.label}）` : videoAsrDefaultModel ? `后端默认（${videoAsrDefaultModel}）` : '后端默认';
    }
    return models.find(m => m.id === id)?.label || id;
  }

  function renderVideoAsrModels() {
    const select = $('videoAsrModel');
    const models = Array.isArray(settings.videoAsrModels) ? settings.videoAsrModels : [];
    const current = settings.videoAsrModel || '';
    const option = (value, text) => {
      const el = document.createElement('option');
      el.value = value;
      el.textContent = text;
      return el;
    };
    const def = models.find(m => m.id === videoAsrDefaultModel);
    const items = [option('', `使用后端默认（${def?.label || videoAsrDefaultModel || '自动'}）`)];
    for (const m of models) items.push(option(m.id, `${m.label}${m.provider ? ` · ${m.provider}` : ''}`));
    if (current && !models.some(m => m.id === current)) items.push(option(current, `${current}（自定义 / 未在后端列表）`));
    select.replaceChildren(...items);
    select.value = current;
    const chosen = current ? models.find(m => m.id === current) : def;
    $('videoAsrModelDesc').textContent = chosen?.description
      || (current && !chosen ? '该模型不在最近同步的后端列表中，仍会原样提交给 VPS。'
        : models.length ? '' : '点「连接并获取模型」从 VPS 同步可用模型。');
  }

  /** 优先用 LT.VpsAsr；未注入时直接请求 /health 与 /api/models。 */
  async function fetchVideoAsrInfo({ baseUrl, token, signal }) {
    if (LT.VpsAsr?.fetchServerInfo) return LT.VpsAsr.fetchServerInfo({ baseUrl, token, signal, timeoutMs: 12000 });
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const get = async (path) => {
      const res = await LT.Net.request({ method: 'GET', url: `${baseUrl}${path}`, headers, path: 'auto', timeoutMs: 12000, signal });
      if (res.status === 401 || res.status === 403) throw new Error(`VPS 访问令牌无效或未授权（HTTP ${res.status}）`);
      if (!res.ok) throw new Error(`VPS 请求失败（HTTP ${res.status}）`);
      try { return JSON.parse(res.text || '{}'); } catch (_) { return {}; }
    };
    const health = await get('/health');
    if (health.ok === false) throw new Error(health.error || 'VPS 健康检查返回异常');
    const data = await get('/api/models');
    const models = (Array.isArray(data.models) ? data.models : []).filter(m => m?.id)
      .map(m => ({ id: String(m.id), label: String(m.label || m.id), provider: String(m.provider || ''), description: String(m.description || '') }));
    return { ok: true, version: health.version || '', defaultModel: data.defaultModel || '', models };
  }

  /** silent：进入视频页时的静默探活，只在域名已授权时发请求，绝不弹权限窗。 */
  async function probeVideoAsr(silent) {
    if (settings.videoTranscriptMode === 'youtube') return;
    const baseUrl = String(settings.videoAsrBaseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      if (!silent) setVideoAsrLive({ state: 'error', text: '请先填写 VPS 服务地址。' });
      return;
    }
    let origins;
    try {
      const url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      origins = [LT.Settings.hostPattern(url.href)];
    } catch (_) {
      if (!silent) setVideoAsrLive({ state: 'error', text: '地址格式无效，请填写 https:// 或 http:// 开头的地址。' });
      return;
    }
    const rev = ++videoAsrTestRev;
    videoAsrTestController?.abort();
    const controller = new AbortController();
    videoAsrTestController = controller;
    const btn = $('videoAsrTest');
    btn.disabled = true;
    setVideoAsrLive({ state: 'checking', text: silent ? '正在检测 VPS 在线状态…' : '正在检查域名权限…' });
    const allowed = silent
      ? await chrome.permissions.contains({ origins }).catch(() => false)
      : videoAsrAccess ? await videoAsrAccess.authorize() : true;
    if (rev !== videoAsrTestRev) return;
    if (!allowed) {
      btn.disabled = false;
      videoAsrTestController = null;
      setVideoAsrLive(silent ? { state: 'idle', text: '未检测 · 域名尚未授权' } : { state: 'error', text: '未获得该域名权限，已取消连接。' });
      return;
    }
    setVideoAsrLive({ state: 'checking', text: '正在连接 VPS 并获取模型…' });
    const t0 = Date.now();
    try {
      const info = await fetchVideoAsrInfo({ baseUrl, token: String(settings.videoAsrToken || '').trim(), signal: controller.signal });
      if (rev !== videoAsrTestRev) return;
      const ms = Date.now() - t0;
      const models = info.models.map(({ id, label, provider, description }) => ({ id, label, provider, description }));
      videoAsrDefaultModel = info.defaultModel || '';
      setVideoAsrLive({ state: 'ok', ms, text: `已连接 · ${ms} ms · 后端支持 ${models.length} 个模型${info.via === 'relay' ? ' · 经后台转发' : ''}` });
      if (JSON.stringify(models) !== JSON.stringify(settings.videoAsrModels || [])) queueSave({ videoAsrModels: models });
    } catch (err) {
      if (rev !== videoAsrTestRev || err?.name === 'AbortError') return;
      setVideoAsrLive({ state: 'error', text: `连接失败：${err?.message || err}` });
    } finally {
      if (rev === videoAsrTestRev) {
        btn.disabled = false;
        videoAsrTestController = null;
      }
    }
  }

  function renderVideoAsr() {
    const mode = settings.videoTranscriptMode || 'auto';
    const isYoutubeOnly = mode === 'youtube';
    for (const btn of document.querySelectorAll('#videoTranscriptModes [data-transcript-mode]')) {
      btn.setAttribute('aria-checked', String(btn.dataset.transcriptMode === mode));
    }
    if ($('videoAsrConfig')) $('videoAsrConfig').hidden = isYoutubeOnly;
    if ($('videoAsrDisabledNote')) $('videoAsrDisabledNote').hidden = !isYoutubeOnly;
  }

  function mountVideoAsr() {
    const modeGrid = $('videoTranscriptModes');
    if (modeGrid) {
      modeGrid.replaceChildren();
      for (const item of LT.VIDEO_TRANSCRIPT_MODES) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'transcript-mode-card';
        card.setAttribute('role', 'radio');
        card.dataset.transcriptMode = item.code;
        card.setAttribute('aria-checked', String(settings.videoTranscriptMode === item.code));
        const head = document.createElement('div');
        head.className = 'transcript-mode-head';
        const name = document.createElement('strong');
        name.textContent = item.label;
        const badge = document.createElement('span');
        badge.className = 'transcript-mode-badge';
        badge.dataset.mode = item.code;
        badge.textContent = item.badge;
        head.append(name, badge);
        const desc = document.createElement('span');
        desc.className = 'transcript-mode-desc';
        desc.textContent = item.description;
        card.append(head, desc);
        card.addEventListener('click', () => {
          if (settings.videoTranscriptMode === item.code) return;
          invalidateVideoAsrTest();
          queueSave({ videoTranscriptMode: item.code });
        });
        modeGrid.appendChild(card);
      }
    }
    const accessBox = $('videoAsrHostAccess');
    if (accessBox) {
      videoAsrAccess = LT.OptionsUI.mountHostAccess({
        container: accessBox,
        getUrl: () => settings.videoAsrBaseUrl,
      });
    }
    $('videoAsrBaseUrl')?.addEventListener('input', () => {
      invalidateVideoAsrTest();
      videoAsrAccess?.refresh();
    });
    $('videoAsrToken')?.addEventListener('input', () => invalidateVideoAsrTest());
    $('showVideoAsrToken')?.addEventListener('change', (e) => {
      $('videoAsrToken').type = e.target.checked ? 'text' : 'password';
    });
    $('videoAsrTest').addEventListener('click', () => probeVideoAsr(false));
    $('videoAsrModel').addEventListener('change', (e) => queueSave({ videoAsrModel: e.target.value }));
    renderVideoAsr();
    renderVideoAsrModels();
    renderVideoAsrLive();
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
      ['liveSetupState', '实时翻译', describe(snapshot, 'live', snapshot.liveProviderId), snapshot.liveProviderId],
      ['contextSetupState', 'AI 整理', describe(snapshot, 'text', snapshot.liveContextProviderId, snapshot.liveContextModel), snapshot.liveContextProviderId, snapshot.liveContextModel],
      ['subsSetupState', '整片字幕', describe(snapshot, 'text', snapshot.subsProviderId, snapshot.subsModel), snapshot.subsProviderId, snapshot.subsModel],
      ['selectionSetupState', '划词翻译', describe(snapshot, 'text', snapshot.selectionProviderId, snapshot.selectionModel), snapshot.selectionProviderId, snapshot.selectionModel],
      ['commentSetupState', '评论翻译', describe(snapshot, 'text', snapshot.commentProviderId, snapshot.commentModel), snapshot.commentProviderId, snapshot.commentModel],
      ['speechSetupState', '原文朗读', describe(snapshot, 'speech', snapshot.ttsProviderId), snapshot.ttsProviderId],
      ['chatSetupState', '聊天弹幕', snapshot.chatProviderId === 'local' ? { complete: true, origins: [], missing: [] }
        : describe(snapshot, 'text', snapshot.chatProviderId, snapshot.chatModel), snapshot.chatProviderId, snapshot.chatModel],
    ];
    const states = await Promise.all(purposes.map(async ([id, label, state, providerId, model]) => [id, label, await permission(state), providerId, model]));
    const allProfiles = await Promise.all(snapshot.providers.map(p => permission(describe(snapshot, p.kind, p.id, null))));
    const asrState = await permission(LT.OptionsUI.videoAsrState(snapshot));
    if (revision !== setupRevision) return;
    const editingId = $('providerPicker').value;
    const editingIndex = snapshot.providers.findIndex(p => p.id === editingId);
    if (editingIndex >= 0) states.push(['providerSetupState', '当前提供商', allProfiles[editingIndex], editingId]);
    const ready = state => state.complete && state.authorized !== false;
    for (const [id, label, state, providerId, model] of states) {
      const node = $(id);
      node.replaceChildren();
      if (id === 'providerSetupState') {
        const profile = snapshot.providers.find(provider => provider.id === providerId);
        node.textContent = !state.complete ? `当前接口尚缺${state.missing.join('、')}。`
          : state.authorized === false ? '接口域名尚未授权，请在地址下方授权。'
          : profile.kind === 'text' ? '连接信息已填写；可获取模型列表或逐个测试模型。'
          : profile.preset === 'microsoft-tts' ? '微软接口无需 Key，可直接试听。' : '配置已填写，到功能页面验证实际可用性。';
        node.dataset.state = !ready(state) ? 'missing' : 'ready';
        continue;
      }
      const message = !state.complete ? `尚缺${state.missing.join('、')}` : state.authorized === false ? '尚需浏览器授权'
        : providerId && model && snapshot.providers.find(profile => profile.id === providerId)?.kind === 'text'
          && testedProviders.get(`${providerId}/${model}`) === LT.OptionsUI.providerSignature(snapshot, providerId) ? '本次生成测试通过'
        : id === 'chatSetupState' && providerId === 'local' ? 'Chrome 本地翻译，在弹窗准备语言包'
        : id === 'speechSetupState' && snapshot.ttsProvider === 'microsoft' ? '微软接口无需 Key，可直接试听' : '已配置，实际可用性需测试';
      node.textContent = `${label}：${message}`;
      node.dataset.state = !ready(state) ? 'missing' : message === '本次生成测试通过' ? 'tested' : 'ready';
      const purpose = PURPOSES.find(item => item.stateId === id);
      const purposeState = $(`purposeState-${purpose.id}`);
      purposeState.textContent = message;
      purposeState.dataset.state = node.dataset.state;
      $(`purpose-${purpose.id}`).querySelector('.purpose-settings-link').hidden = !providerId || providerId === 'local';
      if (!ready(state)) {
        const link = document.createElement('a');
        const connectionMissing = state.missing.some(value => value !== '模型');
        link.href = connectionMissing ? '#models/providers' : `#models/purpose/${purpose.id}`; link.textContent = '去配置';
        if (connectionMissing) link.addEventListener('click', () => { if (providerId) providers.edit(providerId); });
        node.append(' · ', link);
      }
    }

    // 同步视频翻译两阶段概览与 VPS 状态
    const modeInfo = LT.VIDEO_TRANSCRIPT_MODES.find(m => m.code === asrState.mode) || LT.VIDEO_TRANSCRIPT_MODES[0];
    let asrHost = '';
    try { if (snapshot.videoAsrBaseUrl) asrHost = new URL(snapshot.videoAsrBaseUrl).host; } catch (_) { asrHost = snapshot.videoAsrBaseUrl; }
    let asrBadgeText = '', asrTone = 'ready', asrSummaryText = '', asrStateMsg = '';
    if (asrState.mode === 'youtube') {
      asrBadgeText = '字幕轨';
      asrTone = 'neutral';
      asrSummaryText = '仅使用 YouTube 自带字幕轨（未启用 VPS 转写）';
    } else if (!asrState.complete) {
      asrBadgeText = '待配置';
      asrTone = 'missing';
      asrStateMsg = `VPS 云端转写：尚缺${asrState.missing.join('、')}`;
      asrSummaryText = `${modeInfo.label} · 尚未填写有效 VPS 地址`;
    } else if (asrState.authorized === false) {
      asrBadgeText = '待授权';
      asrTone = 'missing';
      asrStateMsg = 'VPS 云端转写：域名尚未授权，请在地址下方点「授权」';
      asrSummaryText = `${modeInfo.label} · ${asrHost}（未授权）`;
    } else if (!asrState.configured) {
      asrBadgeText = '未填 VPS';
      asrTone = 'warn';
      asrStateMsg = 'VPS 云端转写：未填写服务地址，当前将退回读取 YouTube 字幕轨';
      asrSummaryText = `${modeInfo.label} · 暂退回 YouTube 字幕轨`;
    } else {
      asrBadgeText = 'VPS 已配';
      asrTone = 'ok';
      asrSummaryText = `${modeInfo.label} · ${asrHost} · ${videoAsrModelName(snapshot)}`;
    }
    videoAsrAuthorized = asrState.authorized !== false;
    if ($('videoAsrSetupState')) {
      $('videoAsrSetupState').textContent = asrStateMsg;
      $('videoAsrSetupState').dataset.state = asrTone === 'missing' || asrTone === 'warn' ? 'missing' : 'ready';
    }
    if ($('videoStepSourceBadge')) {
      $('videoStepSourceBadge').textContent = asrBadgeText;
      $('videoStepSourceBadge').dataset.tone = asrTone;
      if ($('videoStepSourceText')) $('videoStepSourceText').textContent = asrSummaryText;
    }
    if ($('videoStepTranslateBadge')) {
      const subsState = states[2][2];
      const subsSummary = document.querySelector('[data-purpose-summary="subs"]')?.textContent || '未选择模型';
      const subsTested = $('subsSetupState').dataset.state === 'tested';
      $('videoStepTranslateBadge').textContent = !ready(subsState) ? '待配置' : subsTested ? '已测试' : '已配置';
      $('videoStepTranslateBadge').dataset.tone = !ready(subsState) ? 'missing' : 'ok';
      if ($('videoStepTranslateText')) $('videoStepTranslateText').textContent = subsSummary;
    }
    if ($('purposeVideoAsrSummary')) {
      $('purposeVideoAsrSummary').textContent = asrState.mode === 'youtube'
        ? '仅 YouTube 字幕轨'
        : asrHost ? `${modeInfo.label} · ${asrHost}` : `${modeInfo.label} · 未配置 VPS 地址`;
      $('purposeVideoAsrMeta').textContent = asrState.mode === 'youtube'
        ? '未启用 VPS 云端音频转写'
        : [`转写模型：${videoAsrModelName(snapshot)}`, snapshot.videoAsrToken ? '已填令牌' : '无令牌'].join(' · ');
      const asrPurposeState = $('purposeState-video-asr');
      const asrError = videoAsrLive.state === 'error' && asrState.configured ? videoAsrLive.text : '';
      asrPurposeState.textContent = asrStateMsg ? asrStateMsg.replace(/^VPS 云端转写：/, '') : asrError;
      asrPurposeState.dataset.state = asrStateMsg || asrError ? 'missing' : 'ready';
    }
    renderVideoAsrLive();

    const live = states[0][2], text = states[2][2], selection = states[3][2], comment = states[4][2], speechState = states[5][2], chat = states[6][2];
    let required = null, message = '', forceBannerRoute = '';
    if (currentPage === 'live' && !ready(live)) { required = live; message = '直播实时翻译接口尚未配置完成。'; }
    if (currentPage === 'video' && !ready(text)) { required = text; message = '视频翻译（步骤 2）的文字模型尚未配置完成。'; }
    else if (currentPage === 'video' && asrState.required && !ready(asrState)) {
      required = asrState;
      message = asrState.authorized === false ? 'VPS 转写服务域名尚未授权，请在下方地址栏点「授权」。' : '已选择强制云端转写，请填写有效的 VPS 服务地址。';
      forceBannerRoute = '#video';
    }
    if (currentPage === 'text' && snapshot.enableChatTranslation && !ready(chat)) { required = chat; message = '聊天翻译接口尚未配置完成。'; }
    if (currentPage === 'text' && snapshot.enableCommentTranslation && !ready(comment)) { required = comment; message = '评论接口尚未配置完成。'; }
    if (currentPage === 'speech' && (!ready(selection) || !ready(speechState))) {
      required = !ready(selection) ? selection : speechState;
      message = !ready(selection) ? '划词翻译接口尚未配置完成。' : '朗读接口尚未配置完成。';
    }
    const allText = allProfiles.filter((state, index) => snapshot.providers[index].kind === 'text');
    if (!required && (currentPage === 'general' || (currentPage === 'models' && !$('purposePage').hidden)) && !ready(live) && !allText.some(ready)) {
      required = text;
      message = '首次使用请先添加或配置一个 API 提供商（填写 Key 与模型），再为各功能选用。';
    }
    $('setupBanner').hidden = !required;
    $('setupMessage').textContent = message;
    const needsConnection = required?.authorized === false || required?.missing?.some(value => value !== '模型');
    const requiredEntry = states.find(entry => entry[2] === required);
    const requiredPurpose = PURPOSES.find(item => item.stateId === requiredEntry?.[0]);
    $('setupLink').href = forceBannerRoute || (needsConnection ? '#models/providers' : `#models/purpose/${requiredPurpose?.id || 'live'}`);
    $('setupLink').onclick = () => {
      if (forceBannerRoute) { $('videoAsrBaseUrl')?.focus(); return; }
      const profileId = requiredEntry?.[3];
      if (needsConnection && profileId && profileId !== 'local') providers.edit(profileId);
    };
  }

  // ---------- 整片字幕通用提示词 ----------

  function renderSubsPrompt() {
    const el = $('subsPrompt');
    if (!el) return;
    const active = LT.Settings.scene(settings);
    const extra = String(settings.subsExtraInstruction || '').trim();
    el.value = extra ? [active.instruction, extra].filter(Boolean).join('\n') : active.instruction;
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

    mountPurposeAssignments();
    mountVideoAsr();

    $('purposeAddProvider')?.addEventListener('click', () => {
      pendingAddPurposeField = '';
      location.hash = '#models/providers';
      showPage('models/providers');
      $('addProvider').click();
    });

    LT.OptionsUI.mountProviderPicker({
      button: $('addProvider'),
      dialog: $('providerDialog'),
      closeButton: $('closeProviderDialog'),
      catalog: $('providerCatalog'),
      onChoose: preset => {
        const existing = new Set(settings.providers.map(provider => provider.name
          || LT.PROVIDER_PRESETS.find(item => item.code === provider.preset)?.label || '自定义 API'));
        let name = preset.label, number = 2;
        while (existing.has(name)) name = `${preset.label} ${number++}`;
        const provider = LT.Settings.newProvider({ preset: preset.code, kind: preset.kind, name, apiType: preset.apiType, baseUrl: preset.baseUrl });
        settings.providers.push(provider);
        if (pendingAddPurposeField) {
          const targetPurpose = PURPOSES.find(item => item.providerField === pendingAddPurposeField);
          if (targetPurpose && targetPurpose.kind === provider.kind) {
            settings[pendingAddPurposeField] = provider.id;
            if (targetPurpose.modelField) settings[targetPurpose.modelField] = '';
          }
          pendingAddPurposeField = '';
        }
        queueSave({});
        refreshModelControls();
        providers.render(provider.id);
        $(`provider-${encodeURIComponent(provider.id)}-${provider.kind === 'text' ? 'key' : 'apiKey'}`)?.focus();
      },
    });

    $('subsPrompt')?.addEventListener('input', () => {
      const active = LT.Settings.scene(settings);
      active.instruction = $('subsPrompt').value;
      settings.subsExtraInstruction = '';
      queueSave({});
    });

    $('resetSubsPrompt')?.addEventListener('click', () => {
      if (!confirm('恢复默认通用翻译提示词？')) return;
      settings.scenes = JSON.parse(JSON.stringify(LT.DEFAULT_SCENES));
      settings.sceneId = settings.scenes[0].id;
      settings.subsExtraInstruction = '';
      renderSubsPrompt();
      queueSave({});
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
    $('providerKindFilters').addEventListener('click', renderSetup);
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
    renderSubsPrompt();
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
