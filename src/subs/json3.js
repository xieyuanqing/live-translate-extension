/**
 * YouTube timedtext json3 解析。
 *
 * 只做格式层：把 events 摊平成带绝对时间的文字片段，不做分句，分句在 segmenter.js。
 * - 人工字幕：一个 event 就是一条，segs 只有文字和换行
 * - 自动字幕（asr）：segs 逐词带 tOffsetMs（只有起点没有终点）；
 *   aAppend 事件只是播放器滚动换行的标记，没有内容，直接跳过
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
      const sig = `${start}|${words.map((w) => w.text).join('\u0001')}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ start, end: start + dur, words });
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  /** 粗略判断一段文本是不是 json3（拦截到的响应也可能是 srv3 XML 或空串）。 */
  function looksLikeJson3(text) {
    if (typeof text !== 'string') return false;
    const head = text.slice(0, 200).trimStart();
    return head.startsWith('{') && text.includes('"events"');
  }

  LT.Json3 = { parse, looksLikeJson3 };
})();
