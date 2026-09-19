/**
 * YouTube timedtext json3 解析。
 *
 * 只做格式层：把 events 摊平成带绝对时间的文字片段，不做分句，分句在 segmenter.js。
 * - 人工字幕：一个 event 就是一条，segs 只有文字和换行
 * - 自动字幕（asr）：segs 逐词带 tOffsetMs（只有起点没有终点）；
 *   aAppend 事件只是播放器滚动换行的标记，没有内容，直接跳过
 *
 * detectFormat 只用于日志和诊断，不影响解析结果：先在真机上看到各种变体长什么样，再决定要不要
 * 专门处理（卡拉 OK 的多位置轨、特效字幕）。改解析结果要升 LT.SUBS.SEG_VERSION。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;

  /**
   * @param {string|object} json 原始 json3 文本或已解析对象
   * @returns {{start:number,end:number,words:{t:number,text:string}[]}[]} 按时间排序的片段
   */
  function parse(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const events = data && Array.isArray(data.events) ? data.events : [];
    const out = [];
    const seen = new Set();
    for (const ev of events) {
      if (!ev || !Array.isArray(ev.segs) || ev.aAppend) continue;
      const start = Math.max(0, Number(ev.tStartMs) || 0);
      const dur = Math.max(0, Number(ev.dDurationMs) || 0);
      const words = [];
      for (const seg of ev.segs) {
        const text = String((seg && seg.utf8) || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        words.push({ t: start + Math.max(0, Number(seg && seg.tOffsetMs) || 0), text });
      }
      if (words.length === 0) continue;
      // 个别轨道会把同一段重复推送，按「起点 + 文本」去重
      const sig = `${start}|${words.map((w) => w.text).join('')}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ start, end: start + dur, words });
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  /**
   * 识别 json3 的变体（参考 read-frog 的判据），返回一个字符串：
   * - scrolling-asr：自动字幕的滚动窗口，事件带 wWinId 且有 aAppend 换行事件
   * - karaoke：同一时间点反复出现多个不同位置（wpWinPosId）的事件，多见于歌词加注音
   * - animated：一半以上事件短于 100 毫秒且带位置，特效字幕
   * - standard：其他（人工字幕或简单自动字幕）；empty / unknown：没有事件或不是 JSON
   */
  function detectFormat(json) {
    let data = json;
    if (typeof json === 'string') {
      try {
        data = JSON.parse(json);
      } catch (_) {
        return 'unknown';
      }
    }
    const events = data && Array.isArray(data.events) ? data.events.filter((e) => e && typeof e === 'object') : [];
    if (events.length === 0) return 'empty';
    let shortPositioned = 0;
    let collisions = 0;
    let scrolling = false;
    const byStart = new Map();
    for (const ev of events) {
      const positioned = ev.wpWinPosId !== undefined && ev.wpWinPosId !== null;
      if (positioned && Number(ev.dDurationMs || 0) <= 100) shortPositioned++;
      if (ev.wWinId !== undefined && ev.aAppend === 1) scrolling = true;
      if (positioned && Array.isArray(ev.segs)) {
        const key = Number(ev.tStartMs) || 0;
        const set = byStart.get(key) || new Set();
        if (set.size && !set.has(ev.wpWinPosId)) collisions++;
        set.add(ev.wpWinPosId);
        byStart.set(key, set);
      }
    }
    if (events.length >= 50 && shortPositioned / events.length >= 0.5) return 'animated';
    if (collisions >= 3 && collisions / events.length >= 0.1) return 'karaoke';
    if (scrolling) return 'scrolling-asr';
    return 'standard';
  }

  /** 粗略判断一段文本是不是 json3（拦截到的响应也可能是 srv3 XML 或空串）。 */
  function looksLikeJson3(text) {
    if (typeof text !== 'string') return false;
    const head = text.slice(0, 200).trimStart();
    return head.startsWith('{') && text.includes('"events"');
  }

  LT.Json3 = { parse, detectFormat, looksLikeJson3 };
})();
