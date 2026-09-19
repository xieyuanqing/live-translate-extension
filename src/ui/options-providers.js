/**
 * 设置页「文字模型」分区：多套接口配置卡片，测试连接、列出模型、域名授权。
 * 由 options.js 传入上下文挂载；保存走 options.js 的防抖保存，这里只改 settings 里的对象。
 * 输入框按对象原位更新，不重排；只有增删、切换选用时才整体重画。
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
  const typeLabel = (apiType) => (LT.TEXT_API_TYPES.find((t) => t.code === apiType) || {}).label || apiType;
  const displayName = (p) => p.name || typeLabel(p.apiType);

  function originOf(provider) {
    try {
      return new URL(provider.baseUrl || LT.TEXT_DEFAULT_BASE[provider.apiType] || '').origin;
    } catch (_) {
      return '';
    }
  }

  /** 申请后台访问该域名；返回错误文字，空串表示成功。 */
  async function grantOrigin(origin) {
    const url = new URL(origin);
    // 带端口的本地网关（127.0.0.1:23000）先按原样申请；个别版本不接受带端口的模式，再退到不带端口
    const candidates = [`${origin}/*`];
    if (url.port) candidates.push(`${url.protocol}//${url.hostname}/*`);
    let lastError = '';
    for (const pattern of candidates) {
      try {
        if (await chrome.permissions.request({ origins: [pattern] })) return '';
      } catch (err) {
        lastError = err && err.message ? err.message : String(err);
      }
    }
    return lastError || '未授权';
  }

  function describeError(err) {
    if (!err) return '未知错误';
    if (err.canRelay) return '该接口不允许浏览器直连；先授权域名，再把请求路径改为「只经扩展后台转发」';
    return err.message || String(err);
  }

  /**
   * @param {{box: HTMLElement, settings: () => object, save: () => void, select: (id: string) => void}} ctx
   */
  function mountProviders(ctx) {
    const box = ctx.box;

    function card(provider) {
      const settings = ctx.settings();
      const active = provider.id === settings.subsProviderId;
      const root = el('div', active ? 'provider active' : 'provider');

      // ---- 标题行：名称、选用标记、复制、删除 ----
      const head = el('div', 'head');
      const name = el('input');
      name.type = 'text';
      name.placeholder = typeLabel(provider.apiType);
      name.value = provider.name;
      name.addEventListener('input', () => {
        provider.name = name.value;
        ctx.save();
      });
      head.appendChild(name);
      if (active) {
        head.appendChild(el('span', 'badge', '整片字幕使用'));
      } else {
        const use = el('button', 'small', '整片字幕改用这套');
        use.addEventListener('click', () => {
          ctx.select(provider.id);
          render();
        });
        head.appendChild(use);
      }
      const copy = el('button', 'ghost small', '复制');
      copy.addEventListener('click', () => {
        const s = ctx.settings();
        const dup = LT.Settings.newProvider({ ...provider, name: `${displayName(provider)} 副本` });
        s.providers.splice(s.providers.indexOf(provider) + 1, 0, dup);
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
        ctx.save();
        render();
      });
      head.append(copy, del);
      root.appendChild(head);

      // ---- 类型与模型名 ----
      const two = el('div', 'two');
      const typeField = el('div', 'field');
      typeField.appendChild(el('span', 'label', '接口类型'));
      const type = el('select');
      for (const t of LT.TEXT_API_TYPES) option(type, t.code, t.label);
      type.value = provider.apiType;
      typeField.appendChild(type);

      const modelField = el('div', 'field');
      modelField.appendChild(el('span', 'label', '模型名'));
      const modelRow = el('div', 'row');
      const model = el('input');
      model.type = 'text';
      model.placeholder = '填写你的接口实际支持的模型名';
      model.value = provider.model;
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
      });
      two.append(typeField, modelField);
      root.appendChild(two);

      // ---- 地址 ----
      const baseField = el('div', 'field');
      baseField.appendChild(el('span', 'label', '接口地址（留空用官方地址）'));
      const base = el('input');
      base.type = 'text';
      base.value = provider.baseUrl;
      const baseHint = el('p', 'muted small');
      baseField.append(base, baseHint);
      root.appendChild(baseField);

      // ---- Key ----
      const keyField = el('div', 'field');
      const keyLabel = el('span', 'label');
      const key = el('input');
      key.type = 'password';
      key.placeholder = 'sk-... 或 AIza...';
      key.value = provider.apiKey;
      key.addEventListener('input', () => {
        provider.apiKey = key.value;
        ctx.save();
      });
      keyField.append(keyLabel, key);
      root.appendChild(keyField);

      // ---- 两级测试 ----
      const testRow = el('div', 'row');
      const test = el('button', 'small', '测试连接');
      const gen = el('button', 'small', '生成测试');
      const testState = el('span', 'muted small test-state');
      testRow.append(test, gen, testState);
      root.appendChild(testRow);
      root.appendChild(
        el('p', 'muted small', '「测试连接」只查模型信息或模型列表，不花额度，通过不代表生成一定可用；「生成测试」按翻译时的完整路径发一条极短请求，会消耗少量额度。')
      );

      // ---- 高级：并发、请求路径、域名授权（默认折叠）----
      const adv = el('details', 'advanced');
      adv.appendChild(el('summary', null, '高级：并发、请求路径、域名授权'));
      const advTwo = el('div', 'two');
      const concField = el('div', 'field');
      const concLabel = el('span', 'label');
      const conc = el('input');
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
      pathField.appendChild(el('span', 'label', '请求路径'));
      const pathSel = el('select');
      for (const t of LT.TEXT_REQUEST_PATHS) option(pathSel, t.code, t.label);
      pathSel.value = provider.requestPath;
      pathSel.addEventListener('change', () => {
        provider.requestPath = pathSel.value;
        ctx.save();
      });
      pathField.append(pathSel, el('p', 'muted small', '官方接口页面直连即可；第三方地址跨域被拒时会改走扩展后台。'));
      advTwo.append(concField, pathField);
      const grantRow = el('div', 'row');
      const grant = el('button', 'small', '授权浏览器访问该域名');
      const grantState = el('span', 'muted small test-state');
      grantRow.append(grant, grantState);
      adv.append(advTwo, grantRow);
      root.appendChild(adv);

      // ---- 类型 / 地址联动 ----
      const refreshGrant = async () => {
        const origin = originOf(provider);
        if (!origin) {
          grantState.textContent = '地址无效';
          grant.disabled = true;
          return;
        }
        let granted = false;
        try {
          granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
        } catch (_) {
          granted = false;
        }
        grant.disabled = granted;
        grantState.textContent = granted
          ? `${origin} 已可由扩展后台访问`
          : `${origin} 尚未授权：页面直连失败时后台无法代发请求`;
      };
      const refreshHints = () => {
        base.placeholder = LT.TEXT_DEFAULT_BASE[provider.apiType];
        baseHint.textContent =
          provider.apiType === 'openai'
            ? '填到 /v1 为止，例如 https://api.openai.com/v1 或第三方兼容服务的地址。'
            : '自建反代填到域名为止，程序会自动拼 /v1beta/models/… 路径。';
        keyLabel.textContent = provider.apiType === 'gemini' ? 'API Key（留空则复用实时翻译的 Live Key）' : 'API Key';
        name.placeholder = typeLabel(provider.apiType);
        refreshGrant();
      };
      type.addEventListener('change', () => {
        provider.apiType = type.value;
        ctx.save();
        refreshHints();
      });
      base.addEventListener('input', () => {
        provider.baseUrl = base.value;
        ctx.save();
        refreshGrant();
      });
      grant.addEventListener('click', async () => {
        const origin = originOf(provider);
        if (!origin) return;
        const err = await grantOrigin(origin);
        if (err) grantState.textContent = `授权失败：${err}`;
        refreshGrant();
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
        try {
          const r = await LT.TextModel.generateTest(config());
          testState.textContent = `✓ 生成测试通过 · ${r.ms} ms${viaNote(r.via)} · 回复「${r.sample}」`;
        } catch (err) {
          testState.textContent = `✗ 生成测试失败：${describeError(err)}`;
        } finally {
          busy(false);
        }
      });
      listBtn.addEventListener('click', async () => {
        busy(true);
        listState.textContent = '读取中…';
        try {
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

    function render() {
      box.replaceChildren();
      for (const p of ctx.settings().providers) box.appendChild(card(p));
    }

    return { render };
  }

  LT.OptionsUI.mountProviders = mountProviders;
})();
