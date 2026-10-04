/**
 * 设置页文字接口：配置列表与单套编辑、查询、生成测试、域名授权。
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
  const typeLabel = (apiType) => ({ gemini: 'Gemini', openai: 'OpenAI 兼容' })[apiType] || apiType;
  const displayName = (p) => p.name || typeLabel(p.apiType);
  const rolesFor = (settings, provider) => [
    ['liveContextProviderId', '整理'], ['subsProviderId', '字幕'],
    ['selectionProviderId', '划词'], ['commentProviderId', '评论'],
  ].filter(([field]) => settings[field] === provider.id).map(([, label]) => label);
  const subtitle = (provider) => {
    const name = displayName(provider);
    const fullType = (LT.TEXT_API_TYPES.find(t => t.code === provider.apiType) || {}).label;
    const type = name === typeLabel(provider.apiType) || name === fullType ? '' : typeLabel(provider.apiType);
    return [type, provider.model || '未填写模型'].filter(Boolean).join(' · ');
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
        ? '没有匹配项，可直接使用手填的模型 ID。' : '尚无列表，点击「获取模型」或直接手填模型 ID。'));
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

  /**
   * @param {{box: HTMLElement, list?: HTMLElement, picker?: HTMLSelectElement, settings: () => object, save: () => void, onTest?: Function}} ctx
   */
  function mountProviders(ctx) {
    const box = ctx.box;
    let editingId = '', accessWidgets = [];

    function renderList() {
      ctx.list?.replaceChildren();
      ctx.picker?.replaceChildren();
      const settings = ctx.settings();
      for (const provider of settings.providers) {
        const meta = subtitle(provider);
        const roles = rolesFor(settings, provider);
        if (ctx.list) {
          const item = el('button', 'provider-list-item');
          item.type = 'button';
          item.setAttribute('data-provider-id', provider.id);
          item.setAttribute('aria-pressed', String(provider.id === editingId));
          item.appendChild(el('strong', null, displayName(provider)));
          if (meta) item.appendChild(el('span', 'muted small', meta));
          if (roles.length) item.appendChild(el('span', 'provider-list-roles muted small', `用于：${roles.join(' / ')}`));
          item.addEventListener('click', () => render(provider.id));
          ctx.list.appendChild(item);
        }
        if (ctx.picker) option(ctx.picker, provider.id,
          `${displayName(provider)}${meta ? ` · ${meta}` : ''}${roles.length ? `（${roles.join(' / ')}）` : ''}`);
      }
      if (ctx.picker) ctx.picker.value = editingId;
    }
    ctx.picker?.addEventListener('change', () => render(ctx.picker.value));

    function card(provider) {
      const settings = ctx.settings();
      const root = el('div', 'provider');
      const fieldLabel = (input, part, text) => {
        input.id = `provider-${encodeURIComponent(provider.id)}-${part}`;
        const label = el('label', 'label', text);
        label.setAttribute('for', input.id);
        return label;
      };

      // ---- 名称与复制、删除；功能用途只在列表中显示 ----
      const nameField = el('div', 'field');
      const head = el('div', 'head');
      const name = el('input');
      name.type = 'text';
      name.setAttribute('aria-label', '接口配置名称');
      name.placeholder = typeLabel(provider.apiType);
      name.value = provider.name;
      name.addEventListener('input', () => {
        provider.name = name.value;
        ctx.save();
        renderList();
      });
      nameField.appendChild(fieldLabel(name, 'name', '名称'));
      head.appendChild(name);
      const copy = el('button', 'ghost small', '复制');
      copy.addEventListener('click', () => {
        const s = ctx.settings();
        const dup = LT.Settings.newProvider({ ...provider, name: `${displayName(provider)} 副本` });
        s.providers.splice(s.providers.indexOf(provider) + 1, 0, dup);
        editingId = dup.id;
        ctx.save();
        render();
      });
      const del = el('button', 'danger small', '删除');
      del.disabled = settings.providers.length <= 1;
      del.addEventListener('click', () => {
        const s = ctx.settings();
        if (!confirm(`删除接口配置「${displayName(provider)}」？`)) return;
        s.providers = s.providers.filter((p) => p !== provider);
        if (s.subsProviderId === provider.id) s.subsProviderId = s.providers[0].id;
        if (s.liveContextProviderId === provider.id) s.liveContextProviderId = s.providers[0].id;
        if (s.selectionProviderId === provider.id) s.selectionProviderId = s.providers[0].id;
        if (s.commentProviderId === provider.id) s.commentProviderId = s.providers[0].id;
        ctx.save();
        render();
      });
      head.append(copy, del);
      nameField.appendChild(head);
      root.appendChild(nameField);

      // ---- 类型 ----
      const typeField = el('div', 'field');
      const type = el('select');
      for (const t of LT.TEXT_API_TYPES) option(type, t.code, typeLabel(t.code));
      type.value = provider.apiType;
      typeField.append(fieldLabel(type, 'type', '类型'), type);
      root.appendChild(typeField);

      const modelField = el('div', 'field');
      const modelRow = el('div', 'row');
      const model = el('input');
      model.type = 'text';
      model.placeholder = '填写你的接口实际支持的模型名';
      model.value = provider.model;
      modelField.appendChild(fieldLabel(model, 'model', '模型'));
      const picker = modelPicker(model, `models-${provider.id}`, value => {
        provider.model = value;
        invalidate();
        ctx.save();
        renderList();
      });
      const listBtn = el('button', 'small nowrap', '获取模型');
      modelRow.append(picker.root, listBtn);
      const listState = el('p', 'muted small model-list-state', '可直接填写模型 ID，也可获取列表后选择。');
      listState.setAttribute('role', 'status');
      modelField.append(modelRow, listState);

      // ---- 地址 ----
      const baseField = el('div', 'field');
      const base = el('input');
      base.type = 'text';
      base.value = provider.baseUrl;
      const baseHint = el('p', 'muted small');
      const baseDetails = el('details', 'field-help');
      baseDetails.appendChild(el('summary', null, '地址填写规则'));
      const baseExplanation = el('p', 'muted small');
      baseDetails.appendChild(baseExplanation);
      baseField.append(fieldLabel(base, 'base', '地址'), base, baseHint, baseDetails);
      const accessBox = el('div');
      baseField.appendChild(accessBox);
      root.appendChild(baseField);
      const access = LT.OptionsUI.mountHostAccess({ container: accessBox, getUrl: () => provider.baseUrl || LT.TEXT_DEFAULT_BASE[provider.apiType] });
      accessWidgets.push(access);

      // ---- Key ----
      const keyField = el('div', 'field');
      const key = el('input');
      const keyLabel = fieldLabel(key, 'key', 'API Key');
      key.type = 'password';
      key.placeholder = 'sk-... 或 AIza...';
      key.value = provider.apiKey;
      key.addEventListener('input', () => {
        provider.apiKey = key.value;
        invalidate(true);
        ctx.save();
      });
      keyField.append(keyLabel, key, el('p', 'muted small key-storage-note', 'Key 明文保存在本机扩展存储。'));
      root.appendChild(keyField);
      root.appendChild(modelField);

      // ---- 两级测试 ----
      const testRow = el('div', 'row');
      const test = el('button', 'small', '查询接口');
      const gen = el('button', 'small', '生成测试');
      const testState = el('span', 'muted small test-state');
      testRow.append(test, gen, testState);
      root.appendChild(testRow);
      root.appendChild(
        el('p', 'muted small', '查询不消耗生成额度；生成测试会消耗少量额度。')
      );

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
      headerActions.append(addHeader, showHeaders);
      headerDetails.append(headerSummary, el('p', 'muted small', '用于需要额外鉴权或参数的文字接口。同名项覆盖默认请求头，也可只用请求头鉴权。'),
        headerRows, headerActions, headerState, el('p', 'muted small', '请求头与 Key 一样明文保存在本机，默认备份不包含这些值。'));
      root.appendChild(headerDetails);
      const adv = el('details', 'advanced');
      adv.appendChild(el('summary', null, '高级：并发与请求路径'));
      const advTwo = el('div', 'two');
      const concField = el('div', 'field');
      const conc = el('input');
      const concLabel = fieldLabel(conc, 'concurrency', '并发请求数');
      conc.type = 'range';
      conc.min = '1';
      conc.max = '6';
      conc.step = '1';
      conc.value = String(provider.concurrency);
      const syncConc = () => {
        concLabel.textContent = `并发请求数：${provider.concurrency}`;
      };
      syncConc();
      conc.addEventListener('input', () => {
        provider.concurrency = parseInt(conc.value, 10);
        syncConc();
        ctx.save();
      });
      concField.append(concLabel, conc, el('p', 'muted small', '受接口每分钟额度限制，遇到限流会自动等待。'));
      const pathField = el('div', 'field');
      const pathSel = el('select');
      pathField.appendChild(fieldLabel(pathSel, 'path', '请求路径'));
      for (const t of LT.TEXT_REQUEST_PATHS) option(pathSel, t.code, t.label);
      pathSel.value = provider.requestPath;
      pathSel.addEventListener('change', () => {
        provider.requestPath = pathSel.value;
        invalidate();
        ctx.save();
      });
      pathField.append(pathSel, el('p', 'muted small', '官方接口页面直连即可；第三方地址跨域被拒时会改走扩展后台。'));
      advTwo.append(concField, pathField);
      adv.append(advTwo);
      root.appendChild(adv);

      // ---- 类型 / 地址联动 ----
      const refreshHints = () => {
        base.placeholder = LT.TEXT_DEFAULT_BASE[provider.apiType];
        baseHint.textContent = '留空使用官方地址。';
        baseExplanation.textContent = provider.apiType === 'openai'
          ? '填写接口基础地址，通常以 /v1 结尾；程序会追加 /chat/completions。第三方接口按其提供的基础地址填写。'
          : '自建反代填到域名为止，程序会追加 /v1beta/models/… 路径。';
        keyLabel.textContent = provider.apiType === 'gemini' ? 'API Key（留空复用 Gemini 直播 Key）' : 'API Key';
        name.placeholder = typeLabel(provider.apiType);
        access.refresh();
      };
      type.addEventListener('change', () => {
        provider.apiType = type.value;
        invalidate(true);
        ctx.save();
        refreshHints();
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
        test.disabled = on;
        gen.disabled = on;
        listBtn.disabled = on;
      };
      function invalidate(clearModels = false) {
        revision++;
        pending?.abort();
        pending = null;
        busy(false);
        testState.textContent = '';
        if (clearModels) {
          picker.setItems([]);
          listState.textContent = '连接配置已修改，请重新获取模型；也可直接手填。';
          listBtn.textContent = '获取模型';
        }
      }
      const fillList = (ids) => {
        picker.setItems(ids);
        listBtn.textContent = '刷新列表';
        listState.textContent = `已获取 ${new Set(ids).size} 个模型。点右侧箭头查看全部，输入文字可筛选。`;
      };
      const viaNote = (via) => (via === 'relay' ? ' · 经后台转发' : '');
      async function runRequest(kind) {
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
          testedConfig = LT.TextModel.resolve(snapshot, provider.id);
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
            if (!ids.length) listState.textContent = '接口没有返回模型列表，可直接手填模型 ID，再用「生成测试」验证。';
            picker.show();
            model.focus();
          } else if (kind === 'probe') {
            const result = await LT.TextModel.probe(testedConfig, controller.signal);
            if (!current()) return;
            testState.textContent = (result.ok ? '✓ ' : '✗ ') + result.message + (result.ms ? ' · ' + result.ms + ' ms' : '') + viaNote(result.via);
            if (Array.isArray(result.models)) fillList(result.models);
          } else {
            const result = await LT.TextModel.generateTest(testedConfig, controller.signal);
            if (!current()) return;
            ctx.onTest?.({ providerId: provider.id, signature: JSON.stringify(testedConfig), settingsSignature: testedSettingsSignature, ok: true });
            testState.textContent = '✓ 生成测试通过 · ' + result.ms + ' ms' + viaNote(result.via) + ' · 回复「' + result.sample + '」';
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
      gen.addEventListener('click', () => runRequest('generate'));
      listBtn.addEventListener('click', () => runRequest('list'));

      return root;
    }

    function render(nextEditingId) {
      if (typeof nextEditingId === 'string') editingId = nextEditingId;
      for (const access of accessWidgets) access.dispose();
      accessWidgets = [];
      box.replaceChildren();
      const settings = ctx.settings();
      if (!settings.providers.some(provider => provider.id === editingId)) editingId = settings.subsProviderId || settings.providers[0]?.id;
      renderList();
      for (const p of settings.providers) if ((!ctx.list && !ctx.picker) || p.id === editingId) box.appendChild(card(p));
    }

    return { render, edit: id => render(id) };
  }

  LT.OptionsUI.mountProviders = mountProviders;
})();
