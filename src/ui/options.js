/**
 * 设置页总控：分区导航、简单字段绑定、场景库、提示词预览、字幕缓存。
 * 文字模型卡片、字幕外观预览、导入导出分别在 options-providers.js / options-style.js / options-data.js。
 */
(() => {
  const LT = globalThis.LT;
  const $ = (id) => document.getElementById(id);

  let settings = LT.DEFAULTS;
  let saveTimer = null;

  const PAGES = ['general', 'live', 'video', 'models', 'style', 'data', 'about'];
  const PAGE_KEY = 'lt-options-page';
  const TEXT_FIELDS = ['apiKeys', 'baseUrl', 'manualContext', 'subsExtraInstruction'];
  const SELECT_OPTIONS = {
    sourceLang: LT.SOURCE_LANGS,
    targetLang: LT.TARGET_LANGS,
  };
  const CHECK_FIELDS = ['autoStartLive', 'pauseOnAd', 'useMetadata', 'echoTargetLanguage', 'autoShowCached'];
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
    renderPreview();
    renderProviderSelect();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      // 不要用返回值覆盖 settings：场景与接口配置卡片的事件闭包持有当前这些对象引用，
      // 换成存储里反序列化出来的新对象后，下一次输入就会写丢。
      await LT.Settings.save(settings);
      flashSaved();
      notifyTabs();
    }, 250);
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
    if (page === 'data') renderCache();
  }

  // ---------- 子模块 ----------

  const providers = LT.OptionsUI.mountProviders({
    box: $('providers'),
    settings: () => settings,
    save: () => queueSave({}),
    select: (id) => queueSave({ subsProviderId: id }),
  });
  const style = LT.OptionsUI.mountStyle({ $, settings: () => settings, save: queueSave });
  LT.OptionsUI.mountData({
    $,
    settings: () => settings,
    replace: replaceSettings,
    version: chrome.runtime.getManifest().version,
  });

  // ---------- 整片字幕：选用的接口配置 ----------

  function renderProviderSelect() {
    const el = $('subsProviderId');
    el.replaceChildren();
    for (const p of settings.providers) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name || (LT.TEXT_API_TYPES.find((t) => t.code === p.apiType) || {}).label || p.apiType;
      el.appendChild(opt);
    }
    el.value = settings.subsProviderId;
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
        badge.textContent = '默认';
        head.appendChild(badge);
      } else {
        const use = document.createElement('button');
        use.textContent = '设为默认';
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
      scene,
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

    for (const id of CHECK_FIELDS) {
      const el = $(id);
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
    $('subsProviderId').addEventListener('change', () => {
      queueSave({ subsProviderId: $('subsProviderId').value });
      providers.render();
    });

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
    renderScenes();
    renderPreview();
    showPage(location.hash.slice(1));
  })();
})();
