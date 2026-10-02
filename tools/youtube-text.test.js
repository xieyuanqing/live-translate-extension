/** 评论编号校验与页面内缓存回归；模拟文本，不访问 YouTube 或任何模型。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const ctx = vm.createContext({ innerHeight: 600, innerWidth: 800,
    getComputedStyle: node => ({ visibility: node.hidden ? 'hidden' : 'visible', ...node.computedStyle }) });
  for (const file of ['src/common/constants.js', 'src/common/settings.js', 'src/common/youtube-text.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx);
  }
  return ctx.LT;
}

test('评论模型可以乱序返回，译文仍按原编号对应评论和回复', () => {
  const T = harness().YouTubeText;
  const result = T.parseComments('```json\n{"translations":[{"id":2,"text":" 回复 "},{"id":"1","text":"主评论"}]}\n```',
    [{ id: 1, text: 'first' }, { id: 2, text: 'second', parent: 'first' }]);
  assert.equal(result.get(1), '主评论');
  assert.equal(result.get(2), '回复');
});

test('遗漏、重复、多余编号或空译文都拒绝整批结果，避免错位展示及污染缓存', () => {
  const T = harness().YouTubeText;
  const input = [{ id: 1 }, { id: 2 }];
  for (const translations of [
    [{ id: 1, text: 'a' }],
    [{ id: 1, text: 'a' }, { id: 1, text: 'b' }],
    [{ id: 1, text: 'a' }, { id: 2, text: 'b' }, { id: 3, text: 'c' }],
    [{ id: 1, text: 'a' }, { id: 2, text: '  ' }],
    [{ id: 1, text: 'a' }, { id: 2, text: { value: 'b' } }],
  ]) assert.throws(() => T.parseComments(JSON.stringify({ translations }), input));
  for (const invalid of ['no JSON', '{broken}', '{"text":"a"}', 'null']) {
    assert.throws(() => T.parseComments(invalid, input));
  }
});

test('回复父评论只作背景，评论请求保留目标语言、人名术语及资料边界', () => {
  const LT = harness();
  const settings = LT.Settings.normalize({ sourceLang: 'ja', targetLang: 'zh', manualContext: '生日直播' });
  const prompt = LT.YouTubeText.commentPrompt(settings, '频道：YuNi', { ゆに: 'YuNi' });
  assert.match(prompt, /只翻译 text，不翻译 parent/);
  assert.match(prompt, /不可信资料/);
  assert.match(prompt, /<video_context>\n频道：YuNi\n生日直播\nゆに＝YuNi\n<\/video_context>/);
  assert.match(prompt, /所有输入 id 各出现一次/);
});

test('两项默认关闭，启用任一项不改变独立的整理模型和字幕模型', () => {
  const LT = harness();
  const initial = LT.Settings.normalize({ providers: [
    { id: 'small', apiType: 'openai', model: 'context-small' },
    { id: 'strong', apiType: 'openai', model: 'translation-strong' },
  ], liveContextProviderId: 'small', subsProviderId: 'strong' });
  assert.equal(initial.enableChatTranslation, false);
  assert.equal(initial.enableCommentTranslation, false);
  const next = LT.Settings.normalize({ ...initial, enableChatTranslation: true, enableCommentTranslation: true });
  assert.equal(next.liveContextProviderId, 'small');
  assert.equal(next.subsProviderId, 'strong');
  assert.equal(next.enableChatTranslation, true);
  assert.equal(next.enableCommentTranslation, true);
});

test('页面缓存限制条数并更新已有键；滚出窗口、隐藏、断开的评论不算可见', () => {
  const T = harness().YouTubeText;
  const cache = new Map();
  for (const key of ['a', 'b', 'c']) T.remember(cache, key, key, 3);
  T.remember(cache, 'a', 'updated', 3);
  T.remember(cache, 'd', 'last', 3);
  assert.equal(cache.size, 3);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.get('a'), 'updated');
  const node = { isConnected: true, getBoundingClientRect: () => ({ width: 100, height: 20,
    left: 0, right: 100, top: 10, bottom: 30 }) };
  assert.equal(T.visible(node), true);
  assert.equal(T.visible({ ...node, isConnected: false }), false);
  assert.equal(T.visible({ ...node, hidden: true }), false);
  assert.equal(T.visible({ ...node, getBoundingClientRect: () => ({ width: 100, height: 20,
    left: 0, right: 100, top: 700, bottom: 720 }) }), false);
  assert.equal(T.hasWords('🎉🎂'), false);
  assert.equal(T.hasWords('YuNi おめでとう🎉'), true);
});

test('原文读取排除消息内部译文，保留换行、链接和 Unicode 表情，重读不会把译文当原文', () => {
  const T = harness().YouTubeText;
  const text = value => ({ nodeType: 3, textContent: value });
  const element = (tagName, childNodes = [], attributes = {}) => ({ nodeType: 1, tagName, childNodes,
    classList: { contains: name => (attributes.class || '').split(' ').includes(name) },
    getAttribute: name => attributes[name] || null });
  const source = element('SPAN', [text('  おめでとう  '), element('IMG', [], { alt: '🎉' }),
    element('BR'), element('A', [text('YuNi')]),
    element('SPAN', [text('生日快乐，YuNi！')], { class: 'lt-yt-text lt-yt-chat-result' })]);
  assert.equal(T.readText(source), 'おめでとう 🎉\nYuNi');
  source.childNodes.push(element('DIV', [text('次の曲')]), element('P', [text('楽しみ！')]));
  assert.equal(T.readText(source), 'おめでとう 🎉\nYuNi\n次の曲\n\n楽しみ！');
  const emoteOnly = element('SPAN', [element('IMG', [], { alt: ':custom_emote:' })]);
  assert.equal(T.readText(emoteOnly), '');
  assert.equal(T.hasWords(T.readText(emoteOnly, { includeImages: false })), false);
});

test('自定义表情及悬停提示不进入正文；悬停和会员名称变化不生成新翻译', () => {
  const T = harness().YouTubeText;
  const text = value => ({ nodeType: 3, textContent: value });
  const element = (tagName, childNodes = [], attributes = {}) => ({ nodeType: 1, tagName, childNodes,
    classList: { contains: () => false }, getAttribute: name => attributes[name] || null });
  const image = element('IMG', [], { alt: ':Sumireoisumireoise:', title: '自定义表情' });
  const source = element('SPAN', [text('ありがとう'), image, text('またね')]);
  assert.equal(T.readText(source), 'ありがとう またね');
  source.childNodes.push(element('TP-YT-PAPER-TOOLTIP', [text('Sumireoisumireoise (3年)')]));
  assert.equal(T.readText(source), 'ありがとう またね');
  const emojiOnly = element('SPAN', [image,
    element('DIV', [text('Sumireoisumireoise (3年)')], { role: 'tooltip' }),
    element('YT-TOOLTIP-RENDERER', [text('カスタム絵文字')])]);
  assert.equal(T.readText(emojiOnly), '');
  assert.equal(T.shouldTranslateChat(T.readText(emojiOnly, { includeImages: false })), false);
  for (const alt of ['🎉', '🇯🇵', '8️⃣', '👍🏽', '👩‍💻']) {
    assert.equal(T.readText(element('SPAN', [element('IMG', [], { alt })])), alt);
  }
  for (const alt of ['Sumire (3年)', ':おいす:', 'smile', '123', 'bad🎉name']) {
    assert.equal(T.readText(element('SPAN', [element('IMG', [], { alt })])), '');
  }
});

test('聊天跳过纯表情、数字刷屏和常见短反应，兼容大小写、全角、标点及组合', () => {
  const T = harness().YouTubeText;
  for (const text of ['', '   ', '❤️❤️❤️', '🎉👏🥳', '🇯🇵', '8️⃣8️⃣8️⃣', 'www', 'wwwwwww',
    'ＷＷＷ', 'w w w', '草', '草草草！！！', '笑笑', '888888', '８８８８８８', '8 8 8', '1234',
    'KAWAII', 'kawaii!', 'LOL', 'lol 😂', 'NT', 'NICE,GG', 'Nice GG!', 'ＮＩＣＥ，ＧＧ',
    'GG WP', 'lmao', '草 www 8888 ❤️ LOL']) {
    assert.equal(T.shouldTranslateChat(text), false, `应该跳过：${text}`);
  }
});

test('聊天短反应出现在正常句子里不误过滤，保留数字、人名及普通单词', () => {
  const T = harness().YouTubeText;
  for (const text of ['この曲ずっと待ってた！', 'KAWAII衣装ですね', 'NICE outfit!',
    'LOL that was funny', 'GGでした、次も楽しみ', '草の色が変わった', '草生えた', '888人おめでとう',
    'I have 8 cats', 'NTさんありがとう', 'www.example.com を見て', 'お誕生日おめでとう❤️❤️']) {
    assert.equal(T.shouldTranslateChat(text), true, `应该翻译：${text}`);
  }
});

test('旧设置补齐原样预设；评论和弹幕独立保存，无效样式和颜色安全回落', () => {
  const LT = harness();
  const old = LT.Settings.normalize({ captionColor: '#ffffff' });
  assert.equal(old.commentTranslationStyle, 'plain');
  assert.equal(old.chatTranslationStyle, 'plain');
  const next = LT.Settings.normalize({ ...old, commentTranslationStyle: 'quote',
    chatTranslationStyle: 'wavy', commentTranslationColor: '#ABCDEF', chatTranslationColor: '#123456' });
  assert.equal(next.commentTranslationStyle, 'quote');
  assert.equal(next.chatTranslationStyle, 'wavy');
  assert.equal(next.commentTranslationColor, '#abcdef');
  assert.equal(next.chatTranslationColor, '#123456');
  assert.equal(next.captionColor, '#ffffff');
  for (const invalid of ['unknown', 'url(x)', null, {}]) {
    const safe = LT.Settings.normalize({ commentTranslationStyle: invalid, chatTranslationColor: invalid });
    assert.equal(safe.commentTranslationStyle, 'plain');
    assert.equal(safe.chatTranslationColor, LT.DEFAULTS.chatTranslationColor);
  }
});

test('重设样式保留译文内容和收起状态，只修改装饰属性', () => {
  const LT = harness();
  const result = { textContent: '保留这条译文', hidden: true, dataset: { original: 'source' },
    style: { setProperty(name, value) { this[name] = value; } } };
  LT.YouTubeText.applyResultStyle(result, LT.Settings.normalize({ commentTranslationStyle: 'box', commentTranslationColor: '#123456' }), 'comment');
  assert.equal(result.textContent, '保留这条译文');
  assert.equal(result.hidden, true);
  assert.equal(result.dataset.original, 'source');
  assert.equal(result.dataset.ltStyle, 'box');
  assert.equal(result.style['--lt-text-accent'], '#123456');
});

test('评论读取实际原文内层字色；主题切换更新颜色而不修改已译文字或收起状态', () => {
  const T = harness().YouTubeText;
  const inner = { computedStyle: { color: 'rgb(241, 241, 241)' } };
  const source = { computedStyle: { color: 'rgb(0, 0, 0)' }, querySelector: () => inner };
  const host = { hidden: true, textContent: '保留这条译文',
    style: { setProperty(name, value) { this[name] = value; } } };
  T.applySourceColor(host, source);
  assert.equal(host.style['--lt-yt-source-color'], 'rgb(241, 241, 241)');
  inner.computedStyle.color = 'rgb(15, 15, 15)';
  T.applySourceColor(host, source);
  assert.equal(host.style['--lt-yt-source-color'], 'rgb(15, 15, 15)');
  assert.equal(host.hidden, true);
  assert.equal(host.textContent, '保留这条译文');
});
