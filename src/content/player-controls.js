/** 把流译按钮放进 YouTube 原生底部控制栏，随播放器进入剧场和全屏。 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;

  class PlayerControls {
    constructor({ onToggleCaptions, onToggleTranslation }) {
      this.onToggleCaptions = onToggleCaptions;
      this.onToggleTranslation = onToggleTranslation;
      this.player = null;
      this.bar = null;
      this.root = null;
      this.captionsButton = null;
      this.badge = null;
      this.actionButton = null;
      this.actionIcon = null;
      this.lastState = null;
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
      root.setAttribute('role', 'group');
      root.setAttribute('aria-label', '流译播放器控制');
      // YouTube 会在播放器根上处理双击等手势，按钮操作不能触发播放或全屏。
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend']) {
        root.addEventListener(type, (event) => {
          event.stopPropagation();
          if (type === 'dblclick') event.preventDefault();
        });
      }
      root.addEventListener('keydown', (event) => event.stopPropagation());

      const captionsButton = document.createElement('button');
      captionsButton.type = 'button';
      captionsButton.className = 'lt-player-controls__captions';
      const icon = document.createElement('img');
      icon.src = chrome.runtime.getURL('icons/icon32.png');
      icon.alt = '';
      icon.width = 30;
      icon.height = 30;
      const badge = document.createElement('span');
      badge.className = 'lt-player-controls__badge';
      badge.setAttribute('aria-hidden', 'true');
      captionsButton.append(icon, badge);
      captionsButton.addEventListener('click', () => this.onToggleCaptions());

      const actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.className = 'lt-player-controls__action';
      const actionIcon = document.createElement('span');
      actionIcon.className = 'lt-player-controls__action-icon';
      actionIcon.setAttribute('aria-hidden', 'true');
      actionButton.appendChild(actionIcon);
      actionButton.addEventListener('click', () => this.onToggleTranslation());

      root.append(captionsButton, actionButton);
      bar.insertBefore(root, bar.firstChild);
      Object.assign(this, { player, bar, root, captionsButton, badge, actionButton, actionIcon });
      if (this.lastState) this.update(this.lastState);
    }

    unmount() {
      this.root?.remove();
      this.player = null;
      this.bar = null;
      this.root = null;
      this.captionsButton = null;
      this.badge = null;
      this.actionButton = null;
      this.actionIcon = null;
    }

    update(state) {
      if (!state) return;
      this.lastState = state;
      if (!this.root) return;

      const live = !!state.isLive || state.phase === 'starting' || state.phase === 'running';
      const active = state.phase === 'starting' || state.phase === 'running';
      const video = state.video || {};
      const working = video.phase === 'reading' || video.phase === 'translating';
      const captionsAvailable = live ? active : working || video.phase === 'ready' || video.phase === 'partial' || !!video.done;
      const visible = captionsAvailable && (live ? state.liveCaptionsVisible : video.visible);
      const captionAction = visible ? '隐藏' : '显示';
      const mode = live ? '直播' : '整片';
      this.captionsButton.disabled = !state.modeKnown || !captionsAvailable;
      this.captionsButton.setAttribute('aria-pressed', String(!!visible));
      this.captionsButton.setAttribute('aria-label', `${captionAction}${mode}字幕`);
      this.captionsButton.title = `${captionAction}${mode}字幕`;
      this.badge.textContent = visible ? 'ON' : 'OFF';
      this.root.dataset.active = visible ? 'yes' : 'no';

      let action;
      let glyph = '▶';
      if (!state.modeKnown) {
        action = '正在识别直播或视频…';
        glyph = '…';
      } else if (live) {
        action = active ? (state.phase === 'starting' ? '取消启动实时翻译' : '停止实时翻译') : '开始实时翻译';
        if (active) glyph = '■';
      } else {
        action = working ? '取消整片翻译'
          : video.phase === 'ready' ? '整片翻译已完成'
            : video.phase === 'partial' ? '继续翻译整片字幕' : '翻译整片字幕';
        if (working) glyph = '■';
        if (video.phase === 'ready') glyph = '✓';
      }
      this.actionButton.disabled = !state.modeKnown || (!live && video.phase === 'ready');
      this.actionButton.setAttribute('aria-label', action);
      this.actionButton.title = action;
      this.actionButton.dataset.running = active || working ? 'yes' : 'no';
      this.actionIcon.textContent = glyph;
    }
  }

  LT.PlayerControls = PlayerControls;
})();
