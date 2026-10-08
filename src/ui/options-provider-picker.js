/** 添加 API 提供商：只展示当前可用的服务预设。 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  LT.OptionsUI = LT.OptionsUI || {};

  const GROUPS = [
    { code: 'llm', label: '文字模型', description: '填写自己的 Key，同一接口可供多个功能选择不同模型。' },
    { code: 'compatible', label: '自定义接口', description: '支持 OpenAI 兼容或 Gemini 协议，可填写自己的地址和请求头。' },
    { code: 'live', label: '实时音频翻译', description: '连接播放器音频翻译服务。' },
    { code: 'speech', label: '原文朗读', description: '配置朗读服务、连接和音色。' },
  ];
  const MARKS = {
    gemini: '✦', openai: 'O', deepseek: 'DS', bailian: '阿', 'bailian-intl': '阿', groq: 'g', moonshot: 'M',
    custom: '≡', 'gemini-live': '✦', 'qwen-live': '千', 'microsoft-tts': 'M', 'gemini-tts': '✦',
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function mountProviderPicker({ button, dialog, closeButton, catalog, onChoose }) {
    for (const group of GROUPS) {
      const section = node('section', 'provider-catalog-group');
      section.dataset.group = group.code;
      const title = node('h3', '', group.label);
      title.id = `provider-group-${group.code}`;
      section.setAttribute('aria-labelledby', title.id);
      section.append(title, node('p', 'provider-catalog-description', group.description));
      const grid = node('div', 'provider-catalog-grid');
      for (const preset of LT.PROVIDER_PRESETS.filter(item => item.group === group.code && !item.pending)) {
        const item = node('button', 'provider-catalog-item');
        item.type = 'button';
        item.dataset.preset = preset.code;
        const mark = node('span', 'provider-catalog-mark', MARKS[preset.code] || preset.label.slice(0, 1));
        mark.setAttribute('aria-hidden', 'true');
        const name = node('span', 'provider-catalog-name');
        const region = /^(.+)(（[^）]+）)$/.exec(preset.label);
        if (region) name.append(node('span', '', region[1]), node('span', 'provider-catalog-region', region[2]));
        else name.textContent = preset.label;
        item.append(mark, name);
        item.addEventListener('click', () => {
          dialog.close();
          onChoose(preset);
        });
        grid.appendChild(item);
      }
      section.appendChild(grid);
      catalog.appendChild(section);
    }

    button.addEventListener('click', () => {
      dialog.showModal();
      button.setAttribute('aria-expanded', 'true');
    });
    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => button.setAttribute('aria-expanded', 'false'));
    // 原生 dialog 管理 Esc 和键盘焦点；只有点在遮罩时才关闭。
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  }

  LT.OptionsUI.mountProviderPicker = mountProviderPicker;
})();
