import { invoke } from "@tauri-apps/api/core";
import type { SocialFileKind, SocialRole, SocialTurn, SocialVersion } from "./types";

export const SOCIAL_FILE_NAMES: Record<SocialFileKind, string> = { role: "角色设定.md", playbook: "应对与正样本.md" };

export const listSocialRoles = () => invoke<SocialRole[]>("list_social_roles");
export const newSocialRole = (name: string) => invoke<string>("new_social_role", { name });
export const renameSocialRole = (role: string, name: string) => invoke<string>("rename_social_role", { role, name });
/** Without `id` the whole role folder goes to `社交模拟器/.beta-life/trash/`. */
export const trashSocial = (role: string, id?: string) => invoke<void>("trash_social", { role, id: id ?? null });

export const loadSocialFile = async (role: string, kind: SocialFileKind) => (await invoke<{ body: string }>("load_social_file", { role, kind })).body;

export type SocialFileOutcome = { status: "saved" } | { status: "conflict"; current: string };

export interface SocialFileSave {
  role: string;
  kind: SocialFileKind;
  /** The text as last read; a different file on disk is a conflict unless `force`. */
  base: string;
  body: string;
  force?: boolean;
}

export const saveSocialFile = (request: SocialFileSave) => invoke<SocialFileOutcome>("save_social_file", { request: { force: false, ...request } });

/** Appends to `## 可能会问的问题`; false when it was already there. */
export const addSocialQuestion = (role: string, question: string) => invoke<boolean>("add_social_question", { role, question });

export const loadSocialVersion = (role: string, id: string) => invoke<SocialVersion>("load_social_version", { role, id });
/** A new version of `question` for today: `<topic><YYMMDD>`, `-2` when today already has one. */
export const newSocialVersion = (role: string, question: string, topic: string) =>
  invoke<SocialVersion>("new_social_version", { request: { role, question, topic } });
export const setSocialStar = (role: string, id: string, starred: boolean) => invoke<void>("set_social_star", { role, id, starred });

export function saveSocialVersion(role: string, version: SocialVersion): Promise<SocialVersion> {
  const { id, turns, evaluation, status } = version;
  return invoke<SocialVersion>("save_social_version", { request: { role, id, turns, evaluation, status } });
}

// ---------- AI buttons (Rust `social_ai`) ----------

export const aiSocialQuestions = (role: string, turns: SocialTurn[], mode: "new" | "follow", exclude: string[] = []) =>
  invoke<string[]>("ai_social_questions", { request: { role, turns, mode, exclude } });
export const aiSocialAnswer = (role: string, turns: SocialTurn[]) => invoke<string>("ai_social_answer", { request: { role, turns } });

export interface SocialAiScore {
  score: number;
  comment: string;
  /** An improved answer, only below 7. */
  better?: string;
}

export const aiSocialScore = (role: string, turns: SocialTurn[], index: number) =>
  invoke<SocialAiScore>("ai_social_score", { request: { role, turns, index } });

/** `sample` / `principle` → 应对与正样本.md, `trait` → 角色设定.md. */
export interface SocialProposal {
  kind: "sample" | "principle" | "trait";
  text: string;
}

export interface SocialEvaluation {
  /** One per answered turn, in order. */
  scores: SocialAiScore[];
  directions: string[];
  proposals: SocialProposal[];
}

export const aiSocialEvaluate = (role: string, turns: SocialTurn[]) => invoke<SocialEvaluation>("ai_social_evaluate", { request: { role, turns } });
