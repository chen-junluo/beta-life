export type SimpleMarkdownBlock =
  | { kind: "text"; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "unordered-list"; items: string[] }
  | { kind: "ordered-list"; items: string[] };

export function parseSimpleMarkdown(value: string): SimpleMarkdownBlock[] {
  const blocks: SimpleMarkdownBlock[] = [];

  for (const rawLine of value.trim().split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const kind = unordered ? "unordered-list" : ordered ? "ordered-list" : "text";
    const content = unordered?.[1] ?? ordered?.[1] ?? line.trimStart();
    const previous = blocks.at(-1);

    if (kind === "text") {
      if (previous?.kind === "text") previous.lines.push(content);
      else blocks.push({ kind, lines: [content] });
    } else if (previous?.kind === kind) {
      previous.items.push(content);
    } else {
      blocks.push({ kind, items: [content] });
    }
  }

  return blocks;
}

export function splitTags(value: string): string[] {
  return value
    .split(/[,，;；/\n]+/)
    .map((tag) => tag.trim().replace(/^#+/, ""))
    .filter(Boolean);
}

function splitTagDraft(value: string): { committed: string; query: string } {
  const [, committed = "", draft] = value.match(/^([\s\S]*[,，;；/\n])?([\s\S]*)$/)!;
  return { committed, query: draft.trim().replace(/^#+/, "") };
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

/** Known tags matching the tag being typed (the text after the last separator). */
export function suggestTags(value: string, knownTags: string[], limit = 6): string[] {
  const { committed, query } = splitTagDraft(value);
  const used = new Set(splitTags(committed));
  const needle = query.toLowerCase();
  return knownTags
    .filter((tag) => !used.has(tag) && tag.toLowerCase().includes(needle))
    .slice(0, limit);
}

/** Replaces the tag being typed with the chosen tag and leaves a separator for the next one. */
export function applyTagSuggestion(value: string, tag: string): string {
  const { committed } = splitTagDraft(value);
  return `${committed}${/[,;]$/.test(committed) ? " " : ""}${tag}, `;
}
