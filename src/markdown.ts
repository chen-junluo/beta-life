import MarkdownIt from "markdown-it";
import cjkFriendly from "markdown-it-cjk-friendly";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
  schema as baseSchema,
} from "prosemirror-markdown";
import { Schema, Slice, type Node as ProseMirrorNode, type NodeSpec } from "prosemirror-model";

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

// Single newlines in existing plain-text values stay visible line breaks.
// cjkFriendly: `**加粗。**后文` must stay bold; plain CommonMark rejects emphasis closed after CJK punctuation.
const parser = new MarkdownParser(markdownSchema, MarkdownIt("commonmark", { html: false }).use(cjkFriendly), {
  ...defaultMarkdownParser.tokens,
  softbreak: { node: "hard_break" },
});

const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    bullet_list(state, node) {
      state.renderList(node, "  ", () => "- ");
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

export function parseMarkdown(value: string): ProseMirrorNode {
  return parser.parse(value);
}

export function serializeMarkdown(doc: ProseMirrorNode): string {
  return serializer.serialize(doc);
}

/** Pasted Markdown as a slice: a single paragraph merges inline, anything else lands as blocks. */
export function markdownSlice(text: string): Slice {
  const doc = parseMarkdown(text);
  const inline = doc.childCount === 1 && doc.firstChild!.type === markdownSchema.nodes.paragraph;
  return new Slice(doc.content, inline ? 1 : 0, inline ? 1 : 0);
}

const renderer = MarkdownIt({ html: false, breaks: true }).use(cjkFriendly);

/** HTML for read-only display; raw HTML in the source is escaped. */
export function renderMarkdown(value: string): string {
  return renderer.render(value);
}
