export function splitTags(value: string): string[] {
  return value
    .split(/[,，;；/\n]+/)
    .map((tag) => tag.trim().replace(/^#+/, ""))
    .filter(Boolean);
}

/** How many values use each tag, most used first. */
export function tagUsage(values: string[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  values.forEach((value) => new Set(splitTags(value)).forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)));
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((left, right) => right.count - left.count);
}

/** Known tags sorted by how often they are used, most frequent first. */
export function collectTags(values: string[]): string[] {
  return tagUsage(values).map(({ tag }) => tag);
}
