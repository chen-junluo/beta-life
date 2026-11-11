import MarkdownIt from "markdown-it";
import cjkFriendly from "markdown-it-cjk-friendly";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
  schema as baseSchema,
} from "prosemirror-markdown";
import { Fragment, Schema, Slice, type Node as ProseMirrorNode, type NodeSpec } from "prosemirror-model";

function tightByDefault(name: string): NodeSpec {
  const spec = baseSchema.spec.nodes.get(name)!;
  return { ...spec, attrs: { ...spec.attrs, tight: { default: true } } };
}

/** CommonMark schema whose lists default to tight, so typed lists save as `- a\n- b`, not loose paragraphs. */
export const markdownSchema = new Schema({
  nodes: baseSchema.spec.nodes
    .update("bullet_list", tightByDefault("bullet_list"))
    .update("ordered_list", tightByDefault("ordered_list")),
  marks: baseSchema.spec.marks,
});

/** `diary`: nested lists are indented with tabs, `text\n-` is never a setext heading, empty bullets are not saved. */
export type MarkdownFlavor = "default" | "diary";

// Single newlines in existing plain-text values stay visible line breaks.
// cjkFriendly: `**加粗。**后文` must stay bold; plain CommonMark rejects emphasis closed after CJK punctuation.
const makeParser = (setext: boolean) => {
  const tokenizer = MarkdownIt("commonmark", { html: false }).use(cjkFriendly);
  // A bare `-` under a line (an empty nested bullet) would otherwise turn that line into a heading.
  if (!setext) tokenizer.disable("lheading");
  return new MarkdownParser(markdownSchema, tokenizer, { ...defaultMarkdownParser.tokens, softbreak: { node: "hard_break" } });
};
const parsers: Record<MarkdownFlavor, MarkdownParser> = { default: makeParser(true), diary: makeParser(false) };

type SerializerState = { out: string; inAutolink?: boolean; text: (text: string, escape?: boolean) => void };

/** `\[\[a\_b\]\]` → `[[a_b]]`: Obsidian links, embeds and `~~` are plain text to CommonMark and must stay unescaped. */
function unescapeObsidian(text: string): string {
  return text
    .replace(/\\\[\\\[((?:(?!\\\]\\\]).)*)\\\]\\\]/g, (_, inner: string) => `[[${inner.replace(/\\([`*\\~[\]_])/g, "$1")}]]`)
    .replace(/\\~\\~/g, "~~");
}

const emptyItem = (item: ProseMirrorNode) => item.childCount === 1 && item.firstChild!.isTextblock && item.firstChild!.content.size === 0;

/** `indent` prefixes nested list lines; `keepEmpty: false` leaves out bullets with nothing in them. */
const makeSerializer = (indent: string, keepEmpty: boolean) => new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    bullet_list(state, node) {
      const items: ProseMirrorNode[] = [];
      node.forEach((item) => {
        if (keepEmpty || !emptyItem(item)) items.push(item);
      });
      if (items.length > 0) state.renderList(node.copy(Fragment.from(items)), indent, () => "- ");
    },
    text(state, node) {
      const writer = state as unknown as SerializerState;
      const start = writer.out.length;
      writer.text(node.text ?? "", !writer.inAutolink);
      writer.out = writer.out.slice(0, start) + unescapeObsidian(writer.out.slice(start));
    },
    // A plain newline (instead of `\` + newline) round-trips because the parser reads soft breaks as hard breaks.
    hard_break(state, node, parent, index) {
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write("\n");
          return;
        }
      }
    },
  },
  defaultMarkdownSerializer.marks,
);
const serializers: Record<MarkdownFlavor, MarkdownSerializer> = { default: makeSerializer("  ", true), diary: makeSerializer("\t", false) };

export function parseMarkdown(value: string, flavor: MarkdownFlavor = "default"): ProseMirrorNode {
  return parsers[flavor].parse(value);
}

export function serializeMarkdown(doc: ProseMirrorNode, flavor: MarkdownFlavor = "default"): string {
  return serializers[flavor].serialize(doc);
}

/** Pasted Markdown as a slice: a single paragraph merges inline, anything else lands as blocks. */
export function markdownSlice(text: string, flavor: MarkdownFlavor = "default"): Slice {
  const doc = parseMarkdown(text, flavor);
  const inline = doc.childCount === 1 && doc.firstChild!.type === markdownSchema.nodes.paragraph;
  return new Slice(doc.content, inline ? 1 : 0, inline ? 1 : 0);
}

const renderer = MarkdownIt({ html: false, breaks: true }).use(cjkFriendly);

/** HTML for read-only display; raw HTML in the source is escaped. */
export function renderMarkdown(value: string): string {
  return renderer.render(value);
}
