/**
 * core/see-command.js — /see 视觉隔离指令的单一事实来源。
 *
 * /see 是一个"只改本轮 Prompt 渲染方式、不产生独立回复"的显式指令：
 *   - 无论全局 context.directMediaParts 是 true 还是 false，命中后一律禁止把图片
 *     挂成 image_url 多模态 part；
 *   - 图片改以纯文本形式给出本地绝对路径 + 归属说明牌，并在 Prompt 末尾追加一条
 *     强指令（SEE_MODE_NOTICE），要求模型必须调本地识图工具读取路径后分析打标。
 *
 * 命中口径（消息解析层）：
 *   - 本条消息正文以 /see 开头（可带名字呼唤前缀，如 "瑞姬 /see 这张图"、"/see"），
 *     /see 后必须是空白或行尾，"/seems" 这类词不算；
 *   - 或引用消息的正文里带 /see（兼容"引用一条写着 /see 的消息"）；
 *   - 或防抖合并批次里任意一条以 /see 开头。
 *
 * 这与 command-flow 的关系：/see 在 command-registry.js 里登记为 forward 命令，
 * 只用于让 command-flow 放行（不再把未知斜杠指令当越权拦截），本身不产生回复。
 */

/** 指令 token；命令注册表与提示词都用它，避免两处写死不同拼写。 */
export const SEE_COMMAND = '/see';

/**
 * 命中 /see 时追加在 Prompt 末尾的强指令。
 *
 * 工具名用实测存在的 `vision_analyze`（Hermes 原生识图工具，见 hermes-agent
 * tools/vision_tools.py）；需求草稿里的 analyze_image 是同一能力的旧称，写错名字
 * 会让模型调一个不存在的工具，所以这里只写实际工具名。
 */
export const SEE_MODE_NOTICE = Object.freeze(
  '【/see 专用识图指令已生效】本轮图片已隔离出主上下文防范内容审查。请必须调用本地 MCP vision_analyze 图片分析工具读取指定路径进行深度分析与打标，严禁凭空臆测。',
);

/** 本条正文以 /see 开头（后接空白或行尾），大小写不敏感 */
const OWN_SEE_RE = /^\/see(?:\s|$)/i;

/**
 * 引用正文里的 /see：要求前面是行首/空白/括号/冒号，后面不是标识符字符，
 * 避免把 "/seems"、"路径/a/see/x" 这类内容误判成指令。
 */
const QUOTE_SEE_RE = /(?:^|[\s[（(【:：])\/see(?![A-Za-z0-9_-])/i;

/** 剥掉开头的名字呼唤/对机器人 @ 前缀（@ 码已被 stripCqCodes 拆走，只剩名字） */
function stripLeadingBotName(text, botName) {
  const name = String(botName ?? '').trim();
  if (!name) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^(?:@?${escaped})[\\s，,。.!！?？~、；;:：]*`), '');
}

/** 本条消息自己的正文：text（已剔 CQ 码）优先，空则退 content */
function ownTextOf(inbound) {
  return String(inbound?.text ?? '').trim() || String(inbound?.content ?? '').trim();
}

/**
 * 本轮消息是否命中 /see 指令。
 *
 * @param {object} inbound InboundMessage（或等价的部分对象）
 * @param {{ botName?: string }} [opts] identity.botName，用于剥离名字呼唤前缀
 * @returns {boolean}
 */
export function isSeeCommand(inbound, { botName } = {}) {
  if (!inbound) return false;

  const own = stripLeadingBotName(ownTextOf(inbound), botName).trim();
  if (OWN_SEE_RE.test(own)) return true;

  const quote = inbound.extensions?.quote?.summary;
  if (quote && QUOTE_SEE_RE.test(String(quote))) return true;

  const batch = inbound.extensions?.batch;
  if (Array.isArray(batch)) {
    for (const item of batch) {
      const content = stripLeadingBotName(String(item?.content ?? ''), botName).trim();
      if (OWN_SEE_RE.test(content)) return true;
    }
  }

  return false;
}
