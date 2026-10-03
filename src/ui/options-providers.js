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
      const listId = `models-${provider.id}`;
      model.setAttribute('list', listId);
      const datalist = el('datalist');
      datalist.id = listId;
      const listBtn = el('button', 'small nowrap', '列出可用模型');
      modelRow.append(model, listBtn);
      const listState = el('p', 'muted small');
      modelField.append(modelRow, datalist, listState);
      model.addEventListener('input', () => {
        provider.model = model.value;
        ctx.save();
        renderList();
      });

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

      // ---- 高级只保留性能与转发选项；必需的授权始终放在地址下方 ----
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
        ctx.save();
        refreshHints();
        renderList();
      });
      base.addEventListener('input', () => {
        provider.baseUrl = base.value;
        ctx.save();
        access.refresh();
      });
      refreshHints();

      // ---- 测试与列出模型：按归一化后的配置发请求，不改动正在编辑的对象 ----
      const config = () => LT.TextModel.resolve(LT.Settings.normalize(ctx.settings()), provider.id);
      const busy = (on) => {
        test.disabled = on;
        gen.disabled = on;
        listBtn.disabled = on;
      };
      const fillList = (ids) => {
        datalist.replaceChildren();
        for (const id of ids) {
          const o = el('option');
          o.value = id;
          datalist.appendChild(o);
        }
        listState.textContent = `共 ${ids.length} 个可用模型，点模型名输入框可选`;
      };
      const viaNote = (via) => (via === 'relay' ? ' · 经后台转发' : '');
      test.addEventListener('click', async () => {
        busy(true);
        testState.textContent = '测试中…';
        try {
          if (!await access.authorize()) { testState.textContent = '未获得域名权限，请在接口地址下方授权后重试。'; return; }
          const r = await LT.TextModel.probe(config());
          testState.textContent = `${r.ok ? '✓' : '✗'} ${r.message}${r.ms ? ` · ${r.ms} ms` : ''}${viaNote(r.via)}`;
          if (Array.isArray(r.models) && r.models.length) fillList(r.models);
        } catch (err) {
          testState.textContent = `✗ ${describeError(err)}`;
        } finally {
          busy(false);
        }
      });
      gen.addEventListener('click', async () => {
        busy(true);
        testState.textContent = '生成测试中…';
        let testedConfig, testedSettingsSignature;
        try {
          if (!await access.authorize()) { testState.textContent = '未获得域名权限，未发送生成请求。'; return; }
          const testedSettings = LT.Settings.normalize(ctx.settings());
          testedConfig = LT.TextModel.resolve(testedSettings, provider.id);
          // 多 Key 的一次请求只随机用一个；完整列表也冻结，不能验证后来改过的列表。
          testedSettingsSignature = LT.OptionsUI.providerSignature(testedSettings, provider.id);
          const r = await LT.TextModel.generateTest(testedConfig);
          ctx.onTest?.({ providerId: provider.id, signature: JSON.stringify(testedConfig), settingsSignature: testedSettingsSignature, ok: true });
          testState.textContent = `✓ 生成测试通过 · ${r.ms} ms${viaNote(r.via)} · 回复「${r.sample}」`;
        } catch (err) {
          if (testedConfig) ctx.onTest?.({ providerId: provider.id, signature: JSON.stringify(testedConfig), settingsSignature: testedSettingsSignature, ok: false });
          testState.textContent = `✗ 生成测试失败：${describeError(err)}`;
        } finally {
          busy(false);
        }
      });
      listBtn.addEventListener('click', async () => {
        busy(true);
        listState.textContent = '读取中…';
        try {
          if (!await access.authorize()) { listState.textContent = '未获得域名权限，请先授权。'; return; }
          const ids = await LT.TextModel.listModels(config());
          if (ids.length) fillList(ids);
          else listState.textContent = '接口没有返回模型列表';
        } catch (err) {
          listState.textContent = `列出失败：${describeError(err)}`;
        } finally {
          busy(false);
        }
      });

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
