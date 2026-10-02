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
      copy.qwenApiKey = '';
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
      next.qwenApiKey = current.qwenApiKey;
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
    const logState = (text) => { $('liveLogState').textContent = text; };

    function logExport(items) {
      return {
        app: APP,
        format: 'live-log-export-v1',
        version: ctx.version,
        exportedAt: new Date().toISOString(),
        logs: items.map(({ key, ...entry }) => entry),
      };
    }

    async function refreshLogs() {
      const box = $('liveLogList');
      box.replaceChildren();
      let logs;
      try { logs = await LT.LiveLog.list(); }
      catch (err) { logState('读取日志失败：' + (err && err.message || err)); return; }
      $('liveLogTotal').textContent = logs.length ? `共 ${logs.length} 场` : '还没有直播日志';
      $('exportAllLiveLogs').disabled = logs.length === 0;
      $('clearLiveLogs').disabled = !logs.some((entry) => entry.endedAt);
      for (const entry of logs) {
        const row = document.createElement('div');
        row.className = 'cache-item';
        const info = document.createElement('div');
        info.className = 'cache-info';
        const title = document.createElement('div');
        title.className = 'cache-title';
        title.textContent = entry.details?.metadata?.title || entry.videoId || '未命名直播';
        const summary = document.createElement('div');
        summary.className = 'muted small';
        summary.textContent = [new Date(entry.startedAt).toLocaleString(), entry.provider === 'qwen' ? '千问' : 'Gemini',
          entry.level === 'detailed' ? '详细' : '基础', `${entry.events.length} 条事件`,
          entry.droppedEvents ? `前段已丢弃 ${entry.droppedEvents} 条` : '',
          entry.endedAt ? '已结束' : '进行中'].filter(Boolean).join(' · ');
        info.append(title, summary);
        const view = document.createElement('button');
        view.className = 'small';
        view.textContent = '提示词';
        view.disabled = !entry.details;
        let expanded = null;
        view.addEventListener('click', async () => {
          if (expanded) { expanded.remove(); expanded = null; view.textContent = '提示词'; return; }
          const latest = (await LT.LiveLog.list()).find(item => item.key === entry.key) || entry;
          const details = LT.LiveLog.safe(latest.details || {}, LT.LiveLog.secretsFrom(ctx.settings()), Infinity);
          const generated = details.generatedContext;
          const terms = Object.entries(generated?.phrases || {});
          const effective = latest.provider === 'qwen'
            ? JSON.stringify({ language: latest.targetLang === 'zh-Hans' ? 'zh' : latest.targetLang,
                ...(Object.keys(details.qwenPhrases || {}).length ? { corpus: { phrases: details.qwenPhrases } } : {}) }, null, 2)
            : details.prompt || '日志未记录完整提示词';
          const text = [
            '【AI 整理配置】', `模型：${details.generatorModel || '这份日志未记录'}`,
            ...(details.contextTimeoutSeconds ? [`等待上限：${details.contextTimeoutSeconds} 秒`] : []),
            ...(details.contextError ? [`失败原因：${details.contextError}`] : []), '',
            '【开播整理结果】', generated?.background || '未生成背景', ...terms.map(([a,b]) => `${a} → ${b}`), '',
            latest.provider === 'qwen' ? '【发送给千问的目标语言与术语；背景说明不发送】' : '【Gemini 本场提示词】', effective, '',
            '【整理模型输入】', details.generatorRequest
              ? `系统：\n${details.generatorRequest.system}\n\n页面资料与补充：\n${details.generatorRequest.user}`
              : '这份日志没有记录整理模型的输入提示词。',
          ].join('\n');
          expanded = document.createElement('div');
          expanded.className = 'live-log-detail';
          const content = document.createElement('textarea');
          content.readOnly = true;
          content.rows = 8;
          content.setAttribute('aria-label', '本场提示词与术语');
          content.value = text;
          const copy = document.createElement('button');
          copy.className = 'small';
          copy.textContent = '复制内容';
          copy.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(text); logState('已复制本场提示词与术语'); }
            catch (_) { logState('复制失败，请在文本框中全选复制'); }
          });
          expanded.append(content, copy);
          info.appendChild(expanded);
          view.textContent = '收起';
        });
        const exportOne = document.createElement('button');
        exportOne.className = 'small';
        exportOne.textContent = '导出';
        exportOne.addEventListener('click', async () => {
          try {
            const latest = (await LT.LiveLog.list()).find((item) => item.key === entry.key) || entry;
            download(`liuyi-live-log-${entry.startedAt}.json`, JSON.stringify(logExport([latest]), null, 2));
            logState('已导出这一场日志');
          } catch (err) { logState('导出失败：' + (err && err.message || err)); }
        });
        const del = document.createElement('button');
        del.className = 'danger small';
        del.textContent = '删除';
        del.disabled = !entry.endedAt;
        if (!entry.endedAt) del.title = '直播进行中，结束后可删除';
        del.addEventListener('click', async () => {
          if (!confirm('删除这一场直播日志？导出过的文件不受影响。')) return;
          await LT.LiveLog.remove(entry.key);
          refreshLogs();
        });
        row.append(info, view, exportOne, del);
        box.appendChild(row);
      }
    }

    $('refreshLiveLogs').addEventListener('click', refreshLogs);
    $('exportAllLiveLogs').addEventListener('click', async () => {
      try {
        const logs = await LT.LiveLog.list();
        if (!logs.length) return;
        download(`${APP}-live-logs-${stamp()}.json`, JSON.stringify(logExport(logs), null, 2));
        logState(`已导出 ${logs.length} 场日志`);
      } catch (err) { logState('导出失败：' + (err && err.message || err)); }
    });
    $('clearLiveLogs').addEventListener('click', async () => {
      const logs = (await LT.LiveLog.list()).filter((item) => item.endedAt);
      if (!logs.length || !confirm(`清空 ${logs.length} 场已结束的直播日志？此操作无法撤销，字幕缓存和设置不受影响。`)) return;
      await Promise.all(logs.map((item) => LT.LiveLog.remove(item.key)));
      logState('日志已清空');
      refreshLogs();
    });

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
        next.qwenApiKey = current.qwenApiKey;
        next.providers = JSON.parse(JSON.stringify(current.providers));
        next.subsProviderId = current.subsProviderId;
      }
      await ctx.replace(LT.Settings.normalize(next));
    });
    return { refreshLogs };
  }

  LT.OptionsUI.mountData = mountData;
  LT.OptionsUI.exportObject = exportObject;
  LT.OptionsUI.importObject = importObject;
})();
