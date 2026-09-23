/** Single source of truth for chat commands, aliases, dispatch and authorization.
 * New entries are owner-only unless adminGrantable/memberAllowed is explicit.
 */
const definitions = [
  { id: '/new', aliases: ['/new', '///new', '////new', '#new'], handler: '_resetSession' },
  { id: '/model', aliases: ['/model', '///model'], arguments: true, handler: '_modelCommand' },
  { id: '/approve', aliases: ['/approve', '/approval', '/deny', '/reject'], arguments: true, forward: true },
  // /see：不是独立命令，而是"本轮图片隔离出主上下文"的渲染修饰符。forward 放行
  // 给模型，memberAllowed 让非主人也能用（纯渲染开关，无越权面）。命中判定在
  // core/see-command.js，渲染在 orchestration/prompt-renderer.js。
  { id: '/see', aliases: ['/see'], arguments: true, forward: true, adminGrantable: true, memberAllowed: true },
  { id: '/stop', aliases: ['/stop', '#stop', '/停下'], handler: '_stopGeneration', adminGrantable: true },
  { id: '/好感度', aliases: ['/好感', '/好感度', '/affection'], arguments: true, handler: '_affectionStats', favour: true, adminGrantable: true, memberAllowed: true },
  { id: '/查看画像', aliases: ['/查看画像', '/画像详情'], arguments: true, handler: '_viewPortrayal', adminGrantable: true, memberAllowed: true },
  ...[['/正画像', 'positive'], ['/负画像', 'negative'], ['/克隆人格', 'clone', '/克隆'], ['/找对象', 'match', '/match'], ['/画像', 'portrait', '/portrayal']].map(([id, template, alias]) => ({
    id, aliases: alias ? [id, alias] : [id], arguments: true, handler: '_generatePortrayal', template, adminGrantable: true, memberAllowed: true,
  })),
  { id: '/取消冷暴力', aliases: ['/取消冷暴力', '/解除冷暴力', '/unfreeze'], arguments: true, handler: '_liftColdViolenceCommand', favour: true, adminGrantable: true },
  { id: '/冷暴力', aliases: ['/冷暴力', '/freeze'], arguments: true, handler: '_triggerColdViolenceCommand', favour: true, adminGrantable: true },
  { id: '/收集表情', aliases: ['/收集', '/收集表情', '/collect'], arguments: true, handler: '_startCollect', adminGrantable: true, memberAllowed: true },
  { id: '/完成收集', aliases: ['/完成收集', '/退出收集', '/stop_collect', '/done'], handler: '_stopCollect', adminGrantable: true, memberAllowed: true },
];
export const COMMANDS = Object.freeze(definitions.map((entry) => Object.freeze({ ...entry, aliases: Object.freeze(entry.aliases) })));
export function findCommand(text) {
  return COMMANDS.find((entry) => entry.aliases.some((alias) => text === alias ||
    (entry.arguments && text.startsWith(alias) && /^\s/.test(text.slice(alias.length))))) ?? null;
}
export function commandCatalog() {
  return COMMANDS.map(({ id, aliases, adminGrantable = false, memberAllowed = false }) => ({ id, aliases, adminGrantable, memberAllowed }));
}
export function normalizeAdminCommands(value) {
  return Array.isArray(value) ? [...new Set(value.filter((id) => COMMANDS.some((c) => c.id === id && c.adminGrantable === true)))] : [];
}
