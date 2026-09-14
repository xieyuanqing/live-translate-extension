/** 按播放时间查找当前字幕条，以及「从当前位置起连续可看到哪里」。纯函数，不碰 DOM。 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;

  /** 返回覆盖 tMs 的条目下标；没有返回 -1。人工字幕可能重叠，往回多看几条。 */
  function indexAt(units, tMs) {
    if (!units || units.length === 0) return -1;
    let lo = 0;
    let hi = units.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (units[mid].start <= tMs) lo = mid;
      else hi = mid - 1;
    }
    if (units[lo].start > tMs) return -1;
    for (let i = lo; i >= 0 && i > lo - 4; i--) {
      if (units[i].start <= tMs && tMs < units[i].end) return i;
    }
    return -1;
  }

  /**
   * 从 fromIdx 起连续已翻译到的最后一条。
   * @returns {{idx:number, endMs:number}} idx 为 -1 表示当前位置这条还没翻
   */
  function frontier(units, texts, fromIdx) {
    let idx = -1;
    for (let i = Math.max(0, fromIdx); i < units.length; i++) {
      if (texts[i] == null) break;
      idx = i;
    }
    return { idx, endMs: idx >= 0 ? units[idx].end : 0 };
  }

  /** 播放位置落在字幕间隙时，从下一条开始算连续区间。 */
  function nextIndexFrom(units, tMs) {
    const at = indexAt(units, tMs);
    if (at >= 0) return at;
    let lo = 0;
    let hi = units.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (units[mid].start < tMs) lo = mid + 1;
      else hi = mid;
    }
    return lo < units.length ? lo : units.length - 1;
  }

  LT.SubsScheduler = { indexAt, frontier, nextIndexFrom };
})();
