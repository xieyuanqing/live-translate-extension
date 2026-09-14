(() => {
  const LT = globalThis.LT;
  const $ = (id) => document.getElementById(id);

  let settings = LT.DEFAULTS;
  let saveTimer = null;

  const TEXT_FIELDS = ['apiKeys', 'baseUrl', 'manualContext', 'textBaseUrl', 'textApiKey', 'textModel'];
  const SELECT_OPTIONS = {
    sourceLang: LT.SOURCE_LANGS,
    targetLang: LT.TARGET_LANGS,
    textApiType: LT.TEXT_API_TYPES,
    textRequestPath: [
      { code: 'auto', label: '自动（先直连，失败改后台转发）' },
      { code: 'direct', label: '只页面直连' },
      { code: 'relay', label: '只经扩展后台转发' },
    ],
  };
  const CHECK_FIELDS = [
    'autoStartLive',
    'pauseOnAd',
    'useMetadata',
    'showSource',
    'echoTargetLanguage',
    'autoShowCached',
  ];
  const RANGE_FIELDS = [
    'metadataLimit',
    'captionLines',
    'captionScale',
    'captionBottom',
    'captionOpacity',
    'rotateSeconds',
    'stabIdleMs',
    'stabMaxChars',
    'textConcurrency',
  ];

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
    renderTextHints();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      // 不要用返回值覆盖 settings：场景卡片的事件闭包持有当前这些对象引用，
      // 换成存储里反序列化出来的新对象后，下一次输入就会写丢。
      await LT.Settings.save(settings);
      flashSaved();
      notifyTabs();
    }, 250);
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
    });
  }

  // ---------- 整片字幕：接口地址提示与域名授权 ----------

  function textOrigin() {
    const base = settings.textBaseUrl || LT.TEXT_DEFAULT_BASE[settings.textApiType] || '';
    try {
      return new URL(base).origin;
    } catch (_) {
      return '';
    }
  }

  function renderTextHints() {
    const type = settings.textApiType === 'openai' ? 'openai' : 'gemini';
    $('textBaseUrl').placeholder = LT.TEXT_DEFAULT_BASE[type];
    $('textBaseHint').textContent =
      type === 'openai'
        ? '填到 /v1 为止，例如 https://api.openai.com/v1 或第三方兼容服务的地址。'
        : '自建反代填到域名为止，程序会自动拼 /v1beta/models/… 路径。';
    refreshGrant();
  }

  async function refreshGrant() {
    const origin = textOrigin();
    const state = $('grantState');
    const button = $('grantHost');
    if (!origin) {
      state.textContent = '地址无效';
      button.disabled = true;
      return;
    }
    let granted = false;
    try {
      granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    } catch (_) {
      granted = false;
    }
    button.disabled = granted;
    state.textContent = granted
      ? `${origin} 已可由扩展后台访问`
      : `${origin} 尚未授权：页面直连失败时后台无法代发请求`;
  }

  async function grantHost() {
    const origin = textOrigin();
    if (!origin) return;
    const url = new URL(origin);
    // 带端口的本地网关（127.0.0.1:23000）先按原样申请；个别版本不接受带端口的模式，再退到不带端口
    const candidates = [`${origin}/*`];
    if (url.port) candidates.push(`${url.protocol}//${url.hostname}/*`);
    let lastError = '';
    for (const pattern of candidates) {
      try {
        if (await chrome.permissions.request({ origins: [pattern] })) break;
      } catch (err) {
        lastError = err && err.message ? err.message : String(err);
      }
    }
    if (lastError) $('grantState').textContent = `授权失败：${lastError}`;
    refreshGrant();
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
        const v = id === 'captionScale' ? parseFloat(el.value) : parseInt(el.value, 10);
        settings[id] = v;
        syncRangeLabel(id);
        queueSave({ [id]: v });
      });
    }

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

    $('grantHost').addEventListener('click', grantHost);
    $('refreshCache').addEventListener('click', renderCache);
    $('clearCache').addEventListener('click', async () => {
      if (!confirm('清空全部字幕缓存？已翻译的视频下次要重新调用模型。')) return;
      await LT.SubsCache.clearAll();
      renderCache();
    });
  }

  (async () => {
    settings = await LT.Settings.load();
    bind();
    renderScenes();
    renderPreview();
    renderTextHints();
    renderCache();
  })();
})();
