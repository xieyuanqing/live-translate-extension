/**
 * 设置页统一提供商：文字模型、实时翻译和语音朗读共用列表与配置编辑。
 * 由 options.js 传入上下文挂载；保存走 options.js 的防抖保存，这里只改 settings 里的对象。
 * 输入框按对象原位更新；列表切换只更换编辑对象，不改变各功能选用。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  LT.OptionsUI = LT.OptionsUI || {};

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const option = (select, code, label) => {
    const o = el('option', null, label);
    o.value = code;
    select.appendChild(o);
  };
  const typeLabel = (apiType) => ({ gemini: 'Gemini', openai: 'OpenAI 兼容', anthropic: 'Claude' })[apiType] || apiType;
  const textFunctions = [
    ['liveContextProviderId', '直播背景整理'], ['subsProviderId', '整片字幕'],
    ['commentProviderId', '评论翻译'], ['selectionProviderId', '划词翻译'], ['chatProviderId', '聊天弹幕'],
  ];
  const functionsFor = (provider) => provider.kind === 'live' ? [['liveProviderId', '实时翻译']]
    : provider.kind === 'speech' ? [['ttsProviderId', '语音朗读']] : textFunctions;
  const kindLabel = (provider) => ({ text: '文字模型', live: '实时翻译', speech: '原文朗读' })[provider.kind] || '文字模型';
  // 「全部」视图按类型分组显示；组内保持用户排序。
  const KIND_ORDER = ['text', 'live', 'speech'];
  const MARKS = {
    gemini: '✦', openai: 'O', deepseek: 'DS', anthropic: '✳', bailian: '阿', 'bailian-intl': '阿', groq: 'g', moonshot: 'M',
    custom: '≡', 'gemini-live': '✦', 'qwen-live': '千', 'microsoft-tts': 'M', 'gemini-tts': '✦',
  };
  const RECOMMENDED_MODELS = {
    gemini: [
      ['gemini-2.5-pro', '强推理·字幕纠错'],
      ['gemini-2.5-flash', '均衡·通用推荐'],
      ['gemini-2.5-flash-lite', '极速·弹幕/划词'],
    ],
    deepseek: [
      ['deepseek-reasoner', '强推理·字幕纠错'],
      ['deepseek-chat', '均衡·通用推荐'],
    ],
    openai: [
      ['gpt-4.1', '高精度·字幕纠错'],
      ['gpt-4.1-mini', '均衡·通用推荐'],
      ['gpt-4.1-nano', '极速·轻量低延迟'],
    ],
    anthropic: [
      ['claude-sonnet-4-6', '高精度·字幕纠错'],
      ['claude-haiku-4-5', '快速·日常翻译'],
    ],
    bailian: [
      ['qwen-max', '高精度·字幕纠错'],
      ['qwen-plus', '均衡·通用推荐'],
      ['qwen-turbo', '极速·轻量低延迟'],
    ],
    'bailian-intl': [
      ['qwen-max', '高精度·字幕纠错'],
      ['qwen-plus', '均衡·通用推荐'],
      ['qwen-turbo', '极速·轻量低延迟'],
    ],
    groq: [
      ['llama-3.3-70b-versatile', '均衡·高速'],
      ['llama-3.1-8b-instant', '极速·轻量'],
    ],
    moonshot: [
      ['kimi-k2-0711-preview', '高精度·字幕'],
      ['moonshot-v1-8k', '均衡·短文本'],
    ],
  };
  const providerMark = (preset) => MARKS[preset.code] || preset.label.slice(0, 1);
  LT.OptionsUI.providerMark = providerMark;
  const markFor = (provider) => providerMark(LT.PROVIDER_PRESETS.find(preset => preset.code === provider.preset));
  const presetFor = (provider) => LT.PROVIDER_PRESETS.find(preset => preset.code === provider.preset);
  const identityLabel = (provider) => presetFor(provider)?.label || typeLabel(provider.apiType);
  const displayName = (p) => p.name || identityLabel(p);
  const rolesFor = (settings, provider) => functionsFor(provider)
    .filter(([field]) => settings[field] === provider.id).map(([, label]) => label);
  const subtitle = (provider) => {
    const name = displayName(provider);
    const identity = identityLabel(provider);
    const model = provider.kind === 'text' ? `${provider.models.length} 个模型` : provider.preset === 'microsoft-tts' ? '' : provider.model || '';
    return [name === identity ? '' : identity, model].filter(Boolean).join(' · ');
  };

  function describeError(err) {
    if (!err) return '未知错误';
    if (err.canRelay) return '该接口不允许浏览器直连；先授权域名，再把请求路径改为「只经扩展后台转发」';
    return err.message || String(err);
  }

  /** 可手填的模型选择器：展开显示全部，输入才筛选，不依赖浏览器 datalist。 */
  function modelPicker(input, id, onChange) {
    const root = el('div', 'model-picker');
    const row = el('div', 'model-input-row');
    const toggle = el('button', 'model-toggle', '▾');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', '展开模型列表');
    toggle.setAttribute('aria-controls', id);
    const list = el('div', 'model-options');
    list.id = id;
    list.hidden = true;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', '模型列表');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', id);
    input.setAttribute('aria-expanded', 'false');
    input.autocomplete = 'off';
    input.spellcheck = false;
    row.append(input, toggle);
    root.append(row, list);
    let ids = [], shown = [], active = -1;
    const close = () => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      toggle.setAttribute('aria-label', '展开模型列表');
    };
    const select = (value) => {
      input.value = value;
      onChange(value);
      close();
      input.focus();
    };
    function highlight() {
      Array.from(list.children).forEach((node, i) => {
        node.setAttribute('data-active', String(i === active));
      });
      if (active >= 0) {
        input.setAttribute('aria-activedescendant', `${id}-${active}`);
        list.children[active].scrollIntoView({ block: 'nearest' });
      }
    }
    function show(filter = '') {
      shown = ids.filter(value => value.toLowerCase().includes(filter.toLowerCase()));
      active = -1;
      list.replaceChildren();
      input.removeAttribute('aria-activedescendant');
      for (const [i, value] of shown.entries()) {
        const item = el('div', 'model-option', value);
        item.id = `${id}-${i}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(value === input.value));
        item.addEventListener('pointerdown', event => event.preventDefault());
        item.addEventListener('click', () => select(value));
        list.appendChild(item);
      }
      if (!shown.length) list.appendChild(el('p', 'model-empty', ids.length
        ? '没有匹配项，可直接使用手填的模型 ID。' : '尚无列表，可在提供商页获取模型列表或直接手填。'));
      list.hidden = false;
      const rect = root.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom;
      const above = below < 240 && rect.top > below;
      list.setAttribute('data-side', above ? 'above' : 'below');
      list.style.maxHeight = `${Math.min(240, (above ? rect.top : below) - 12)}px`;
      input.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', '收起模型列表');
    }
    toggle.addEventListener('click', () => {
      if (list.hidden) { show(); input.focus(); } else close();
    });
    input.addEventListener('input', () => { onChange(input.value); show(input.value); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape' || event.key === 'Tab') { close(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (list.hidden) show();
        if (shown.length) {
          active = event.key === 'ArrowDown' ? (active + 1) % shown.length : (active < 0 ? shown.length - 1 : (active + shown.length - 1) % shown.length);
          highlight();
        }
      } else if (event.key === 'Enter' && !list.hidden && active >= 0) {
        event.preventDefault();
        select(shown[active]);
      }
    });
    root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget)) close(); });
    return { root, close, show, setItems(values) { ids = [...new Set(values)].sort((a, b) => a.localeCompare(b)); close(); } };
  }
  LT.OptionsUI.modelPicker = modelPicker;

  /**
   * @param {{box: HTMLElement, list?: HTMLElement, picker?: HTMLSelectElement, settings: () => object, save: () => void, onTest?: Function}} ctx
   */
  function mountProviders(ctx) {
    const box = ctx.box;
    const kindButtons = [...document.querySelectorAll('#providerKindFilters [data-provider-kind]')];
    let editingId = '', activeKind = 'all', accessWidgets = [], draggedId = '';
    const visibleProviders = (settings) => activeKind === 'all'
      ? KIND_ORDER.flatMap(kind => settings.providers.filter(provider => provider.kind === kind))
      : settings.providers.filter(provider => provider.kind === activeKind);

    for (const button of kindButtons) button.addEventListener('click', () => {
      activeKind = button.dataset.providerKind;
      render();
    });

    function moveProvider(id, targetId) {
      const settings = ctx.settings();
      const from = settings.providers.findIndex(provider => provider.id === id);
      const to = settings.providers.findIndex(provider => provider.id === targetId);
      if (from < 0 || to < 0 || from === to) return;
      const [provider] = settings.providers.splice(from, 1);
      settings.providers.splice(to, 0, provider);
      ctx.save();
      render();
    }

    function enableControl(provider, labelClass, inputClass, ariaLabel, text) {
      const label = el('label', labelClass);
      const input = el('input', inputClass);
      input.type = 'checkbox';
      input.id = `provider-${encodeURIComponent(provider.id)}-${inputClass}`;
      input.setAttribute('role', 'switch');
      input.setAttribute('aria-label', ariaLabel);
      input.checked = provider.enabled !== false;
      const roles = rolesFor(ctx.settings(), provider);
      input.disabled = roles.length > 0 && input.checked;
      label.setAttribute('for', input.id);
      label.title = roles.length ? `正在被 ${roles.length} 个功能使用` : (input.checked ? '停用此提供商' : '启用此提供商');
      input.addEventListener('change', () => {
        if (!input.checked && rolesFor(ctx.settings(), provider).length) { input.checked = provider.enabled !== false; return; }
        provider.enabled = input.checked;
        ctx.save();
        render();
      });
      label.appendChild(input);
      if (text) label.appendChild(el('span', null, text));
      return label;
    }

    // 只在同类提供商之间排序，筛选与「全部」分组视图的顺序一致。
    const peersOf = (settings, provider) => settings.providers.filter(p => p.kind === provider.kind);

    function appendOrder(root, provider) {
      const orderActions = el('div', 'row provider-order-actions');
      const moveUp = el('button', 'ghost small', '上移');
      const moveDown = el('button', 'ghost small', '下移');
      moveUp.type = moveDown.type = 'button';
      const peers = peersOf(ctx.settings(), provider);
      const position = peers.indexOf(provider);
      moveUp.disabled = position === 0;
      moveDown.disabled = position === peers.length - 1;
      const shift = (offset) => {
        const s = ctx.settings();
        const shown = peersOf(s, provider);
        const target = shown[shown.indexOf(provider) + offset];
        if (!target) return;
        const from = s.providers.indexOf(provider), to = s.providers.indexOf(target);
        [s.providers[from], s.providers[to]] = [s.providers[to], s.providers[from]];
        ctx.save();
        render();
      };
      moveUp.addEventListener('click', () => shift(-1));
      moveDown.addEventListener('click', () => shift(1));
      orderActions.append(moveUp, moveDown);
      root.appendChild(orderActions);
    }

    const tip = (text, extraClass = '') => {
      const node = el('span', `info-tip${extraClass ? ' ' + extraClass : ''}`);
      node.setAttribute('tabindex', '0');
      node.setAttribute('data-tip', text);
      return node;
    };

    function serviceFields(root, provider, fieldLabel) {
      let access = null;
      const field = (key, title, { values, type = 'text', tag = 'input', hint, placeholder, readOnly = false } = {}) => {
        const group = el('div', 'field');
        const input = el(values ? 'select' : tag);
        if (values) for (const [value, label] of values) option(input, value, label);
        else { input.type = type; input.placeholder = placeholder || ''; }
        if (tag === 'textarea') input.rows = 2;
        input.value = provider[key] || '';
        input.readOnly = readOnly;
        const label = fieldLabel(input, key, title);
        if (key === 'apiKey') {
          const noteText = [hint, 'Key 明文保存在本机扩展存储，默认备份不包含 Key。'].filter(Boolean).join(' ');
          label.appendChild(tip(noteText, 'key-storage-note'));
        } else if (hint) {
          label.appendChild(tip(hint));
        }
        group.append(label, input);
        if (!readOnly) input.addEventListener(values ? 'change' : 'input', () => {
          provider[key] = input.value;
          ctx.save();
          renderList();
          if (key === 'baseUrl' || key === 'workspaceHost') access?.refresh();
        });
        if (type === 'password') {
          const visible = el('input');
          visible.type = 'checkbox';
          const showLabel = fieldLabel(visible, `show-${key}`, '显示 API Key');
          showLabel.className = 'check inline';
          showLabel.replaceChildren(visible, el('span', null, '显示 API Key'));
          visible.addEventListener('change', () => { input.type = visible.checked ? 'text' : 'password'; });
          group.appendChild(showLabel);
        }
        root.appendChild(group);
        return { group, input };
      };
      const addAccess = (group, config) => {
        const container = el('div');
        group.appendChild(container);
        access = LT.OptionsUI.mountHostAccess({ container, ...config });
        accessWidgets.push(access);
      };
      if (provider.preset === 'gemini-live') {
        field('apiKey', 'API Key', { tag: 'textarea', placeholder: 'AIza...', hint: '多个 Key 用逗号分隔，开始时随机选用。' });
        field('baseUrl', 'WebSocket 地址', { placeholder: LT.DEFAULT_BASE_URL });
        const model = field('model', '模型', { readOnly: true });
        model.input.value = LT.MODEL;
      } else if (provider.preset === 'qwen-live') {
        field('apiKey', 'API Key', { type: 'password', placeholder: 'sk-…' });
        const workspace = field('workspaceHost', '业务空间域名', { placeholder: 'ws-xxxx.cn-beijing.maas.aliyuncs.com', hint: '只填域名，支持北京和新加坡业务空间。' });
        addAccess(workspace.group, { getTarget: () => ({ origins: ['<all_urls>'], label: 'Chrome 所有网站权限（用于千问连接认证）', scopeLabel: '所有网站权限', button: '授权', missingText: '请先授权，再启动千问实时翻译。' }) });
        const model = field('model', '模型', { readOnly: true });
        model.input.value = LT.QWEN_MODEL;
      } else if (provider.preset === 'microsoft-tts') {
        field('jaVoice', '日语音色', { values: LT.Selection.VOICES.ja, hint: '微软接口无需 API Key，选择朗读音色即可。' });
        field('enVoice', '英语音色', { values: LT.Selection.VOICES.en });
      } else if (provider.preset === 'gemini-tts') {
        const reuse = el('input');
        reuse.type = 'checkbox';
        reuse.checked = provider.reuseKey;
        const reuseLabel = fieldLabel(reuse, 'reuseKey', '复用已有 Gemini Key');
        reuseLabel.className = 'check inline';
        reuseLabel.replaceChildren(reuse, el('span', null, '复用已有 Gemini Key'));
        root.appendChild(reuseLabel);
        const key = field('apiKey', '独立 API Key', { type: 'password', placeholder: 'AIza...' });
        key.input.disabled = provider.reuseKey;
        reuse.addEventListener('change', () => { provider.reuseKey = reuse.checked; key.input.disabled = reuse.checked; ctx.save(); });
        const base = field('baseUrl', 'Base URL', { placeholder: LT.TEXT_DEFAULT_BASE.gemini });
        addAccess(base.group, { getUrl: () => provider.baseUrl });
        field('model', '模型', { placeholder: LT.DEFAULTS.ttsGeminiModel });
        field('voice', 'Gemini 音色', { values: LT.Selection.VOICES.gemini.map(voice => [voice, voice]) });
      }
    }

    function renderList() {
      ctx.list?.replaceChildren();
      ctx.picker?.replaceChildren();
      const settings = ctx.settings();
      ctx.list?.setAttribute('data-grouped', String(activeKind === 'all'));
      for (const button of kindButtons) {
        const kind = button.dataset.providerKind;
        button.setAttribute('data-count', String(settings.providers.filter(p => kind === 'all' || p.kind === kind).length));
      }
      let previousKind = '';
      for (const provider of visibleProviders(settings)) {
        const meta = subtitle(provider);
        if (ctx.list) {
          const entry = el('div', 'provider-entry');
          entry.setAttribute('data-provider-id', provider.id);
          entry.setAttribute('data-kind', provider.kind);
          if (activeKind === 'all' && provider.kind !== previousKind) {
            const head = el('div', 'provider-group-head');
            const glyph = el('span', 'kind-glyph');
            glyph.setAttribute('aria-hidden', 'true');
            head.append(glyph, el('span', null, kindLabel(provider)),
              el('span', 'provider-group-count', String(peersOf(settings, provider).length)));
            entry.appendChild(head);
          }
          previousKind = provider.kind;
          const item = el('button', 'provider-list-item');
          item.type = 'button';
          item.draggable = true;
          item.setAttribute('data-provider-id', provider.id);
          item.setAttribute('aria-pressed', String(provider.id === editingId));
          item.setAttribute('data-enabled', String(provider.enabled !== false));
          const mark = el('span', 'provider-mark', markFor(provider));
          mark.setAttribute('aria-hidden', 'true');
          item.appendChild(mark);
          item.appendChild(el('strong', 'provider-name', displayName(provider)));
          item.appendChild(el('span', 'provider-kind', kindLabel(provider)));
          if (meta) item.appendChild(el('span', 'provider-meta muted small', meta));
          item.addEventListener('click', () => render(provider.id));
          item.addEventListener('dragstart', event => {
            draggedId = provider.id;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', provider.id);
          });
          item.addEventListener('dragend', () => { draggedId = ''; });
          const sameKind = () => ctx.settings().providers.find(p => p.id === draggedId)?.kind === provider.kind;
          entry.addEventListener('dragover', event => { if (draggedId && draggedId !== provider.id && sameKind()) event.preventDefault(); });
          entry.addEventListener('drop', event => {
            if (!draggedId || !sameKind()) return;
            event.preventDefault();
            moveProvider(draggedId, provider.id);
            draggedId = '';
          });
          const enableLabel = enableControl(provider, 'provider-enable', 'provider-enable-switch', `启用 ${displayName(provider)}`);
          entry.append(item, enableLabel);
          ctx.list.appendChild(entry);
        }
        if (ctx.picker) option(ctx.picker, provider.id,
          `${displayName(provider)} · ${kindLabel(provider)}${provider.enabled === false ? '（已停用）' : ''}`);
      }
      if (ctx.list && !ctx.list.children.length) ctx.list.appendChild(el('p', 'muted small provider-empty', '此分类还没有提供商，请点击「添加提供商」。'));
      if (ctx.picker) ctx.picker.value = editingId;
    }
    ctx.picker?.addEventListener('change', () => render(ctx.picker.value));

    function card(provider) {
      const settings = ctx.settings();
      const root = el('div', 'provider');
      root.setAttribute('data-kind', provider.kind);
      const fieldLabel = (input, part, text) => {
        input.id = `provider-${encodeURIComponent(provider.id)}-${part}`;
        const label = el('label', 'label', text);
        label.setAttribute('for', input.id);
        return label;
      };

      // ---- 三类提供商共用名称、描述、启停和排序 ----
      // 头部用类型色标出这是哪一类，并只读显示正在使用它的功能；分配仍在「功能分配」。
      const editorHeader = el('div', 'provider-editor-header');
      const headerMark = el('span', 'provider-editor-mark', markFor(provider));
      headerMark.setAttribute('aria-hidden', 'true');
      const headerCopy = el('div', 'provider-editor-copy');
      const titleLine = el('div', 'provider-editor-title');
      const customNameBadge = el('span', 'provider-custom-name');
      const syncCustomName = () => {
        const hasCustom = Boolean(provider.name && provider.name !== identityLabel(provider));
        customNameBadge.textContent = hasCustom ? provider.name : '';
        customNameBadge.hidden = !hasCustom;
      };
      syncCustomName();
      const kindBadge = el('span', 'provider-kind-badge');
      const kindGlyph = el('span', 'kind-glyph');
      kindGlyph.setAttribute('aria-hidden', 'true');
      kindBadge.append(kindGlyph, el('span', null, kindLabel(provider)));
      titleLine.append(el('strong', 'provider-identity', identityLabel(provider)), customNameBadge, kindBadge);
      const roles = rolesFor(settings, provider);
      const usageRow = el('div', 'provider-usage-row');
      usageRow.append(
        el('p', 'provider-usage', roles.length ? `正在用于：${roles.join('、')}` : '尚未分配给任何功能'),
        (() => {
          const link = el('a', 'provider-assign-link', '去功能分配 →');
          link.href = '#models';
          return link;
        })()
      );
      headerCopy.append(titleLine, usageRow);
      editorHeader.append(headerMark, headerCopy);
      const sectionTitle = (name, text) => {
        const node = el('div', 'provider-section-title', text);
        node.setAttribute('data-section', name);
        return node;
      };
      const nameField = el('div', 'field');
      const name = el('input');
      name.type = 'text';
      name.setAttribute('aria-label', '提供商名称');
      name.placeholder = identityLabel(provider);
      name.value = provider.name;
      name.addEventListener('input', () => {
        provider.name = name.value;
        syncCustomName();
        ctx.save();
        renderList();
      });
      nameField.append(fieldLabel(name, 'name', '自定义名称'), name);
      const copy = el('button', 'ghost small', '复制');
      copy.type = 'button';
      copy.addEventListener('click', () => {
        const s = ctx.settings();
        const baseName = `${displayName(provider)} 副本`;
        const names = new Set(s.providers.map(displayName));
        let name = baseName, number = 2;
        while (names.has(name)) name = `${baseName} ${number++}`;
        const dup = LT.Settings.newProvider({ ...provider, name });
        s.providers.splice(s.providers.indexOf(provider) + 1, 0, dup);
        editingId = dup.id;
        ctx.save();
        render();
      });
      const del = el('button', 'danger small', '删除');
      del.type = 'button';
      del.disabled = settings.providers.filter(p => p.kind === provider.kind).length <= 1;
      del.addEventListener('click', () => {
        const s = ctx.settings();
        if (s.providers.filter(p => p.kind === provider.kind).length <= 1) return;
        const replacement = s.providers.find(p => p !== provider && p.kind === provider.kind && p.enabled !== false);
        if (rolesFor(s, provider).length && !replacement) {
          alert(`请先启用另一个${provider.kind === 'text' ? '模型' : kindLabel(provider)}提供商，再删除正在使用的提供商。`);
          return;
        }
        if (!confirm(`删除提供商「${displayName(provider)}」？`)) return;
        s.providers = s.providers.filter((p) => p !== provider);
        for (const [field] of functionsFor(provider)) if (s[field] === provider.id) {
          s[field] = replacement.id;
          if (provider.kind === 'text') {
            const modelField = { subsProviderId: 'subsModel', selectionProviderId: 'selectionModel',
              commentProviderId: 'commentModel', liveContextProviderId: 'liveContextModel', chatProviderId: 'chatModel' }[field];
            s[modelField] = '';
          }
        }
        ctx.save();
        render();
      });
      const topActions = el('div', 'row provider-header-actions');
      topActions.append(
        copy,
        del,
        enableControl(provider, 'provider-editor-enable', 'provider-editor-enable-switch', '启用当前提供商', '启用')
      );
      editorHeader.appendChild(topActions);
      root.append(editorHeader);
      const descriptionField = el('div', 'field');
      const description = el('input');
      description.type = 'text';
      description.value = provider.description || '';
      description.placeholder = '可选，如个人账号、备用接口';
      description.addEventListener('input', () => { provider.description = description.value; ctx.save(); });
      descriptionField.append(fieldLabel(description, 'description', '备注描述'), description);
      const identityFields = el('div', 'two provider-identity-fields');
      identityFields.append(nameField, descriptionField);
      root.appendChild(identityFields);

      if (provider.kind !== 'text') {
        root.appendChild(sectionTitle('connection', provider.kind === 'speech' ? '连接与音色' : '连接'));
        serviceFields(root, provider, fieldLabel);
        appendOrder(root, provider);
        return root;
      }

      // 自定义 API 只有一个入口，在配置内选择服务商实际支持的协议。
      let apiTypeSelect = null;
      root.appendChild(sectionTitle('connection', '连接'));
      if (provider.preset === 'custom') {
        const typeField = el('div', 'field');
        apiTypeSelect = el('select');
        for (const type of LT.TEXT_API_TYPES) option(apiTypeSelect, type.code, type.label);
        apiTypeSelect.value = provider.apiType;
        typeField.append(fieldLabel(apiTypeSelect, 'type', 'API 协议'), apiTypeSelect);
        root.appendChild(typeField);
      }

      const modelField = el('div', 'field provider-model-directory');
      const modelRow = el('div', 'row');
      const model = el('input');
      model.type = 'text';
      model.placeholder = '手动输入模型 ID';
      const modelLabel = fieldLabel(model, 'add-model', '可用模型');
      modelLabel.appendChild(tip('在此添加该接口支持的模型 ID，之后可在「功能分配」中为各功能独立选用。'));
      modelField.appendChild(modelLabel);
      const listBtn = el('button', 'small nowrap', '获取模型列表');
      const addModelBtn = el('button', 'small nowrap', '添加模型');
      modelRow.append(model, addModelBtn, listBtn);
      const recommendedBox = el('div', 'provider-recommended');
      const modelList = el('div', 'provider-model-list');
      const listState = el('p', 'muted small model-list-state', '');
      listState.setAttribute('role', 'status');
      const appendModelId = (rawId) => {
        const id = rawId.trim().replace(/^models\//, '');
        if (!id) { listState.textContent = '请先填写模型 ID。'; return; }
        if (!provider.models.includes(id)) {
          provider.models.push(id);
          ctx.save(); renderList(); ctx.onCatalogChange?.();
        }
        model.value = '';
        listState.textContent = `已添加 ${id}。在「功能分配」中选择使用。`;
        renderModels();
      };
      function renderModels() {
        recommendedBox.replaceChildren();
        const recs = RECOMMENDED_MODELS[provider.preset] || [];
        if (recs.length) {
          recommendedBox.hidden = false;
          recommendedBox.appendChild(el('span', 'provider-recommended-label', '推荐：'));
          for (const [recId, tierNote] of recs) {
            const added = provider.models.includes(recId);
            const chip = el('button', 'provider-recommended-chip small', `${added ? '✓ ' : '＋ '}${recId}`);
            chip.type = 'button';
            chip.title = tierNote;
            chip.setAttribute('data-tip', tierNote);
            chip.disabled = added || provider.enabled === false;
            chip.addEventListener('click', () => appendModelId(recId));
            recommendedBox.appendChild(chip);
          }
        } else {
          recommendedBox.hidden = true;
        }
        modelList.replaceChildren();
        for (const id of provider.models) {
          const row = el('div', 'provider-model-row');
          const run = el('button', 'ghost small', '测试');
          run.type = 'button'; run.setAttribute('aria-label', `测试模型 ${id}`);
          run.addEventListener('click', () => runRequest('generate', id));
          const remove = el('button', 'ghost small', '移除');
          remove.type = 'button'; remove.setAttribute('aria-label', `移除模型 ${id}`);
          remove.addEventListener('click', () => {
            provider.models = provider.models.filter(model => model !== id);
            invalidate();
            ctx.save(); renderList(); ctx.onCatalogChange?.(); renderModels();
            listState.textContent = `已从目录移除 ${id}；已选用该模型的功能设置不会改变。`;
          });
          row.append(el('span', null, id), run, remove);
          modelList.appendChild(row);
        }
      }
      const addModel = () => appendModelId(model.value);
      addModelBtn.addEventListener('click', addModel);
      model.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addModel(); } });
      renderModels();
      modelField.append(recommendedBox, modelList, modelRow, listState);

      // ---- 地址 ----
      const baseField = el('div', 'field');
      const base = el('input');
      base.type = 'text';
      base.value = provider.baseUrl;
      const baseLabel = fieldLabel(base, 'base', 'Base URL');
      const baseTip = tip('');
      baseLabel.appendChild(baseTip);
      baseField.append(baseLabel, base);
      const accessBox = el('div');
      baseField.appendChild(accessBox);
      const access = LT.OptionsUI.mountHostAccess({ container: accessBox, getUrl: () => provider.baseUrl || LT.TEXT_DEFAULT_BASE[provider.apiType] });
      accessWidgets.push(access);

      // ---- Key ----
      const keyField = el('div', 'field');
      const key = el('input');
      const keyLabel = fieldLabel(key, 'key', 'API Key');
      const keyLabelText = el('span', null, 'API Key');
      const keyStorageNote = tip('Key 明文保存在本机扩展存储，默认导出备份不包含 Key。', 'key-storage-note');
      keyLabel.replaceChildren(keyLabelText, keyStorageNote);
      key.type = 'password';
      key.placeholder = 'sk-... 或 AIza...';
      key.value = provider.apiKey;
      key.addEventListener('input', () => {
        provider.apiKey = key.value;
        invalidate(true);
        ctx.save();
      });
      const showKey = el('input');
      showKey.type = 'checkbox';
      const showKeyLabel = fieldLabel(showKey, 'show-key', '显示 API Key');
      showKeyLabel.className = 'check inline';
      showKey.addEventListener('change', () => { key.type = showKey.checked ? 'text' : 'password'; });
      showKeyLabel.replaceChildren(showKey, el('span', null, '显示 API Key'));
      keyField.append(keyLabel, key, showKeyLabel);
      root.appendChild(keyField);
      root.appendChild(baseField);

      // ---- 地址查询不生成文字；每个模型单独测试实际生成。 ----
      const testRow = el('div', 'row provider-probe');
      const test = el('button', 'small', '查询接口');
      const testState = el('span', 'muted small test-state');
      testRow.append(test, tip('查询连通性不消耗生成额度；点击下方模型行的「测试」会消耗少量额度。'), testState);
      root.appendChild(testRow);
      root.appendChild(modelField);

      // ---- 自定义请求头与高级网络参数 ----
      const headerDetails = el('details', 'custom-headers');
      const headerSummary = el('summary');
      const headerRows = el('div', 'header-rows');
      const headerState = el('p', 'muted small');
      const addHeader = el('button', 'ghost small', '添加请求头');
      const showHeaders = el('button', 'ghost small', '显示值');
      let valuesVisible = false;
      const rows = Object.entries(provider.headers).map(([name, value]) => ({ name, value }));
      headerDetails.open = rows.length > 0;
      const saveHeaders = () => {
        provider.headers = LT.Settings.normalizeHeaders(Object.fromEntries(rows.map(row => [row.name, row.value])));
        headerSummary.textContent = `自定义请求头${Object.keys(provider.headers).length ? ` · ${Object.keys(provider.headers).length} 项` : ''}`;
        headerState.textContent = LT.Settings.headerError(provider.headers);
        invalidate(true);
        ctx.save();
      };
      function renderHeaders() {
        headerRows.replaceChildren();
        for (const row of rows) {
          const group = el('div', 'header-row');
          const name = el('input'), value = el('input'), remove = el('button', 'ghost small', '移除');
          name.type = 'text'; value.type = valuesVisible ? 'text' : 'password';
          name.placeholder = '名称，如 X-Api-Key'; value.placeholder = '请求头值';
          name.setAttribute('aria-label', '请求头名称'); value.setAttribute('aria-label', '请求头值');
          name.autocomplete = 'off'; value.autocomplete = 'off'; name.spellcheck = false; value.spellcheck = false;
          name.value = row.name; value.value = row.value;
          name.addEventListener('input', () => { row.name = name.value; saveHeaders(); });
          value.addEventListener('input', () => { row.value = value.value; saveHeaders(); });
          remove.addEventListener('click', () => { rows.splice(rows.indexOf(row), 1); saveHeaders(); renderHeaders(); });
          group.append(name, value, remove);
          headerRows.appendChild(group);
        }
      }
      headerSummary.textContent = `自定义请求头${rows.length ? ` · ${rows.length} 项` : ''}`;
      addHeader.addEventListener('click', () => { rows.push({ name: '', value: '' }); renderHeaders(); });
      showHeaders.addEventListener('click', () => {
        valuesVisible = !valuesVisible;
        showHeaders.textContent = valuesVisible ? '隐藏值' : '显示值';
        renderHeaders();
      });
      renderHeaders();
      const headerActions = el('div', 'row');
      headerActions.append(addHeader, showHeaders, tip('用于需要额外鉴权或参数的文字接口，同名项覆盖默认请求头。请求头明文保存在本机，默认备份不包含。'));
      headerDetails.append(headerSummary, headerRows, headerActions, headerState);
      root.appendChild(headerDetails);
      const adv = el('details', 'advanced');
      adv.appendChild(el('summary', null, '高级：并发与请求路径'));
      const advTwo = el('div', 'two');
      const concField = el('div', 'field');
      const conc = el('input');
      const concLabel = fieldLabel(conc, 'concurrency', '并发请求数');
      const concText = el('span', null, '');
      const concTip = tip('受接口每分钟额度限制，遇到限流会自动等待。');
      concLabel.replaceChildren(concText, concTip);
      conc.type = 'range';
      conc.min = '1';
      conc.max = '6';
      conc.step = '1';
      conc.value = String(provider.concurrency);
      const syncConc = () => {
        concText.textContent = `并发请求数：${provider.concurrency}`;
      };
      syncConc();
      conc.addEventListener('input', () => {
        provider.concurrency = parseInt(conc.value, 10);
        syncConc();
        ctx.save();
      });
      concField.append(concLabel, conc);
      const pathField = el('div', 'field');
      const pathSel = el('select');
      const pathLabel = fieldLabel(pathSel, 'path', '请求路径');
      pathLabel.appendChild(tip('官方接口页面直连即可；第三方地址跨域被拒时会改走扩展后台。'));
      pathField.appendChild(pathLabel);
      for (const t of LT.TEXT_REQUEST_PATHS) option(pathSel, t.code, t.label);
      pathSel.value = provider.requestPath;
      pathSel.addEventListener('change', () => {
        provider.requestPath = pathSel.value;
        invalidate();
        ctx.save();
      });
      pathField.append(pathSel);
      advTwo.append(concField, pathField);
      adv.append(advTwo);
      root.appendChild(adv);

      // ---- 按固定协议说明地址填写方式 ----
      const refreshHints = () => {
        base.placeholder = presetFor(provider)?.baseUrl || LT.TEXT_DEFAULT_BASE[provider.apiType];
        baseTip.setAttribute('data-tip', {
          openai: '填写接口基础地址（通常以 /v1 结尾），程序会自动追加 /chat/completions。',
          anthropic: '填到域名为止（不含 /v1），程序会自动追加 /v1/messages 和 /v1/models。',
          gemini: '自建反代填到域名为止，程序会自动追加 /v1beta/models/… 路径。',
        }[provider.apiType]);
        keyLabelText.textContent = provider.apiType === 'gemini' ? 'API Key（留空复用 Gemini 直播 Key）' : 'API Key';
        key.placeholder = { openai: 'sk-...', anthropic: 'sk-ant-...', gemini: 'AIza...' }[provider.apiType];
        name.placeholder = identityLabel(provider);
        access.refresh();
      };
      apiTypeSelect?.addEventListener('change', () => {
        provider.apiType = apiTypeSelect.value;
        invalidate(true);
        ctx.save();
        refreshHints();
        renderModels();
        renderList();
      });
      base.addEventListener('input', () => {
        provider.baseUrl = base.value;
        invalidate(true);
        ctx.save();
        access.refresh();
      });
      refreshHints();

      // ---- 测试与列出模型：按归一化后的配置发请求，不改动正在编辑的对象 ----
      let revision = 0, pending = null;
      accessWidgets.push({ dispose() { revision++; pending?.abort(); } });
      const busy = (on) => {
        test.disabled = on || provider.enabled === false;
        listBtn.disabled = on || provider.enabled === false;
        for (const row of modelList.children) row.children[1].disabled = on || provider.enabled === false;
      };
      function invalidate(clearModels = false) {
        revision++;
        pending?.abort();
        pending = null;
        busy(false);
        testState.textContent = '';
        if (clearModels) {
          listState.textContent = '连接配置已修改，请重新获取模型；也可直接手填。';
          listBtn.textContent = '获取模型列表';
        }
      }
      const fillList = (ids) => {
        provider.models = [...new Set([...provider.models, ...ids])];
        ctx.save(); renderList(); ctx.onCatalogChange?.(); renderModels();
        listBtn.textContent = '刷新模型列表';
        listState.textContent = `已获取 ${new Set(ids).size} 个模型，可在各功能中选用。`;
      };
      const viaNote = (via) => (via === 'relay' ? ' · 经后台转发' : '');
      async function runRequest(kind, selectedModel = '') {
        if (provider.enabled === false) {
          (kind === 'list' ? listState : testState).textContent = '请先启用此提供商。';
          return;
        }
        const ticket = ++revision;
        pending?.abort();
        const controller = pending = new AbortController();
        const current = () => ticket === revision;
        const state = kind === 'list' ? listState : testState;
        busy(true);
        state.textContent = kind === 'list' ? '正在获取模型…' : kind === 'generate' ? '生成测试中…' : '查询中…';
        let testedConfig, testedSettingsSignature;
        try {
          const snapshot = LT.Settings.normalize(ctx.settings());
          testedConfig = LT.TextModel.resolve(snapshot, provider.id, selectedModel);
          testedSettingsSignature = LT.OptionsUI.providerSignature(snapshot, provider.id);
          if (!await access.authorize()) {
            if (current()) state.textContent = '未获得域名权限，未发送请求。请在接口地址下方授权后重试。';
            return;
          }
          if (!current()) return;
          if (kind === 'list') {
            const ids = await LT.TextModel.listModels(testedConfig, controller.signal);
            if (!current()) return;
            fillList(ids);
            if (!ids.length) listState.textContent = '接口没有返回模型列表，可直接手填模型 ID，再用模型行的「测试」验证。';
          } else if (kind === 'probe') {
            const result = await LT.TextModel.probe(testedConfig, controller.signal);
            if (!current()) return;
            testState.textContent = (result.ok ? '✓ ' : '✗ ') + result.message + (result.ms ? ' · ' + result.ms + ' ms' : '') + viaNote(result.via);
            if (Array.isArray(result.models)) fillList(result.models);
          } else {
            const result = await LT.TextModel.generateTest(testedConfig, controller.signal);
            if (!current()) return;
            ctx.onTest?.({ providerId: provider.id, signature: JSON.stringify(testedConfig), settingsSignature: testedSettingsSignature, ok: true });
            testState.textContent = `✓ ${selectedModel} 测试通过 · ` + result.ms + ' ms' + viaNote(result.via) + ' · 回复「' + result.sample + '」';
          }
        } catch (err) {
          if (!current() || err.name === 'AbortError') return;
          if (kind === 'generate' && testedConfig) ctx.onTest?.({ providerId: provider.id, signature: JSON.stringify(testedConfig), settingsSignature: testedSettingsSignature, ok: false });
          state.textContent = (kind === 'list' ? '获取失败：' : kind === 'generate' ? '✗ 生成测试失败：' : '✗ ') + describeError(err);
          if (kind === 'list') state.textContent += '；仍可手填模型 ID。';
        } finally {
          if (current()) { pending = null; busy(false); }
        }
      }
      test.addEventListener('click', () => runRequest('probe'));
      listBtn.addEventListener('click', () => runRequest('list'));
      busy(false);

      // 列表可拖拽；按钮提供同等的键盘排序操作，所有用途仍绑定原 id。
      appendOrder(root, provider);

      return root;
    }

    function render(nextEditingId) {
      if (typeof nextEditingId === 'string') {
        editingId = nextEditingId;
        const target = ctx.settings().providers.find(provider => provider.id === editingId);
        if (target && activeKind !== 'all' && target.kind !== activeKind) activeKind = target.kind;
      }
      for (const access of accessWidgets) access.dispose();
      accessWidgets = [];
      box.replaceChildren();
      const settings = ctx.settings();
      const shown = visibleProviders(settings);
      if (!shown.some(provider => provider.id === editingId)) {
        editingId = (activeKind === 'all' && shown.find(provider => provider.id === settings.subsProviderId)?.id) || shown[0]?.id || '';
      }
      for (const button of kindButtons) button.setAttribute('aria-pressed', String(button.dataset.providerKind === activeKind));
      renderList();
      for (const p of settings.providers) if ((!ctx.list && !ctx.picker) || p.id === editingId) box.appendChild(card(p));
      if ((ctx.list || ctx.picker) && !shown.length) box.appendChild(el('p', 'muted provider-empty', '此分类还没有提供商，请从左侧添加。'));
    }

    return { render, edit: id => render(id) };
  }

  LT.OptionsUI.mountProviders = mountProviders;
})();
