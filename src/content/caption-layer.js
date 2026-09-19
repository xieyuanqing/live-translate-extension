/**
 * 字幕层：注入 #movie_player 内部。
 * 因为是播放器的子元素，全屏 / 剧场 / 迷你播放器都会自动跟随，不需要单独适配。
 * （画中画例外：PiP 里显示不了 DOM，这是浏览器限制。）
 *
 * 外观全部通过 CSS 变量下发（字号、颜色、字体、字重、原文比例），设置页的预览用同一个类
 * 挂到一个假播放器容器上，所以预览和真实播放器走的是同一条渲染路径。
 * 显示模式（双语 / 仅译文 / 仅原文）只在 render 里过滤，不影响上游是否翻译。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;

  class CaptionLayer {
    constructor() {
      this.player = null;
      this.root = null;
      this.status = null;
      this.statusText = null;
      this.lines = [];
      this.current = '';
      this.source = '';
      this.settings = LT.DEFAULTS;
      this.resizeObserver = null;
      this.classObserver = null;
      this.statusTimer = null;
    }

    get mounted() {
      return !!(this.root && this.root.isConnected);
    }

    mount(player) {
      if (this.mounted && this.player === player) return;
      this.unmount();
      this.player = player;

      this.root = document.createElement('div');
      this.root.className = 'lt-caption-layer';

      this.status = document.createElement('div');
      this.status.className = 'lt-status lt-hidden';
      const dot = document.createElement('span');
      dot.className = 'lt-dot';
      this.statusText = document.createElement('span');
      this.status.append(dot, this.statusText);

      player.appendChild(this.root);
      player.appendChild(this.status);

      this.applySettings(this.settings);
      this.#watchPlayer();
      this.render();
    }

    unmount() {
      if (this.resizeObserver) this.resizeObserver.disconnect();
      if (this.classObserver) this.classObserver.disconnect();
      this.resizeObserver = null;
      this.classObserver = null;
      clearTimeout(this.statusTimer);
      if (this.root) this.root.remove();
      if (this.status) this.status.remove();
      this.root = null;
      this.status = null;
      this.statusText = null;
      this.player = null;
    }

    applySettings(settings) {
      this.settings = settings;
      if (!this.root) return;
      const style = this.root.style;
      style.setProperty('--lt-bottom', `${settings.captionBottom}%`);
      style.setProperty('--lt-bg-opacity', String(settings.captionOpacity / 100));
      const font = (LT.CAPTION_FONTS || []).find((f) => f.code === settings.captionFont) || (LT.CAPTION_FONTS || [])[0];
      if (font) style.setProperty('--lt-font-family', font.family);
      if (settings.captionWeight) style.setProperty('--lt-weight', String(settings.captionWeight));
      if (settings.captionColor) style.setProperty('--lt-color', settings.captionColor);
      if (settings.captionSourceColor) style.setProperty('--lt-source-color', settings.captionSourceColor);
      if (settings.captionSourceScale) style.setProperty('--lt-source-scale', `${settings.captionSourceScale}em`);
      this.#scaleFont();
      this.#trimLines();
      this.render();
    }

    clear() {
      this.lines = [];
      this.current = '';
      this.source = '';
      this.render();
    }

    pushCommitted(sentences) {
      if (!sentences || sentences.length === 0) return;
      this.lines.push(...sentences);
      this.#trimLines();
    }

    setCurrent(text) {
      this.current = text || '';
    }

    setSource(text) {
      this.source = text || '';
    }

    setVisible(visible) {
      if (this.root) this.root.classList.toggle('lt-hidden', !visible);
    }

    /** 整片字幕模式：只显示当前时间对应的一条（可带原文），不走「确认行 + 当前行」的滚动模型。 */
    showTimed(text, source) {
      this.lines = text ? [text] : [];
      this.current = '';
      this.source = source || '';
      this.render();
    }

    /**
     * @param {string} text 提示文字，空串表示隐藏
     * @param {'ok'|'warn'|'err'} kind
     * @param {boolean} autoHide ok 状态几秒后自动淡出
     */
    setStatus(text, kind, autoHide) {
      if (!this.status) return;
      clearTimeout(this.statusTimer);
      if (!text) {
        this.status.classList.add('lt-hidden');
        return;
      }
      this.statusText.textContent = text;
      this.status.classList.remove('lt-hidden', 'lt-ok', 'lt-warn', 'lt-err');
      this.status.classList.add(`lt-${kind || 'warn'}`);
      if (autoHide) {
        this.statusTimer = setTimeout(() => {
          if (this.status) this.status.classList.add('lt-hidden');
        }, 2500);
      }
    }

    render() {
      if (!this.root) return;
      const mode = this.settings.captionDisplayMode || 'translationOnly';
      const translation = [];
      if (mode !== 'originalOnly') {
        const total = this.lines.length;
        this.lines.forEach((text, i) => {
          const el = document.createElement('div');
          // 最后一行最亮，往上逐渐变淡，视线自然落在最新一句
          el.className = i === total - 1 ? 'lt-line' : 'lt-line lt-line--dim';
          el.textContent = text;
          translation.push(el);
        });
        if (this.current) {
          const el = document.createElement('div');
          el.className = 'lt-line lt-line--current';
          el.textContent = this.current;
          translation.push(el);
        }
      }
      let source = null;
      if (mode !== 'translationOnly' && this.source) {
        source = document.createElement('div');
        source.className = 'lt-line lt-line--source';
        source.textContent = this.source;
      }
      // 译文在上：先译文再原文；译文在下：先原文再译文
      const frag = document.createDocumentFragment();
      const above = this.settings.captionTranslationPosition !== 'below';
      if (source && !above) frag.appendChild(source);
      for (const el of translation) frag.appendChild(el);
      if (source && above) frag.appendChild(source);
      this.root.replaceChildren(frag);
    }

    #trimLines() {
      const max = this.settings.captionLines;
      if (this.lines.length > max) this.lines.splice(0, this.lines.length - max);
    }

    /** 字号跟播放器宽度走，全屏时自动变大。 */
    #scaleFont() {
      if (!this.root || !this.player) return;
      const w = this.player.clientWidth || 640;
      const px = Math.min(46, Math.max(13, w * 0.0225)) * this.settings.captionScale;
      this.root.style.setProperty('--lt-font', `${px.toFixed(1)}px`);
    }

    #watchPlayer() {
      this.resizeObserver = new ResizeObserver(() => this.#scaleFont());
      this.resizeObserver.observe(this.player);

      // 播放器隐藏控制条时会带上 ytp-autohide；没有这个类就是控制条露出来了，字幕上移让位
      const sync = () => {
        const hidden = this.player.classList.contains('ytp-autohide');
        this.root.classList.toggle('lt-controls-visible', !hidden);
      };
      this.classObserver = new MutationObserver(sync);
      this.classObserver.observe(this.player, {
        attributes: true,
        attributeFilter: ['class'],
      });
      sync();
    }
  }

  LT.CaptionLayer = CaptionLayer;
})();
