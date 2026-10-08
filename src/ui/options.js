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

  const PAGES = ['general', 'live', 'video', 'text', 'speech', 'models', 'style', 'data', 'about'];
  const PAGE_INFO = {
    general: ['语言与背景', '设定翻译方向，补充常用的人名与背景。'],
    live: ['实时翻译', '设置直播翻译行为，以及开播前的背景与术语整理。'],
    video: ['整片字幕', '读取视频字幕，翻译后保存在本机，方便下次观看。'],
    text: ['聊天与评论', '聊天可选 Chrome 本地翻译或文字模型接口，评论按需翻译。'],
    speech: ['划词与朗读', '查看划词翻译和原文朗读的当前接口，调整朗读语速。'],
    models: ['API 与模型', '集中选择各功能使用的接口和模型，并管理接口连接。'],
    style: ['外观', '设置界面主题、字幕和评论／聊天译文的样式。'],
    data: ['数据与备份', '管理字幕缓存，导入或导出设置。'],
    about: ['高级与关于', '查看提示词、诊断日志和版本信息。'],
  };
  const PAGE_KEY = 'lt-options-page';
  const TEXT_FIELDS = ['manualContext', 'subsExtraInstruction'];
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
    { id: 'live', title: '实时音频翻译', description: '从播放器音频生成实时译文', icon: '实', kind: 'live', providerField: 'liveProviderId', stateId: 'liveSetupState', page: 'live' },
    { id: 'context', title: '直播背景整理', description: '开播前整理本场背景和术语', icon: '整', kind: 'text', providerField: 'liveContextProviderId', modelField: 'liveContextModel', stateId: 'contextSetupState', page: 'live' },
    { id: 'subs', title: '整片字幕', description: '翻译视频字幕并缓存到本机', icon: '字', kind: 'text', providerField: 'subsProviderId', modelField: 'subsModel', stateId: 'subsSetupState', page: 'video' },
    { id: 'chat', title: '聊天弹幕', description: '自动翻译新消息，也可使用 Chrome 本地翻译', icon: '聊', kind: 'text', providerField: 'chatProviderId', modelField: 'chatModel', stateId: 'chatSetupState', page: 'text' },
    { id: 'comment', title: '评论翻译', description: '按需翻译评论与回复', icon: '评', kind: 'text', providerField: 'commentProviderId', modelField: 'commentModel', stateId: 'commentSetupState', page: 'text' },
    { id: 'selection', title: '划词翻译', description: '翻译网页上选中的文字', icon: '划', kind: 'text', providerField: 'selectionProviderId', modelField: 'selectionModel', stateId: 'selectionSetupState', page: 'speech' },
    { id: 'speech', title: '原文朗读', description: '朗读选中的日语或英语原文', icon: '读', kind: 'speech', providerField: 'ttsProviderId', stateId: 'speechSetupState', page: 'speech' },
  ];
  const modelControls = [];
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
      const providersVisible = ['providers', 'text', 'live', 'speech'].includes(serviceTab);
      $('purposePage').hidden = providersVisible;
      $('providerPage').hidden = !providersVisible;
      $('purposeTab').setAttribute('aria-selected', String(!providersVisible));
      $('providerTab').setAttribute('aria-selected', String(providersVisible));
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
        local.value = 'local'; local.textContent = 'Chrome 本地翻译';
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
    });
    host.appendChild(picker.root);
    modelControls.push({ input, picker, field, providerField: purpose.providerField });
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
  }

  function choosePurposeProvider(providerField, id) {
    if (settings[providerField] === id) return;
    settings[providerField] = id;
    const purpose = PURPOSES.find(item => item.providerField === providerField);
    if (purpose?.modelField) settings[purpose.modelField] = '';
    queueSave({});
    refreshModelControls(providerField);
  }

  function mountPurposeAssignments() {
    const box = $('purposeAssignments');
    for (const purpose of PURPOSES) {
      const row = document.createElement('div');
      row.className = 'purpose-row';
      row.id = `purpose-${purpose.id}`;
      row.tabIndex = -1;
      const identity = document.createElement('div');
      identity.className = 'purpose-identity';
      const icon = document.createElement('span');
      icon.className = 'purpose-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = purpose.icon;
      const copy = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'purpose-title'; title.textContent = purpose.title;
      const description = document.createElement('div');
      description.className = 'purpose-description'; description.textContent = purpose.description;
      copy.append(title, description); identity.append(icon, copy);
      const controls = document.createElement('div');
      controls.className = 'purpose-controls';
      const serviceBox = document.createElement('div');
      const serviceLabel = document.createElement('label');
      serviceLabel.className = 'purpose-control-label';
      serviceLabel.htmlFor = `purposeProvider-${purpose.providerField}`;
      serviceLabel.textContent = '接口';
      const service = document.createElement('select');
      service.id = `purposeProvider-${purpose.providerField}`;
      service.addEventListener('change', () => choosePurposeProvider(purpose.providerField, service.value));
      serviceBox.append(serviceLabel, service); controls.appendChild(serviceBox);
      const modelControl = document.createElement('div');
      if (purpose.modelField) {
        const modelLabel = document.createElement('label');
        modelLabel.className = 'purpose-control-label';
        modelLabel.htmlFor = `purposeModel-${purpose.modelField}-input`;
        modelLabel.textContent = '模型';
        const modelBox = document.createElement('div');
        modelBox.id = `purposeModel-${purpose.modelField}`;
        mountModelControl(modelBox, purpose);
        modelControl.append(modelLabel, modelBox);
        if (purpose.id === 'chat') {
          const localNote = document.createElement('div');
          localNote.id = 'purposeLocal-chat'; localNote.className = 'purpose-description';
          localNote.textContent = 'Chrome 本地翻译无需模型';
          modelControl.appendChild(localNote);
        }
      } else {
        modelControl.className = 'purpose-description purpose-fixed-note';
        modelControl.textContent = purpose.kind === 'live' ? '模型由实时服务决定' : '音色在朗读提供商中设置';
      }
      controls.appendChild(modelControl);
      const state = document.createElement('span');
      state.id = `purposeState-${purpose.id}`; state.className = 'purpose-state';
      const link = document.createElement('a');
      link.className = 'purpose-settings-link'; link.href = '#models/providers';
      link.textContent = '配置该接口 →';
      link.addEventListener('click', () => {
        const id = settings[purpose.providerField];
        if (id && id !== 'local') providers.edit(id);
      });
      row.append(identity, controls, state, link);
      box.appendChild(row);
    }
    renderProviderSelect(); refreshModelControls(); renderPurposeSummaries();
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
    const live = states[0][2], text = states[2][2], selection = states[3][2], comment = states[4][2], speechState = states[5][2], chat = states[6][2];
    let required = null, message = '';
    if (currentPage === 'live' && !ready(live)) { required = live; message = '实时翻译接口尚未配置完成。'; }
    if (currentPage === 'video' && !ready(text)) { required = text; message = '整片字幕接口尚未配置完成。'; }
    if (currentPage === 'text' && snapshot.enableChatTranslation && !ready(chat)) { required = chat; message = '聊天翻译接口尚未配置完成。'; }
    if (currentPage === 'text' && snapshot.enableCommentTranslation && !ready(comment)) { required = comment; message = '评论接口尚未配置完成。'; }
    if (currentPage === 'speech' && (!ready(selection) || !ready(speechState))) {
      required = !ready(selection) ? selection : speechState;
      message = !ready(selection) ? '划词翻译接口尚未配置完成。' : '朗读接口尚未配置完成。';
    }
    const allText = allProfiles.filter((state, index) => snapshot.providers[index].kind === 'text');
    if (!required && currentPage === 'general' && !ready(live) && !allText.some(ready)) {
      required = text;
      message = '先配置一个翻译提供商，再到 YouTube 打开流译开始翻译。';
    }
    $('setupBanner').hidden = !required;
    $('setupMessage').textContent = message;
    const needsConnection = required?.authorized === false || required?.missing?.some(value => value !== '模型');
    const requiredEntry = states.find(entry => entry[2] === required);
    const requiredPurpose = PURPOSES.find(item => item.stateId === requiredEntry?.[0]);
    $('setupLink').href = needsConnection ? '#models/providers' : `#models/purpose/${requiredPurpose?.id || 'live'}`;
    $('setupLink').onclick = () => {
      const profileId = requiredEntry?.[3];
      if (needsConnection && profileId && profileId !== 'local') providers.edit(profileId);
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
        queueSave({});
        providers.render(provider.id);
        $(`provider-${encodeURIComponent(provider.id)}-${provider.kind === 'text' ? 'key' : 'apiKey'}`)?.focus();
      },
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
