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
