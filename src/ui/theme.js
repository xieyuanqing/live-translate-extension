/** 设置页与弹窗的界面主题；不参与翻译配置或网页配色。 */
(() => {
  const LT = globalThis.LT;
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  let revision = 0;
  let pending = false;

  function apply(value) {
    preference = ['system', 'light', 'dark'].includes(value) ? value : 'system';
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    const button = document.getElementById('toggleTheme');
    if (button) {
      const label = theme === 'dark' ? '切换为浅色界面' : '切换为深色界面';
      button.setAttribute('aria-label', label);
      button.title = label;
      button.setAttribute('aria-pressed', String(theme === 'dark'));
    }
  }

  LT.UITheme = {
    // 手动选择先即时预览，保存结束前忽略较早的存储事件。
    apply(value) {
      revision++;
      pending = true;
      apply(value);
      return revision;
    },
    settle(token, value) {
      if (token !== revision) return;
      pending = false;
      apply(value);
    },
  };
  system.addEventListener('change', () => apply(preference));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    if (pending) return;
    revision++;
    apply(changes.settings.newValue?.uiTheme);
  });
  apply(preference);
  const initialRevision = revision;
  LT.Settings.load().then(settings => {
    if (revision === initialRevision && !pending) apply(settings.uiTheme);
  }).catch(() => {});
})();
