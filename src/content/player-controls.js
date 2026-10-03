/** 把单个流译入口放进 YouTube 原生底部控制栏，随播放器进入剧场和全屏。 */
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
      this.button = null;
      this.clickAction = null;
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
      // YouTube 会在播放器根上处理双击等手势，按钮操作不能触发播放或全屏。
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend']) {
        root.addEventListener(type, (event) => {
          event.stopPropagation();
          if (type === 'dblclick') event.preventDefault();
        });
      }
      root.addEventListener('keydown', (event) => event.stopPropagation());

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lt-player-controls__button';
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
      button.addEventListener('click', () => this.clickAction?.());

      root.appendChild(button);
      bar.insertBefore(root, bar.firstChild);
      Object.assign(this, { player, bar, root, button });
      if (this.lastState) this.update(this.lastState);
    }

    unmount() {
      this.root?.remove();
      this.player = null;
      this.bar = null;
      this.root = null;
      this.button = null;
      this.clickAction = null;
    }

    update(state) {
      if (!state) return;
      this.lastState = state;
      if (!this.root) return;

      const live = !!state.isLive || state.phase === 'starting' || state.phase === 'running';
      const active = state.phase === 'starting' || state.phase === 'running';
      const video = state.video || {};
      const working = video.phase === 'reading' || video.phase === 'translating';
      let action;
      if (!state.modeKnown) {
        action = '正在识别直播或视频…';
      } else if (live) {
        action = active ? (state.phase === 'starting' ? '取消启动实时翻译' : '停止实时翻译') : '开始实时翻译';
      } else {
        action = working ? '取消整片翻译'
          : video.phase === 'ready' ? (video.visible ? '隐藏整片字幕' : '显示整片字幕')
            : video.phase === 'partial' ? '继续翻译整片字幕' : '翻译整片字幕';
      }
      this.button.disabled = !state.modeKnown;
      this.button.setAttribute('aria-label', action);
      this.button.title = action;
      const on = active || working || (!live && video.phase === 'ready' && !!video.visible);
      this.button.setAttribute('aria-pressed', String(on));
      this.root.dataset.active = on ? 'yes' : 'no';
      this.clickAction = !live && video.phase === 'ready' ? this.onToggleCaptions : this.onToggleTranslation;
    }
  }

  LT.PlayerControls = PlayerControls;
})();
