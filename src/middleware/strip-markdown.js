/**
 * middleware/strip-markdown.js — 脱 Markdown
 *
 * 逐条迁移自 bridge.js:462-536，正则一字不改。QQ 不渲染 Markdown，
 * 模型输出的 **加粗**、### 标题、``` 代码块直接推过去就是一堆生硬符号。
 *
 * 占位符保护是这里最容易出错的地方：
 *   - CQ 码占位符必须是纯字母数字。用下划线会被后面的 __text__ 斜体规则吃掉，
 *     旧实现踩过这个坑，注释里专门写了 "Keep placeholders strictly alphanumeric"
 *   - 表情包标记里的 ID 形如 m_1787266663929_161，同理必须先存起来
 */

/** 未还原的占位符泄漏到 QQ 是严重问题，检测到就拦截 */
const LEAKED_PLACEHOLDER = /CQCODEHOLD\d+|__CQ_CODE_HOLD_\d+__/;

export function stripMarkdown(text, { onLeak } = {}) {
  if (!text) return text;
  let str = String(text);

  if (LEAKED_PLACEHOLDER.test(str)) {
    onLeak?.(str.slice(0, 160));
    str = str.replace(/CQCODEHOLD\d+|__CQ_CODE_HOLD_\d+__/g, '');
  }

  // 兼容全角冒号的表情标记，统一交给 meme 中间件解析
  str = str.replace(/\[(表情|meme)\s*：/gi, '[$1:');

  // 1. 保护真实 CQ 码
  const cqCodes = [];
  str = str.replace(/\[CQ:[^\]]+\]/g, (match) => {
    cqCodes.push(match);
    return `CQCODEHOLD${cqCodes.length - 1}X`;
  });

  // 2. 保护表情包标记（ID 含下划线，必须先于所有 Markdown 规则存起来）
  const memeMarkers = [];
  str = str.replace(/&&meme:[^&\s]+&&|\[(?:表情|meme)\s*:\s*[^\]<>\s]+\]/gi, (match) => {
    memeMarkers.push(match);
    return `MEMEHOLD${memeMarkers.length - 1}X`;
  });

  // 3. 代码块三反引号与行内代码（保留内部文本，并去除所有反引号）
  str = str.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1');
  str = str.replace(/`([^`\n]+)`/g, '$1');
  str = str.replace(/`/g, '');

  // 4. 标题 -> 【标题】
  str = str.replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, title) => {
    const cleanTitle = title.replace(/\*\*(.*?)\*\*/g, '$1').trim();
    return `【${cleanTitle}】`;
  });

  // 5. 分割线（--- 或 ***，不匹配下划线）
  str = str.replace(/^[ \t]*[-*]{3,}[ \t]*$/gm, '');

  // 6. 加粗与斜体（仅处理星号与删除线；绝不清理下划线 _，避免破坏代码变量与脚本名）
  str = str.replace(/\*\*\*(.*?)\*\*\*/g, '$1');
  str = str.replace(/\*\*(.*?)\*\*/g, '$1');
  str = str.replace(/\*([^*\n]+)\*/g, '$1');
  str = str.replace(/~~(.*?)~~/g, '$1');
  // 清理因分段切句或未闭合而残留的孤立加粗标记 **
  str = str.replace(/\*\*/g, '');

  // 7. 引用符号
  str = str.replace(/^[ \t]*>[ \t]?/gm, '');

  // 8. 无序列表 -> ·
  str = str.replace(/^[ \t]*[-*+][ \t]+/gm, '· ');

  // 9. 超链接
  str = str.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)');
  str = str.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 10. 连续换行最多保留 2 个
  str = str.replace(/\n{3,}/g, '\n\n');

  // 还原
  cqCodes.forEach((cq, idx) => {
    str = str.replace(`CQCODEHOLD${idx}X`, cq);
  });
  memeMarkers.forEach((marker, idx) => {
    str = str.replace(`MEMEHOLD${idx}X`, marker);
  });

  return str.trim();
}

export function createStripMarkdownMiddleware({ logger } = {}) {
  const log = logger?.child({ component: 'mw:strip-markdown' }) ?? console;
  return {
    name: 'strip-markdown',
    async process(ctx, next) {
      ctx.text = stripMarkdown(ctx.text, {
        onLeak: (sample) => log.error?.('检测到未还原的 CQ 占位符，已清除', { sample }),
      });
      return next(ctx);
    },
  };
}
