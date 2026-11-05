export const TAG_ICON_CHOICES = [
  "🌿", "💧", "🫖", "🍵", "🥗", "🍎", "💊", "💪",
  "😴", "💤", "🌙", "☀️", "🧘", "☯️", "🙏", "🌱",
  "🏃", "🚶", "🧹", "🎙️", "📖", "✍️", "📝", "🧠",
  "🎸", "🎵", "🎨", "🎯", "💡", "⭐", "🔥", "🌊",
];

const hasOwn = (record: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(record, key);

/** The icon shown before a tag; "" means show "#". */
export function tagIcon(tagIcons: Record<string, string>, tag: string): string {
  return hasOwn(tagIcons, tag) ? tagIcons[tag] : "";
}

/**
 * Gives every tag without an icon a stable default, preferring icons no other tag uses.
 * Defaults are meant to be persisted, so adding a tag later never reshuffles existing icons.
 * Returns the same object when nothing is missing.
 */
export function assignTagIcons(tagIcons: Record<string, string>, tags: string[]): Record<string, string> {
  const missing = tags.filter((tag) => !hasOwn(tagIcons, tag));
  if (missing.length === 0) return tagIcons;

  const next = { ...tagIcons };
  const used = new Set(Object.values(tagIcons));
  for (const tag of missing) {
    let hash = 0;
    for (const char of tag) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
    const candidates = TAG_ICON_CHOICES.map((_, step) => TAG_ICON_CHOICES[(hash + step) % TAG_ICON_CHOICES.length]);
    next[tag] = candidates.find((icon) => !used.has(icon)) ?? candidates[0];
    used.add(next[tag]);
  }
  return next;
}
