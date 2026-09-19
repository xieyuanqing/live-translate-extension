/**
 * 分块、排队、请求文本与模型输出校验。全部是纯函数，方便在 Node 里自检。
 *
 * 模型只看「编号 + 原文」，只回「编号 + 译文」。时间轴不进请求，程序按编号回填。
 * 输出格式：每行「编号<TAB>译文」。校验看整个编号集合，而不是只看最后一个编号。
 */
globalThis.LT = globalThis.LT || {};

(() => {
  const LT = globalThis.LT;

  /** 按条数与字符数双上限切块，先到先切。返回 [{i, from, to}]，from/to 为 units 下标（含）。 */
  function plan(units, { chunkUnits, chunkChars }) {
    const chunks = [];
    let from = 0;
    let chars = 0;
    for (let i = 0; i < units.length; i++) {
      const len = units[i].text.length;
      const count = i - from + 1;
      if (count > 1 && (count > chunkUnits || chars + len > chunkChars)) {
        chunks.push({ i: chunks.length, from, to: i - 1 });
        from = i;
        chars = 0;
      }
      chars += len;
    }
    if (units.length > 0) chunks.push({ i: chunks.length, from, to: units.length - 1 });
    return chunks;
  }

  /**
   * 选下一块：含当前位置的最先，其次是后面离得最近的，前面的最后补、离得近的先。
   * @param {string[]} states 'pending' | 'running' | 'done' | 'failed'
   */
  function pick(chunks, states, units, posMs) {
    let best = -1;
    let bestScore = Infinity;
    for (const c of chunks) {
      if (states[c.i] !== 'pending') continue;
      const s = units[c.from].start;
      const e = units[c.to].end;
      let score;
      if (posMs >= s && posMs < e) score = -1;
      else if (s >= posMs) score = s - posMs;
      else score = 1e12 + (posMs - e);
      if (score < bestScore) {
        bestScore = score;
        best = c.i;
      }
    }
    return best;
  }

  /**
   * 含当前位置的块拆成「当前位置起的小段 → 其余部分」，先让眼前的字幕出来。
   * 返回若干个下标区间 [from, to]，按请求顺序排列。
   */
  function ranges(chunk, posIdx, headUnits) {
    const size = chunk.to - chunk.from + 1;
    if (posIdx < chunk.from || posIdx > chunk.to || size <= headUnits * 1.5) return [[chunk.from, chunk.to]];
    const headEnd = Math.min(chunk.to, posIdx + headUnits - 1);
    const out = [[posIdx, headEnd]];
    if (headEnd < chunk.to) out.push([headEnd + 1, chunk.to]);
    if (posIdx > chunk.from) out.push([chunk.from, posIdx - 1]);
    return out;
  }

  function context(units, from, to, n) {
    return {
      before: units.slice(Math.max(0, from - n), from),
      after: units.slice(to + 1, to + 1 + n),
    };
  }

  const line = (u) => `${u.id}\t${u.text}`;

  /** @param {{before:object[], target:object[], after:object[]}} parts */
  function formatRequest(parts) {
    const out = [];
    if (parts.before && parts.before.length) {
      out.push('【前文参考，不要翻译】', ...parts.before.map(line), '');
    }
    out.push('【需要翻译】', ...parts.target.map(line));
    if (parts.after && parts.after.length) {
      out.push('', '【后文参考，不要翻译】', ...parts.after.map(line));
    }
    return out.join('\n');
  }

  const LINE_RE = /^\s*[#[（(]?\s*(\d+)\s*[\]）)]?\s*(?:\t|：|:|\||、|\.\s)\s*(.*?)\s*$/;

  /** 解析「编号 分隔符 译文」。重复编号取第一次出现；没有编号的行接到上一条后面。 */
  function parseResponse(text) {
    const map = new Map();
    let dup = 0;
    let lastId = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const s = raw.trim();
      if (!s || s.startsWith('```')) continue;
      // 「4<TAB>」这种空译文行 trim 后只剩编号，不能当成上一条的续行
      const m = LINE_RE.exec(raw) || (/^\d{1,6}$/.test(s) ? [s, s, ''] : null);
      if (m) {
        const id = Number(m[1]);
        if (map.has(id)) {
          dup++;
          continue;
        }
        map.set(id, m[2].trim());
        lastId = id;
      } else if (lastId && map.has(lastId) && !/^【.*】$/.test(s)) {
        map.set(lastId, `${map.get(lastId)} ${s}`.trim());
      }
    }
    return { map, dup };
  }

  /** 编号集合是否完整、有没有空译文。extra 是不在本次范围里的编号，忽略但记录。 */
  function validate(map, units) {
    const missing = [];
    let extra = 0;
    const ids = new Set(units.map((u) => u.id));
    for (const u of units) {
      const t = map.get(u.id);
      if (t == null || !t.trim()) missing.push(u.id);
    }
    for (const id of map.keys()) if (!ids.has(id)) extra++;
    return { ok: missing.length === 0, missing, extra };
  }

  const TRUNCATED_REASONS = new Set(['MAX_TOKENS', 'LENGTH', 'length']);

  /** 结束原因是长度上限，或者缺的正好是结尾一段，都按截断处理：拆小块重来，而不是原样重试。 */
  function looksTruncated(finishReason, missing, units) {
    if (TRUNCATED_REASONS.has(String(finishReason || ''))) return true;
    if (missing.length === 0 || missing.length === units.length) return false;
    const tail = units.slice(units.length - missing.length).map((u) => u.id);
    return tail.every((id, i) => id === missing[i]);
  }

  LT.Chunker = { plan, pick, ranges, context, formatRequest, parseResponse, validate, looksTruncated };
})();
