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

/** Renames `QA记录/<id>.md`; returns the name actually used (` 2` when taken). */
export const renameSocialVersion = (role: string, id: string, name: string) => invoke<string>("rename_social_version", { role, id, name });

export const loadSocialVersion = (role: string, id: string) => invoke<SocialVersion>("load_social_version", { role, id });
/**
 * A new version for today. With a `question` the file is `<topic><YYMMDD>`; without one it is a blank
 * `YYMMDD` holding nothing but an empty `Q：`/`A：`. Both get `-2`, `-3`… when the day already has one.
 */
export const newSocialVersion = (role: string, question = "", topic = "") =>
  invoke<SocialVersion>("new_social_version", { request: { role, question, topic } });

export function saveSocialVersion(role: string, version: SocialVersion): Promise<SocialVersion> {
  const { id, context, turns, evaluation, status, starred } = version;
  return invoke<SocialVersion>("save_social_version", { request: { role, id, context, turns, evaluation, status, starred } });
}

// ---------- AI buttons (Rust `social_ai`) ----------

export const aiSocialQuestions = (role: string, context: string, turns: SocialTurn[], mode: "new" | "follow", exclude: string[] = []) =>
  invoke<string[]>("ai_social_questions", { request: { role, context, turns, mode, exclude } });
export const aiSocialAnswer = (role: string, context: string, turns: SocialTurn[]) => invoke<string>("ai_social_answer", { request: { role, context, turns } });

export interface SocialAiScore {
  score: number;
  comment: string;
  /** An improved answer, only below 7. */
  better?: string;
}

export const aiSocialScore = (role: string, context: string, turns: SocialTurn[], index: number) =>
  invoke<SocialAiScore>("ai_social_score", { request: { role, context, turns, index } });

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

export const aiSocialEvaluate = (role: string, context: string, turns: SocialTurn[]) => invoke<SocialEvaluation>("ai_social_evaluate", { request: { role, context, turns } });

// ---------- undo ----------

/** A version or one of the two md files before or after a change. */
export type SocialSnapshot =
  | { kind: "version"; role: string; version: SocialVersion }
  | { kind: "file"; role: string; file: SocialFileKind; body: string };

/** Writes a snapshot back over whatever the file holds now (undo / redo). */
export async function restoreSocialSnapshot(snapshot: SocialSnapshot): Promise<void> {
  if (snapshot.kind === "version") {
    await saveSocialVersion(snapshot.role, snapshot.version);
    return;
  }
  const current = await loadSocialFile(snapshot.role, snapshot.file);
  await saveSocialFile({ role: snapshot.role, kind: snapshot.file, base: current, body: snapshot.body, force: true });
}
