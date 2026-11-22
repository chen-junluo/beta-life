import type { SocialProposal, SocialEvaluation } from "./socialStorage";
import type { SocialFileKind, SocialQuestionGroup, SocialTurn, SocialVersion } from "./types";

/** The turn waiting for an answer (highlighted); null when every turn is answered. */
export function pendingTurn(turns: SocialTurn[]): number | null {
  const index = turns.findIndex((turn) => !turn.answer.trim());
  return index === -1 ? null : index;
}

/** `6 → 7 → 8`: the averages of a question's scored versions, oldest first. */
export function scoreTrend(group: SocialQuestionGroup): string {
  return group.versions.flatMap((version) => (version.average === null ? [] : [String(version.average)])).join(" → ");
}

/** `261111` → `11-11`. */
export function shortDate(date: string): string {
  return date.length === 6 ? `${date.slice(2, 4)}-${date.slice(4, 6)}` : date;
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
