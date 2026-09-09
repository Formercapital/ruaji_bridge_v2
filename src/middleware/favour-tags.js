const FAVOUR_TAGS = [
  /\s*[\[［]\s*好[^\u4e00-\u9fff]{0,2}感[^\u4e00-\u9fff]{0,2}度\s*(?:上升|降低)\s*[:：]\s*\d+\s*[\]］]\s*/gi,
  /\s*[\[［]\s*好[^\u4e00-\u9fff]{0,2}感[^\u4e00-\u9fff]{0,2}度\s*持平\s*[\]］]\s*/gi,
  /\s*[\[［]\s*(?:主动确认关系|主动解除关系|用户申请确认关系)\s*[:：][^\]］]*[\]］]\s*/gi,
  /\s*[\[［]\s*Favour\s+(?:increased|decreased|unchanged|no\s*change)\b[^\]］]*[\]］]\s*/gi,
  /\s*\[AFF:[^\]]*\]\s*/gi,
];

export function stripFavourTags(text) {
  let value = String(text ?? '');
  for (const pattern of FAVOUR_TAGS) value = value.replace(pattern, '');
  return value.trim();
}

export function createFavourTagsMiddleware() {
  return {
    name: 'favour-tags',
    async process(ctx, next) {
      ctx.text = stripFavourTags(ctx.text);
      return next(ctx);
    },
  };
}
