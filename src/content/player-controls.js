/** 把单个流译入口放进 YouTube 原生底部控制栏，点击展开轻量二级菜单调节翻译与字幕外观。 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;

  const DISPLAY_MODES = [
    { id: 'bilingual', label: '双语' },
    { id: 'translationOnly', label: '仅译文' },
    { id: 'originalOnly', label: '仅原文' },
  ];

  function clamp(num, min, max, fallback) {
    const n = Number(num);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  class PlayerControls {
    constructor({ onToggleCaptions, onToggleTranslation, onRetranslate, onUpdateSettings }) {
      this.onToggleCaptions = onToggleCaptions;
      this.onToggleTranslation = onToggleTranslation;
      this.onRetranslate = onRetranslate;
      this.onUpdateSettings = onUpdateSettings;
      this.player = null;
      this.bar = null;
      this.root = null;
      this.button = null;
      this.menu = null;
      this.menuOpen = false;
      this.lastState = null;
      this.onDocPointerDown = (event) => {
        if (this.menuOpen && this.root && !this.root.contains(event.target)) {
          this.setMenuOpen(false);
        }
      };
      this.onDocKeyDown = (event) => {
        if (this.menuOpen && event.key === 'Escape') {
          this.setMenuOpen(false);
        }
      };
    }

    mount(player) {
      const bar = player?.querySelector('.ytp-right-controls');
      // 控制栏尚未出现时等下一次巡检；绝不退回到画面上的绝对定位悬浮入口。
      if (!bar) {
        this.unmount();
        return;
      }
      if (this.player === player && this.bar === bar && this.root?.parentElement === bar) return;
      this.unmount();

      const root = document.createElement('div');
      root.className = 'lt-player-controls';
      // YouTube 会在播放器根上处理双击等手势，按钮与二级菜单操作不能触发播放或全屏。
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend']) {
        root.addEventListener(type, (event) => {
          event.stopPropagation();
          if (type === 'dblclick') event.preventDefault();
        });
      }
      root.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape' && this.menuOpen) {
          this.setMenuOpen(false);
          this.button?.focus();
        }
      });

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lt-player-controls__button';
      button.setAttribute('aria-haspopup', 'true');
      button.setAttribute('aria-expanded', 'false');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const strokes = [
        'M3 5h10M8 3v2M11 5c-.6 4.1-2.9 7-7 9',
        'M5 8c.8 2.4 2.7 4.2 5 5.6',
        'm13 20 3.5-9 3.5 9m-6.2-2h5.4',
      ];
      for (const d of strokes) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
      }
      button.appendChild(svg);
      button.addEventListener('click', () => {
        if (this.button.disabled) return;
        this.setMenuOpen(!this.menuOpen);
      });

      const menu = this.buildMenu();
      root.appendChild(button);
      root.appendChild(menu);
      bar.insertBefore(root, bar.firstChild);
      document.addEventListener?.('pointerdown', this.onDocPointerDown, true);
      document.addEventListener?.('keydown', this.onDocKeyDown, true);
      Object.assign(this, { player, bar, root, button, menu });
      if (this.lastState) this.update(this.lastState);
    }

    buildMenu() {
      const menu = document.createElement('div');
      menu.className = 'lt-player-menu';
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-label', '流译字幕设置');
      menu.hidden = true;

      // 顶部状态与主操作区
      const header = document.createElement('div');
      header.className = 'lt-player-menu__header';
      const metaWrap = document.createElement('div');
      metaWrap.className = 'lt-player-menu__meta';
      const modeTitle = document.createElement('div');
      modeTitle.className = 'lt-player-menu__title';
      modeTitle.textContent = '流译';
      const statusText = document.createElement('div');
      statusText.className = 'lt-player-menu__status';
      metaWrap.append(modeTitle, statusText);

      const primaryBtn = document.createElement('button');
      primaryBtn.type = 'button';
      primaryBtn.className = 'lt-player-menu__primary';
      primaryBtn.addEventListener('click', () => this.primaryAction?.());
      header.append(metaWrap, primaryBtn);

      // 字幕显隐开关行
      const captionRow = document.createElement('button');
      captionRow.type = 'button';
      captionRow.className = 'lt-player-menu__row lt-player-menu__row--clickable';
      captionRow.setAttribute('role', 'switch');
      const captionLabel = document.createElement('span');
      captionLabel.className = 'lt-player-menu__label';
      captionLabel.textContent = '显示字幕';
      const switchWrap = document.createElement('span');
      switchWrap.className = 'lt-player-menu__switch';
      const switchThumb = document.createElement('span');
      switchThumb.className = 'lt-player-menu__switch-thumb';
      switchWrap.appendChild(switchThumb);
      captionRow.append(captionLabel, switchWrap);
      captionRow.addEventListener('click', () => this.onToggleCaptions?.());

      // 双语 / 仅译文 / 仅原文（整片字幕）
      const modeRow = document.createElement('div');
      modeRow.className = 'lt-player-menu__row';
      const modeLabel = document.createElement('span');
      modeLabel.className = 'lt-player-menu__label';
      modeLabel.textContent = '字幕内容';
      const seg = document.createElement('div');
      seg.className = 'lt-player-menu__seg';
      this.modeButtons = {};
      for (const item of DISPLAY_MODES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lt-player-menu__seg-btn';
        btn.textContent = item.label;
        btn.addEventListener('click', () => {
          this.onUpdateSettings?.({ captionDisplayMode: item.id });
        });
        this.modeButtons[item.id] = btn;
        seg.appendChild(btn);
      }
      modeRow.append(modeLabel, seg);

      // 字号缩放
      const scaleRow = document.createElement('div');
      scaleRow.className = 'lt-player-menu__row';
      const scaleLabel = document.createElement('span');
      scaleLabel.className = 'lt-player-menu__label';
      scaleLabel.textContent = '字幕字号';
      const scaleStepper = document.createElement('div');
      scaleStepper.className = 'lt-player-menu__stepper';
      const scaleDown = document.createElement('button');
      scaleDown.type = 'button';
      scaleDown.className = 'lt-player-menu__step-btn';
      scaleDown.textContent = '−';
      scaleDown.title = '缩小字号';
      scaleDown.setAttribute('aria-label', '缩小字号');
      const scaleVal = document.createElement('button');
      scaleVal.type = 'button';
      scaleVal.className = 'lt-player-menu__step-val';
      scaleVal.title = '点击重置为 100%';
      const scaleUp = document.createElement('button');
      scaleUp.type = 'button';
      scaleUp.className = 'lt-player-menu__step-btn';
      scaleUp.textContent = '＋';
      scaleUp.title = '放大字号';
      scaleUp.setAttribute('aria-label', '放大字号');
      scaleDown.addEventListener('click', () => this.stepScale(-0.1));
      scaleVal.addEventListener('click', () => this.onUpdateSettings?.({ captionScale: 1 }));
      scaleUp.addEventListener('click', () => this.stepScale(0.1));
      scaleStepper.append(scaleDown, scaleVal, scaleUp);
      scaleRow.append(scaleLabel, scaleStepper);

      // 距底高度
      const bottomRow = document.createElement('div');
      bottomRow.className = 'lt-player-menu__row';
      const bottomLabel = document.createElement('span');
      bottomLabel.className = 'lt-player-menu__label';
      bottomLabel.textContent = '距底高度';
      const bottomStepper = document.createElement('div');
      bottomStepper.className = 'lt-player-menu__stepper';
      const bottomDown = document.createElement('button');
      bottomDown.type = 'button';
      bottomDown.className = 'lt-player-menu__step-btn';
      bottomDown.textContent = '−';
      bottomDown.title = '下移字幕';
      bottomDown.setAttribute('aria-label', '下移字幕');
      const bottomVal = document.createElement('button');
      bottomVal.type = 'button';
      bottomVal.className = 'lt-player-menu__step-val';
      bottomVal.title = '点击重置为 11%';
      const bottomUp = document.createElement('button');
      bottomUp.type = 'button';
      bottomUp.className = 'lt-player-menu__step-btn';
      bottomUp.textContent = '＋';
      bottomUp.title = '上移字幕';
      bottomUp.setAttribute('aria-label', '上移字幕');
      bottomDown.addEventListener('click', () => this.stepBottom(-2));
      bottomVal.addEventListener('click', () => this.onUpdateSettings?.({ captionBottom: 11 }));
      bottomUp.addEventListener('click', () => this.stepBottom(2));
      bottomStepper.append(bottomDown, bottomVal, bottomUp);
      bottomRow.append(bottomLabel, bottomStepper);

      menu.append(header, captionRow, modeRow, scaleRow, bottomRow);
      Object.assign(this, {
        modeTitle,
        statusText,
        primaryBtn,
        captionRow,
        modeRow,
        scaleVal,
        scaleDown,
        scaleUp,
        bottomVal,
        bottomDown,
        bottomUp,
      });
      return menu;
    }

    stepScale(delta) {
      const current = clamp(this.lastState?.captionScale, 0.6, 2.5, 1);
      const next = Math.round(clamp(current + delta, 0.6, 2.5, 1) * 100) / 100;
      this.onUpdateSettings?.({ captionScale: next });
    }

    stepBottom(delta) {
      const current = clamp(this.lastState?.captionBottom, 2, 60, 11);
      const next = Math.round(clamp(current + delta, 2, 60, 11));
      this.onUpdateSettings?.({ captionBottom: next });
    }

    setMenuOpen(open) {
      const next = !!open && !!this.root && !this.button?.disabled;
      this.menuOpen = next;
      if (this.menu) this.menu.hidden = !next;
      if (this.button) this.button.setAttribute('aria-expanded', String(next));
      if (this.root) this.root.dataset.menuOpen = next ? 'yes' : 'no';
    }

    unmount() {
      document.removeEventListener?.('pointerdown', this.onDocPointerDown, true);
      document.removeEventListener?.('keydown', this.onDocKeyDown, true);
      this.root?.remove();
      this.player = null;
      this.bar = null;
      this.root = null;
      this.button = null;
      this.menu = null;
      this.menuOpen = false;
      this.primaryAction = null;
    }

    update(state) {
      if (!state) return;
      this.lastState = state;
      if (!this.root) return;

      const live = !!state.isLive || state.phase === 'starting' || state.phase === 'running';
      const active = state.phase === 'starting' || state.phase === 'running';
      const video = state.video || {};
      const working = ['reading', 'downloading', 'transcribing', 'translating'].includes(video.phase);
      let action;
      let primaryLabel;
      let statusDesc;
      if (!state.modeKnown) {
        action = '正在识别直播或视频…';
        primaryLabel = '识别中…';
        statusDesc = '正在检测当前视频类型';
      } else if (live) {
        action = active ? (state.phase === 'starting' ? '取消启动实时翻译' : '停止实时翻译') : '开始实时翻译';
        primaryLabel = action;
        statusDesc = active
          ? (state.phase === 'starting' ? '正在建立实时音频连接…' : '实时音频翻译运行中')
          : '直播模式 · 采集播放器音频';
      } else {
        action = working ? '取消整片翻译'
          : video.phase === 'ready' ? (video.visible ? '隐藏整片字幕' : '显示整片字幕')
            : video.phase === 'partial' ? '继续翻译整片字幕' : '翻译整片字幕';
        primaryLabel = working ? '取消翻译'
          : video.phase === 'ready' ? '重新翻译'
            : video.phase === 'partial' ? '继续翻译' : '翻译字幕';
        statusDesc = working
          ? (video.phase === 'downloading' || video.phase === 'transcribing'
              ? (video.stage || (video.phase === 'downloading' ? 'VPS 下载音频中…' : `VPS 转写中${video.progress ? ` ${video.progress}%` : '…'}`))
              : (video.total ? `翻译中 · ${video.done || 0}/${video.total} 块` : '正在读取并分句…'))
          : video.phase === 'ready' ? '整片字幕已就绪'
            : video.phase === 'partial' ? `已完成 ${video.done || 0}/${video.total || 0} 块`
              : video.phase === 'error' ? (video.error || '翻译失败')
                : '视频模式 · 整片字幕精确翻译';
      }

      if (!state.modeKnown && this.menuOpen) this.setMenuOpen(false);
      this.button.disabled = !state.modeKnown;
      this.button.setAttribute('aria-label', action);
      this.button.title = action;
      const on = active || working || (!live && video.phase === 'ready' && !!video.visible);
      this.button.setAttribute('aria-pressed', String(on));
      this.root.dataset.active = on ? 'yes' : 'no';

      // 更新二级菜单
      this.modeTitle.textContent = live ? '流译 · 直播实时翻译' : '流译 · 视频整片字幕';
      this.statusText.textContent = statusDesc;
      this.primaryBtn.disabled = !state.modeKnown;
      this.primaryBtn.textContent = primaryLabel;
      this.primaryBtn.dataset.tone = (active || working) ? 'danger' : (video.phase === 'ready' && !live ? 'subtle' : 'primary');
      this.primaryAction = !live && video.phase === 'ready'
        ? () => (this.onRetranslate ? this.onRetranslate() : this.onToggleTranslation?.())
        : () => this.onToggleTranslation?.();

      const captionsVisible = live ? state.liveCaptionsVisible !== false : !!video.visible;
      this.captionRow.setAttribute('aria-checked', String(captionsVisible));
      this.captionRow.dataset.checked = captionsVisible ? 'yes' : 'no';

      // 直播只输出译文，整片字幕可切换双语 / 仅译文 / 仅原文
      this.modeRow.hidden = live;
      const displayMode = state.captionDisplayMode || 'bilingual';
      for (const [id, btn] of Object.entries(this.modeButtons || {})) {
        const selected = id === displayMode;
        btn.dataset.active = selected ? 'yes' : 'no';
        btn.setAttribute('aria-pressed', String(selected));
      }

      const scale = clamp(state.captionScale, 0.6, 2.5, 1);
      this.scaleVal.textContent = `${Math.round(scale * 100)}%`;
      this.scaleDown.disabled = scale <= 0.6;
      this.scaleUp.disabled = scale >= 2.5;

      const bottom = clamp(state.captionBottom, 2, 60, 11);
      this.bottomVal.textContent = `${Math.round(bottom)}%`;
      this.bottomDown.disabled = bottom <= 2;
      this.bottomUp.disabled = bottom >= 60;
    }
  }

  LT.PlayerControls = PlayerControls;
})();
