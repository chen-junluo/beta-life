import { EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { markdownSchema, markdownSlice, parseMarkdown, renderMarkdown, serializeMarkdown } from "./markdown";

const roundTrip = (value: string) => serializeMarkdown(parseMarkdown(value));

describe("markdown round trip", () => {
  it("keeps common habit and note formats unchanged", () => {
    for (const value of [
      "听息/静坐+AI信息输入习惯+听AI访谈（5-10分钟）",
      "提醒\n\n- 喝水\n- 拉伸\n\n1. 记录\n2. 复盘",
      "操作：坐在椅子上。\n\n命理意义：**下午**是人最容易疲惫的时候。",
      "## 核心概念\n\n> 引用一段话\n\n```\ncode_block()\n```",
      "- 外层\n  - 内层\n- *斜体* 和 `code`",
    ]) {
      expect(roundTrip(value)).toBe(value);
    }
  });

  it("keeps bold that ends in Chinese punctuation", () => {
    const value = "**只做一件事：听呼吸。**不用刻意";
    expect(parseMarkdown(value).textContent).toBe("只做一件事：听呼吸。不用刻意");
    expect(roundTrip(value)).toBe(value);
    expect(renderMarkdown(value)).toContain("<strong>只做一件事：听呼吸。</strong>不用刻意");
  });

  it("keeps single line breaks from plain-text values", () => {
    expect(roundTrip("第一行\n第二行")).toBe("第一行\n第二行");
  });

  it("writes typed lists tight with dash bullets", () => {
    const { bullet_list, list_item, paragraph } = markdownSchema.nodes;
    const doc = markdownSchema.node("doc", null, [
      bullet_list.create(null, [
        list_item.create(null, paragraph.create(null, markdownSchema.text("一"))),
        list_item.create(null, paragraph.create(null, markdownSchema.text("二"))),
      ]),
    ]);
    expect(serializeMarkdown(doc)).toBe("- 一\n- 二");
  });
});

describe("markdownSlice", () => {
  function paste(initial: string, text: string) {
    const state = EditorState.create({ doc: parseMarkdown(initial) });
    const end = TextSelection.atEnd(state.doc);
    const withCursor = state.apply(state.tr.setSelection(end));
    return serializeMarkdown(withCursor.apply(withCursor.tr.replaceSelection(markdownSlice(text))).doc);
  }

  it("merges a pasted sentence into the current paragraph", () => {
    expect(paste("开头", "，**加粗**结尾")).toBe("开头，**加粗**结尾");
  });

  it("keeps pasted lists as lists", () => {
    expect(paste("", "- 第一步\n- 第二步")).toBe("- 第一步\n- 第二步");
    expect(paste("说明", "1. 甲\n2. 乙")).toContain("1. 甲\n2. 乙");
  });
});

describe("renderMarkdown", () => {
  it("renders inline marks and escapes raw HTML", () => {
    expect(renderMarkdown("**粗** <b>x</b>")).toBe("<p><strong>粗</strong> &lt;b&gt;x&lt;/b&gt;</p>\n");
  });
});
