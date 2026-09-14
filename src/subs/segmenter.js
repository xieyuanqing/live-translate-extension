/**
 * 把 json3 片段整理成翻译单元：编号、起止时间、原文。
 *
 * 人工字幕：保留原来的分条，只清理空白。
 * 自动字幕：逐词合并后按「估算停顿 → 最长字数 / 最长时长」切分。
 * json3 的词只有起点没有终点，停顿只能按字数估算，所以阈值故意放宽，
 * 宁可一条长一点，也不要把一句日语从谓语前面切断。
 *
 * 时间轴始终由这里决定，模型只看编号和文字。规则改动要升 LT.SUBS.SEG_VERSION，
 * 否则旧缓存的编号对不上新分句。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;

  const isCjk = (lang) => /^(ja|zh|ko)/i.test(String(lang || ''));

  function profile(lang) {
    const cjk = isCjk(lang);
    return {
      cjk,
      joiner: cjk ? '' : ' ',
      charMs: cjk ? 150 : 65, // 估算一个字符的发音时长
      maxChars: cjk ? 50 : 110, // 翻译单元上限；屏幕换行由字幕层自己处理
      minChars: cjk ? 6 : 12, // 切分时两侧尽量不短于这个数
      pauseMs: 800, // 估算停顿达到这个值就断句
      maxDurMs: 10000,
      lingerMs: 1800, // 最后一个词说完后字幕再停留多久
      tinyChars: cjk ? 2 : 3, // 比这还短的碎片并入下一条
    };
  }

  const estEnd = (w, p) => w.t + Math.min(2500, Math.max(200, w.text.length * p.charMs));
  const pauseAfter = (words, i, p) => (i + 1 < words.length ? words[i + 1].t - estEnd(words[i], p) : Infinity);
  const textLen = (words, p) => words.reduce((n, w) => n + w.text.length, 0) + (p.cjk ? 0 : Math.max(0, words.length - 1));

  /** 超限的一组词在最大的停顿处一分为二，递归到满足限制为止。 */
  function splitGroup(words, p) {
    const tooLong = textLen(words, p) > p.maxChars || words[words.length - 1].t - words[0].t > p.maxDurMs;
    if (!tooLong || words.length < 2) return [words];
    let best = -1;
    let bestPause = -Infinity;
    const mid = (words.length - 1) / 2;
    for (let i = 0; i < words.length - 1; i++) {
      const left = textLen(words.slice(0, i + 1), p);
      const right = textLen(words.slice(i + 1), p);
      const balanced = left >= p.minChars && right >= p.minChars;
      // 优先在两侧都不太短的位置切；实在没有，再退回任意位置的最大停顿。
      // 停顿相同（匀速说话）时偏向中间，避免切出一长串 6 字的碎条。
      const score = pauseAfter(words, i, p) + (balanced ? 1e6 : 0) - Math.abs(i - mid);
      if (score > bestPause) {
        bestPause = score;
        best = i;
      }
    }
    return [...splitGroup(words.slice(0, best + 1), p), ...splitGroup(words.slice(best + 1), p)];
  }

  function buildAsr(events, p) {
    const words = [];
    for (const ev of events) for (const w of ev.words) words.push(w);
    if (words.length === 0) return [];

    // 1. 按停顿分组
    let groups = [];
    let cur = [words[0]];
    for (let i = 1; i < words.length; i++) {
      if (pauseAfter(words, i - 1, p) >= p.pauseMs) {
        groups.push(cur);
        cur = [];
      }
      cur.push(words[i]);
    }
    groups.push(cur);

    // 2. 超长的组再切
    groups = groups.flatMap((g) => splitGroup(g, p));

    // 3. 极短碎片（「あ」「うん」这种）并入下一条，避免刷屏
    const merged = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const next = groups[i + 1];
      if (
        next &&
        textLen(g, p) <= p.tinyChars &&
        next[0].t - estEnd(g[g.length - 1], p) < 1500 &&
        textLen([...g, ...next], p) <= p.maxChars
      ) {
        groups[i + 1] = [...g, ...next];
        continue;
      }
      merged.push(g);
    }

    // 4. 起止时间：起点是第一个词，终点不越过下一条，也不在说完后停留太久
    return merged.map((g, i) => {
      const start = g[0].t;
      const spoken = estEnd(g[g.length - 1], p);
      let end = spoken + p.lingerMs;
      if (merged[i + 1]) end = Math.min(end, merged[i + 1][0].t);
      end = Math.max(end, start + 500);
      return { start, end, text: g.map((w) => w.text).join(p.joiner) };
    });
  }

  function buildManual(events, p) {
    return events.map((ev, i) => {
      let end = ev.end > ev.start ? ev.end : ev.start + 3000;
      if (ev.end <= ev.start && events[i + 1]) end = Math.min(end, events[i + 1].start);
      return { start: ev.start, end: Math.max(end, ev.start + 300), text: ev.words.map((w) => w.text).join(p.joiner) };
    });
  }

  /**
   * @param {ReturnType<typeof LT.Json3.parse>} events
   * @param {{isAsr:boolean, lang:string}} opts
   * @returns {{id:number,start:number,end:number,text:string}[]}
   */
  function build(events, opts) {
    const p = profile(opts && opts.lang);
    const raw = opts && opts.isAsr ? buildAsr(events, p) : buildManual(events, p);
    return raw
      .filter((u) => u.text)
      .map((u, i) => ({ id: i + 1, start: Math.round(u.start), end: Math.round(u.end), text: u.text }));
  }

  LT.Segmenter = { build, isCjk, profile };
})();
