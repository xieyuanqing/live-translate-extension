/**
 * 设置页「字幕外观」分区：控件绑定与真实预览。
 * 预览用的就是内容脚本里的 LT.CaptionLayer，挂在一个假播放器容器上，改任何外观字段都走
 * applySettings，和 YouTube 页面收到 SETTINGS_CHANGED 后的路径一致。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;
  LT.OptionsUI = LT.OptionsUI || {};

  const RANGE_FIELDS = ['captionScale', 'captionBottom', 'captionOpacity', 'captionSourceScale', 'captionWeight', 'captionLines'];
  const FLOAT_FIELDS = new Set(['captionScale', 'captionSourceScale']);
  const COLOR_FIELDS = ['captionColor', 'captionSourceColor'];
  const STYLE_FIELDS = [
    'captionDisplayMode',
    'captionTranslationPosition',
    'captionFont',
    ...RANGE_FIELDS,
    ...COLOR_FIELDS,
  ];

  /**
   * @param {{$: (id: string) => HTMLElement, settings: () => object, save: (patch: object) => void}} ctx
   */
  function mountStyle(ctx) {
    const $ = ctx.$;
    const layer = new LT.CaptionLayer();
    let sample = 'video'; // video | live

    function showSample() {
      if (sample === 'live') {
        layer.clear();
        layer.pushCommitted(['再上一句会逐渐变淡', '这是已经确认的上一句译文']);
        layer.setCurrent('正在说的这一句还没定稿…');
        layer.setSource('今話しているところはまだ確定していません');
        layer.render();
      } else {
        layer.showTimed('这就是整片字幕译文显示的样子', 'これが字幕の見た目です');
      }
    }

    function refresh() {
      layer.applySettings(ctx.settings());
      showSample();
      $('positionField').style.display = ctx.settings().captionDisplayMode === 'bilingual' ? '' : 'none';
    }

    function syncValues() {
      const s = ctx.settings();
      for (const id of RANGE_FIELDS) {
        $(id).value = String(s[id]);
        $(`${id}Val`).textContent = String(s[id]);
      }
      for (const id of COLOR_FIELDS) $(id).value = s[id];
      $('captionFont').value = s.captionFont;
      $('captionTranslationPosition').value = s.captionTranslationPosition;
      for (const b of $('captionDisplayMode').children) {
        b.setAttribute('aria-checked', b.dataset.value === s.captionDisplayMode ? 'true' : 'false');
      }
    }

    function bind() {
      layer.mount($('previewPlayer'));

      const seg = $('captionDisplayMode');
      seg.replaceChildren();
      for (const m of LT.CAPTION_DISPLAY_MODES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.value = m.code;
        b.textContent = m.label;
        b.addEventListener('click', () => {
          ctx.save({ captionDisplayMode: m.code });
          syncValues();
          refresh();
        });
        seg.appendChild(b);
      }

      const font = $('captionFont');
      font.replaceChildren();
      for (const f of LT.CAPTION_FONTS) {
        const o = document.createElement('option');
        o.value = f.code;
        o.textContent = f.label;
        font.appendChild(o);
      }
      font.addEventListener('change', () => {
        ctx.save({ captionFont: font.value });
        refresh();
      });

      $('captionTranslationPosition').addEventListener('change', () => {
        ctx.save({ captionTranslationPosition: $('captionTranslationPosition').value });
        refresh();
      });

      for (const id of RANGE_FIELDS) {
        const el = $(id);
        el.addEventListener('input', () => {
          const v = FLOAT_FIELDS.has(id) ? parseFloat(el.value) : parseInt(el.value, 10);
          $(`${id}Val`).textContent = String(v);
          ctx.save({ [id]: v });
          refresh();
        });
      }

      for (const id of COLOR_FIELDS) {
        const el = $(id);
        el.addEventListener('input', () => {
          ctx.save({ [id]: el.value });
          refresh();
        });
      }

      $('previewMode').addEventListener('click', () => {
        sample = sample === 'live' ? 'video' : 'live';
        $('previewMode').textContent = sample === 'live' ? '切换为整片字幕样式' : '切换为实时翻译样式';
        showSample();
      });

      $('resetStyle').addEventListener('click', () => {
        if (!confirm('恢复默认字幕外观？')) return;
        const patch = {};
        for (const id of STYLE_FIELDS) patch[id] = LT.DEFAULTS[id];
        ctx.save(patch);
        syncValues();
        refresh();
      });

      syncValues();
      refresh();
    }

    return { bind, refresh, syncValues };
  }

  LT.OptionsUI.mountStyle = mountStyle;
})();
