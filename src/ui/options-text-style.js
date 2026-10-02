/** 评论与弹幕的预设选择、独立保存与即时预览。 */
globalThis.LT.OptionsUI = globalThis.LT.OptionsUI || {};
(() => {
  const LT = globalThis.LT;
  LT.OptionsUI.mountTextStyle = ({ $, settings, save }) => {
    let scope = 'comment';
    const names = { comment: '评论', chat: '弹幕' };
    const choices = new Map();
    const colored = new Set(['textColor', 'underline', 'dotted', 'dashed', 'wavy', 'highlight', 'marker', 'quote', 'box']);

    function refresh() {
      const current = settings();
      const selected = current[`${scope}TranslationStyle`];
      for (const button of $('textStyleScope').querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String(button.dataset.scope === scope));
      }
      for (const [code, { input, sample }] of choices) {
        input.checked = code === selected;
        LT.YouTubeText.applyResultStyle(sample, { ...current, [`${scope}TranslationStyle`]: code }, scope);
      }
      $('textStyleColor').value = current[`${scope}TranslationColor`];
      $('textStyleColorValue').textContent = current[`${scope}TranslationColor`];
      $('textStyleColor').disabled = !colored.has(selected);
      $('textStyleColorHint').textContent = colored.has(selected)
        ? selected === 'textColor' ? '调整译文字色。' : '调整线条、边框或底色，文字沿用原消息颜色。'
        : '这个样式沿用原消息颜色，无需设置装饰色。';
      $('textStyleSelected').textContent = `${names[scope]} · ${LT.TEXT_STYLES.find(item => item.code === selected)?.label || '原样'}`;
      $('textStyleReset').textContent = `恢复${names[scope]}默认`;
      $('textStylePreviewComment').hidden = scope !== 'comment';
      $('textStylePreviewChat').hidden = scope !== 'chat';
      const result = $(scope === 'comment' ? 'textStyleCommentResult' : 'textStyleChatResult');
      const source = $(scope === 'comment' ? 'textStyleCommentSource' : 'textStyleChatSource');
      LT.YouTubeText.showResult(result, source, scope === 'comment'
        ? '今天的歌回太开心了！期待下一次直播。\n这首歌听多少遍都不会腻 🎉'
        : '这首歌太好听了！谢谢你带来这么棒的直播 ❤️', 'zh');
      LT.YouTubeText.applyResultStyle(result, current, scope);
    }

    function bind() {
      for (const style of LT.TEXT_STYLES) {
        const label = document.createElement('label');
        label.className = 'text-style-choice';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'textTranslationStyle';
        input.value = style.code;
        input.className = 'text-style-radio';
        const title = document.createElement('span');
        title.className = 'text-style-name';
        title.textContent = style.label;
        const sample = document.createElement('span');
        sample.className = 'lt-yt-text text-style-sample';
        sample.setAttribute('aria-hidden', 'true');
        LT.YouTubeText.showResult(sample, label, '译文效果', 'zh');
        label.append(input, title, sample);
        $('textStyleChoices').append(label);
        choices.set(style.code, { input, sample });
        input.addEventListener('change', () => {
          if (!input.checked) return;
          save({ [`${scope}TranslationStyle`]: input.value });
          refresh();
        });
      }
      for (const button of $('textStyleScope').querySelectorAll('button')) {
        button.addEventListener('click', () => { scope = button.dataset.scope; refresh(); });
      }
      $('textStyleColor').addEventListener('input', () => {
        save({ [`${scope}TranslationColor`]: $('textStyleColor').value });
        refresh();
      });
      $('textStyleReset').addEventListener('click', () => {
        save({ [`${scope}TranslationStyle`]: LT.DEFAULTS[`${scope}TranslationStyle`],
          [`${scope}TranslationColor`]: LT.DEFAULTS[`${scope}TranslationColor`] });
        refresh();
      });
      for (const button of $('textStyleTheme').querySelectorAll('button')) {
        button.addEventListener('click', () => {
          $('textStylePreview').dataset.theme = button.dataset.theme;
          for (const option of $('textStyleTheme').querySelectorAll('button')) {
            option.setAttribute('aria-pressed', String(option === button));
          }
        });
      }
      refresh();
    }
    return { bind, refresh };
  };
})();
