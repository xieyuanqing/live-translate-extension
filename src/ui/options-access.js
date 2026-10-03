/** 设置页共用的域名授权控件：权限始终可见，地址变化作废迟到的检查和授权结果。 */
globalThis.LT = globalThis.LT || {};
(() => {
  const LT = globalThis.LT;
  LT.OptionsUI = LT.OptionsUI || {};
  const widgets = new Set();
  for (const event of [chrome.permissions.onAdded, chrome.permissions.onRemoved]) {
    event?.addListener(() => { for (const widget of widgets) widget.refresh(); });
  }
  globalThis.addEventListener?.('focus', () => { for (const widget of widgets) widget.refresh(); });

  function mountHostAccess({ container, getUrl, getTarget, buttonId, statusId }) {
    const row = document.createElement('div');
    row.className = 'host-access-row';
    const label = document.createElement('span');
    label.className = 'host-access-label';
    const status = document.createElement('span');
    status.className = 'host-access-status small';
    status.setAttribute('role', 'status');
    if (statusId) status.id = statusId;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small';
    if (buttonId) button.id = buttonId;
    const help = document.createElement('details');
    help.className = 'host-access-help';
    const summary = document.createElement('summary');
    summary.textContent = 'ⓘ 授权说明';
    const explanation = document.createElement('p');
    explanation.className = 'small';
    help.append(summary, explanation);
    container.className = 'host-access';
    row.append(label, status, button);
    container.append(row, help);
    let revision = 0, state = 'checking', currentKey = '', disposed = false;
    function target() {
      if (getTarget) return getTarget();
      const url = new URL(getUrl());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请填写 https:// 接口地址；本地网关也可用 http://。');
      // Chrome 的主机权限按域名匹配，不限制端口。
      return { origins: [LT.Settings.hostPattern(url.href)], label: url.origin, scopeLabel: '域名权限', button: '授权' };
    }
    const keyOf = value => JSON.stringify(value.origins);
    function paint(next, text, value, detail) {
      state = next;
      currentKey = value ? keyOf(value) : '';
      container.setAttribute('data-state', next);
      label.textContent = value?.scopeLabel || '域名权限';
      status.textContent = `● ${text}`;
      button.textContent = value?.button || '授权';
      button.hidden = !['missing', 'error'].includes(next);
      button.disabled = ['granted', 'checking', 'invalid'].includes(next);
      explanation.textContent = detail || (value
        ? `访问范围：${value.label}。${value.missingText || '授权后可查询模型和测试；浏览器的域名权限不区分端口。'}` : '请先填写有效的接口地址。');
    }
    async function refresh() {
      const id = ++revision;
      let value;
      try { value = target(); }
      catch (error) { paint('invalid', '地址无效', null, error.message); return false; }
      paint('checking', '检查中…', value);
      try {
        const allowed = await chrome.permissions.contains({ origins: value.origins });
        if (disposed || id !== revision) return false;
        paint(allowed ? 'granted' : 'missing', allowed ? '已授权' : '未授权', value);
        return allowed;
      } catch (error) {
        if (!disposed && id === revision) paint('error', '检查失败', value, `无法检查权限：${error.message || error}。可点击授权重试。`);
        return false;
      }
    }
    async function authorize() {
      let value;
      try { value = target(); }
      catch (error) { paint('invalid', '地址无效', null, error.message); return false; }
      if (state === 'granted' && currentKey === keyOf(value)) return true;
      const id = ++revision;
      paint('checking', '等待授权…', value);
      try {
        // 在点击回调内直接发起，保留 Chrome 要求的用户手势。
        const allowed = await chrome.permissions.request({ origins: value.origins });
        if (disposed || keyOf(target()) !== keyOf(value)) return false;
        // onAdded 也可能触发检查；最终状态以这次请求的结果为准。
        revision++;
        paint(allowed ? 'granted' : 'missing', allowed ? '已授权' : '未授权', value,
          allowed ? undefined : `访问范围：${value.label}。本次未获得权限，可点击授权重试。`);
        return allowed;
      } catch (error) {
        if (!disposed && id === revision) paint('error', '授权失败', value, `授权失败：${error.message || error}。可点击授权重试。`);
        return false;
      }
    }
    button.addEventListener('click', authorize);
    const widget = { refresh, authorize, dispose: () => { disposed = true; revision++; widgets.delete(widget); } };
    widgets.add(widget);
    refresh();
    return widget;
  }
  LT.OptionsUI.mountHostAccess = mountHostAccess;
})();
