import { baseKeymap, chainCommands, exitCode, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { InputRule, inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { MarkType } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { EditorState, Selection, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import "prosemirror-view/style/prosemirror.css";
import { useEffect, useRef, type MouseEvent } from "react";
import { markdownSchema, markdownSlice, parseMarkdown, renderMarkdown, serializeMarkdown, type MarkdownFlavor } from "../markdown";

const { nodes, marks } = markdownSchema;

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  /** Minimum height in text lines, like a textarea's `rows`. */
  rows?: number;
  /** `"end"` puts the cursor at the end, e.g. under a pre-filled template. */
  autoFocus?: boolean | "end";
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  onBlur?: () => void;
  /** Cmd/Ctrl+Enter, e.g. to submit a composer. */
  onModEnter?: () => void;
  /** `diary`: tab-indented lists, no setext headings, empty bullets not saved. */
  flavor?: MarkdownFlavor;
}

/** `**a**` → bold, `*a*` → italic, `` `a` `` → code, while typing. */
function markRule(pattern: RegExp, type: MarkType) {
  return new InputRule(pattern, (state, match, start, end) => {
    const text = match[1];
    return state.tr
      .insertText(text, start, end)
      .addMark(start, start + text.length, type.create())
      .removeStoredMark(type);
  });
}

const insertHardBreak: Command = (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
  return true;
};

function createState(value: string, onModEnter: () => boolean, flavor?: MarkdownFlavor) {
  return EditorState.create({
    doc: parseMarkdown(value, flavor),
    plugins: [
      inputRules({
        rules: [
          wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
          wrappingInputRule(
            /^(\d+)\.\s$/,
            nodes.ordered_list,
            (match) => ({ order: Number(match[1]) }),
            (match, node) => node.childCount + node.attrs.order === Number(match[1]),
          ),
          wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
          textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({ level: match[1].length })),
          textblockTypeInputRule(/^```$/, nodes.code_block),
          markRule(/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, marks.strong),
          markRule(/__([^_\s](?:[^_]*[^_\s])?)__$/, marks.strong),
          markRule(/(?<![*\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, marks.em),
          markRule(/(?<![_\w])_([^_\s](?:[^_]*[^_\s])?)_$/, marks.em),
          markRule(/`([^`]+)`$/, marks.code),
        ],
      }),
      history(),
      keymap({
        "Mod-z": undo,
        "Shift-Mod-z": redo,
        "Mod-y": redo,
        Backspace: undoInputRule,
        "Mod-b": toggleMark(marks.strong),
        "Ctrl-b": toggleMark(marks.strong),
        "Mod-i": toggleMark(marks.em),
        "Ctrl-i": toggleMark(marks.em),
        "Mod-e": toggleMark(marks.code),
        Enter: splitListItem(nodes.list_item),
        "Shift-Enter": chainCommands(exitCode, insertHardBreak),
        "Mod-Enter": onModEnter,
        Tab: sinkListItem(nodes.list_item),
        "Shift-Tab": liftListItem(nodes.list_item),
      }),
      keymap(baseKeymap),
    ],
  });
}

function isEmpty(state: EditorState) {
  const { doc } = state;
  return doc.childCount === 1 && doc.firstChild!.isTextblock && doc.firstChild!.content.size === 0;
}

/**
 * Live-rendered Markdown field (Typora-style) that reads and writes a Markdown string.
 * Unedited values are never re-serialized, so opening a record does not rewrite it.
 */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const emitted = useRef(props.value);

  useEffect(() => {
    const onModEnter = () => {
      latest.current.onModEnter?.();
      return Boolean(latest.current.onModEnter);
    };
    const editor: EditorView = new EditorView(
      { mount: host.current! },
      {
        state: createState(latest.current.value, onModEnter, latest.current.flavor),
        editable: () => !latest.current.disabled,
        attributes: (state) => {
          const { className, placeholder, id, disabled } = latest.current;
          return {
            class: `md-editor ${className ?? ""}`.trim(),
            role: "textbox",
            "aria-multiline": "true",
            ...(latest.current["aria-label"] ? { "aria-label": latest.current["aria-label"] } : {}),
            ...(id ? { id } : {}),
            ...(disabled ? { "aria-disabled": "true" } : {}),
            ...(placeholder ? { "data-placeholder": placeholder } : {}),
            ...(isEmpty(state) ? { "data-empty": "true" } : {}),
          };
        },
        dispatchTransaction(tr) {
          editor.updateState(editor.state.apply(tr));
          if (!tr.docChanged) return;
          emitted.current = serializeMarkdown(editor.state.doc, latest.current.flavor);
          latest.current.onChange(emitted.current);
        },
        // Prefer the plain-text flavour so Markdown copied from editors, chats or files renders as Markdown.
        handlePaste(current, event) {
          const text = event.clipboardData?.getData("text/plain");
          if (!text || current.state.selection.$from.parent.type.spec.code) return false;
          current.dispatch(current.state.tr.replaceSelection(markdownSlice(text, latest.current.flavor)).scrollIntoView().setMeta("paste", true));
          return true;
        },
        clipboardTextSerializer: (slice) => serializeMarkdown(markdownSchema.topNodeType.create(null, slice.content), latest.current.flavor),
        handleDOMEvents: {
          blur: () => {
            latest.current.onBlur?.();
            return false;
          },
        },
      },
    );
    view.current = editor;
    if (latest.current.autoFocus === "end") editor.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)));
    if (latest.current.autoFocus) editor.focus();
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  // Values set from outside (AI fill, reset, switching records) replace the document.
  useEffect(() => {
    const editor = view.current;
    if (!editor || props.value === emitted.current) return;
    emitted.current = props.value;
    editor.updateState(EditorState.create({ doc: parseMarkdown(props.value, latest.current.flavor), plugins: editor.state.plugins }));
  }, [props.value]);

  useEffect(() => {
    view.current?.setProps({});
  }, [props.className, props.placeholder, props.disabled, props.id, props["aria-label"]]);

  return <div ref={host} style={props.rows ? { minHeight: `calc(${props.rows}lh + 24px)` } : undefined} />;
}

/** Read-only rendering of a stored Markdown value; links never navigate the app window. */
export function MarkdownContent({ value, className }: { value: string; className?: string }) {
  function blockLinks(event: MouseEvent) {
    if ((event.target as HTMLElement).closest("a")) event.preventDefault();
  }
  return (
    <div
      className={`md-content ${className ?? ""}`.trim()}
      onClick={blockLinks}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }}
    />
  );
}
