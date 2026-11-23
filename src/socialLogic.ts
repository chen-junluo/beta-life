import type { SocialProposal, SocialEvaluation } from "./socialStorage";
import type { SocialFileKind, SocialQuestionGroup, SocialTurn, SocialVersion } from "./types";

/**
 * The turn waiting for an answer (highlighted); null when every turn is answered. A turn whose
 * question is still blank is not waiting for an answer yet — it is waiting for the question.
 */
export function pendingTurn(turns: SocialTurn[]): number | null {
  const index = turns.findIndex((turn) => turn.question.trim() && !turn.answer.trim());
  return index === -1 ? null : index;
}

/**
 * A question goes into the first turn while its question is still blank (the blank version a new
 * version opens with), otherwise it appends a new turn.
 */
export function withQuestion(turns: SocialTurn[], question: string): SocialTurn[] {
  if (turns.length > 0 && !turns[0].question.trim()) {
    return [{ ...turns[0], question }, ...turns.slice(1)];
  }
  return [...turns, { question, answer: "", score: null }];
}

/**
 * A version id is `<tag><YYMMDD>` with an optional `-2`. `进度询问261111-2` →
 * `{ tag: "进度询问", suffix: "261111-2" }`; an id with no date is all tag, no suffix.
 */
export function splitId(id: string): { tag: string; suffix: string } {
  const match = /^(.*?)(\d{6}(?:-\d+)?)$/.exec(id);
  return match ? { tag: match[1].trim(), suffix: match[2] } : { tag: id.trim(), suffix: "" };
}

export const tagOf = (id: string) => splitId(id).tag;

/** `6 → 7 → 8`: the averages of a question's scored versions, oldest first. */
export function scoreTrend(group: SocialQuestionGroup): string {
  return group.versions.flatMap((version) => (version.average === null ? [] : [String(version.average)])).join(" → ");
}

const PROPOSAL_HEADINGS: Record<SocialProposal["kind"], string> = { sample: "## 正样本", principle: "## 原则", trait: "## 性格" };

export const proposalFile = (kind: SocialProposal["kind"]): SocialFileKind => (kind === "trait" ? "role" : "playbook");

/**
 * Appends `lines` at the end of the `heading` section (before the next `## `), or adds the section
 * at the end. Text outside that section is kept as is.
 */
export function appendUnderHeading(text: string, heading: string, block: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) return `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${heading}\n${block}\n`;
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  let last = end;
  while (last > start + 1 && !lines[last - 1].trim()) last -= 1;
  const head = lines.slice(0, last);
  const tail = lines.slice(end);
  if (!tail.length) return `${[...head, block].join("\n")}\n`;
  return [...head, block, "", ...tail].join("\n");
}

/** A proposal as it goes into the file: samples keep their `Q：`/`A：` lines and get the source version. */
export function proposalBlock(proposal: SocialProposal, source: string): string {
  if (proposal.kind === "sample") return `${proposal.text.trim()}\n- 来源：[[${source}]]`;
  return proposal.text.trim().startsWith("- ") ? proposal.text.trim() : `- ${proposal.text.trim()}`;
}

/** The checked proposals for one file, applied in order. */
export function applyProposals(text: string, proposals: SocialProposal[], source: string): string {
  return proposals.reduce((current, proposal) => appendUnderHeading(current, PROPOSAL_HEADINGS[proposal.kind], proposalBlock(proposal, source)), text);
}

/** Scores onto the answered turns (in order), directions into `## 评估`, status done. Re-evaluating overwrites. */
export function withEvaluation(version: SocialVersion, evaluation: SocialEvaluation): SocialVersion {
  let next = 0;
  const turns = version.turns.map((turn) => {
    if (!turn.answer.trim()) return turn;
    const score = evaluation.scores[next++];
    return score ? { ...turn, score: { score: score.score, comment: score.comment } } : turn;
  });
  return { ...version, turns, evaluation: evaluation.directions.map((text) => `- ${text}`).join("\n"), status: "done" };
}
