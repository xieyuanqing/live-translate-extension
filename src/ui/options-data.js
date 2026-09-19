/**
 * 设置页「数据」分区：导出、导入、恢复默认。
 * 导入和恢复都是整体覆盖：写入存储、通知 YouTube 页面，然后重载设置页，
 * 免得页面里各个卡片闭包还拿着旧对象。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  LT.OptionsUI = LT.OptionsUI || {};
  const APP = 'liuyi';

  const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  };

  /** 导出对象：默认剔除 Key；providers 里的 apiKey 也剔除。 */
  function exportObject(settings, includeKeys, version) {
    const copy = JSON.parse(JSON.stringify(LT.Settings.normalize(settings)));
    if (!includeKeys) {
      copy.apiKeys = '';
      for (const p of copy.providers) p.apiKey = '';
    }
    return { app: APP, version, exportedAt: new Date().toISOString(), includesKeys: !!includeKeys, settings: copy };
  }

  /** 校验并合并导入文件：不含 Key 时保留现有 Key（按接口配置 id 对应）。 */
  function importObject(raw, current) {
    if (!raw || raw.app !== APP || !raw.settings || typeof raw.settings !== 'object') {
      throw new Error('这不是流译的设置文件');
    }
    const next = LT.Settings.normalize(raw.settings);
    if (!raw.includesKeys) {
      next.apiKeys = current.apiKeys;
      for (const p of next.providers) {
        if (p.apiKey) continue;
        const own = (current.providers || []).find((q) => q.id === p.id);
        if (own) p.apiKey = own.apiKey;
      }
    }
    return next;
  }

  function download(name, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * @param {{$: (id: string) => HTMLElement, settings: () => object, replace: (next: object) => Promise<void>, version: string}} ctx
   */
  function mountData(ctx) {
    const $ = ctx.$;
    const state = (text) => {
      $('dataState').textContent = text;
    };

    $('exportSettings').addEventListener('click', () => {
      const includeKeys = $('includeKeys').checked;
      const out = exportObject(ctx.settings(), includeKeys, ctx.version);
      download(`${APP}-settings-${stamp()}.json`, JSON.stringify(out, null, 2));
      state(includeKeys ? '已导出（包含 API Key，请妥善保管文件）' : '已导出（不含 API Key）');
    });

    $('importSettings').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', async () => {
      const file = $('importFile').files && $('importFile').files[0];
      $('importFile').value = '';
      if (!file) return;
      let next;
      let raw;
      try {
        raw = JSON.parse(await file.text());
        next = importObject(raw, ctx.settings());
      } catch (err) {
        state(`导入失败：${err && err.message ? err.message : '文件无法解析'}`);
        return;
      }
      const summary = `${next.scenes.length} 个场景、${next.providers.length} 套接口配置、${raw.includesKeys ? '包含' : '不含'} API Key`;
      if (!confirm(`用文件里的设置覆盖当前设置？\n${summary}\n字幕缓存不受影响。`)) return;
      await ctx.replace(next);
    });

    $('resetSettings').addEventListener('click', async () => {
      const keep = $('keepKeys').checked;
      if (!confirm(`恢复全部默认设置？${keep ? 'API Key 与接口配置会保留。' : 'API Key 与接口配置也会清空。'}\n字幕缓存不受影响。`)) return;
      const current = ctx.settings();
      const next = LT.Settings.normalize({});
      if (keep) {
        next.apiKeys = current.apiKeys;
        next.providers = JSON.parse(JSON.stringify(current.providers));
        next.subsProviderId = current.subsProviderId;
      }
      await ctx.replace(LT.Settings.normalize(next));
    });
  }

  LT.OptionsUI.mountData = mountData;
  LT.OptionsUI.exportObject = exportObject;
  LT.OptionsUI.importObject = importObject;
})();
