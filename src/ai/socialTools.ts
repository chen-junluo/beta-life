import { listSocialRoles, loadSocialFile, loadSocialVersion, newSocialRole, saveSocialFile, saveSocialVersion, SOCIAL_FILE_NAMES, type SocialSnapshot } from "../socialStorage";
import type { SocialFileKind, SocialRole, SocialTurn, SocialVersion } from "../types";
import type { AiChange, ChangeKind } from "./types";

type ChangeInput = Pick<AiChange, "name" | "arguments">;
type Failure = { changeId: string; reason: string };

const text = (value: unknown) => (typeof value === "string" ? value : "");
const short = (value: string, length = 48) => (value.length > length ? `${value.slice(0, length)}…` : value);
const firstLine = (value: string) => value.split("\n").map((line) => line.replace(/^\s*(?:#+|[-*+])?\s*/, "").trim()).find(Boolean) ?? "";

/** What the model sees without a tool call: roles, their scene and versions by question. */
export function socialIndex(roles: SocialRole[]) {
  return {
    roles: roles.map((role) => ({
      name: role.name,
      scene: role.scene,
      questions: role.questions.map((group) => ({ question: group.question, versions: group.versions.map((version) => version.id) })),
    })),
  };
}

export const loadSocialData = () => listSocialRoles();

function findRole(roles: SocialRole[], name: unknown): SocialRole {
  const role = roles.find((item) => item.name === String(name ?? "").trim());
  if (!role) throw new Error(`No role "${String(name)}" in the social index`);
  return role;
}

export async function readSocialRole(roles: SocialRole[], name: unknown) {
  const role = findRole(roles, name);
  const [roleText, playbook] = await Promise.all([loadSocialFile(role.name, "role"), loadSocialFile(role.name, "playbook")]);
  const versions = role.questions.flatMap((group) => group.versions.map((version) => ({ id: version.id, question: group.question, status: version.status, average: version.average })));
  return { name: role.name, [SOCIAL_FILE_NAMES.role]: roleText, [SOCIAL_FILE_NAMES.playbook]: playbook, versions };
}

export async function readSocialVersions(roles: SocialRole[], name: unknown, ids: unknown) {
  const role = findRole(roles, name);
  const list = Array.isArray(ids) ? ids.map(String) : [];
  return {
    items: await Promise.all(list.map(async (id) => {
      try {
        const { id: _id, ...version } = await loadSocialVersion(role.name, id);
        return { id, ...version };
      } catch (error) {
        return { id, error: error instanceof Error ? error.message : String(error) };
      }
    })),
  };
}

/** Turns as the model passes them: score and comment flat on the turn. */
export function turnsOf(value: unknown): SocialTurn[] {
  const turns = Array.isArray(value) ? value : [];
  if (turns.length === 0) throw new Error("turns must not be empty");
  return turns.map((item, index) => {
    const turn = (item ?? {}) as Record<string, unknown>;
    const question = text(turn.question).trim();
    if (!question) throw new Error(`turn ${index + 1} has no question`);
    const score = typeof turn.score === "number" ? Math.round(turn.score) : null;
    if (score !== null && (score < 1 || score > 10)) throw new Error(`turn ${index + 1}: score must be 1–10`);
    return { question, answer: text(turn.answer).trim(), score: score === null ? null : { score, comment: text(turn.comment).trim() } };
  });
}

const fileOf = (value: unknown): SocialFileKind => {
  if (value !== "role" && value !== "playbook") throw new Error(`file must be "role" or "playbook", got "${String(value)}"`);
  return value;
};

/** Checks one staged write against the index and says what the diff card shows. */
export function describeSocialChange(roles: SocialRole[], change: ChangeInput): { kind: ChangeKind; title: string; detail: string } {
  const args = change.arguments;
  switch (change.name) {
    case "new_social_role": {
      const name = text(args.name).trim();
      if (!name || /[/\\]/.test(name) || name.startsWith(".")) throw new Error("name must not be empty or contain / or \\");
      if (roles.some((role) => role.name.toLowerCase() === name.toLowerCase())) throw new Error(`Role "${name}" already exists; use rewrite_social_file`);
      return { kind: "add", title: name, detail: `新建角色：${short(firstLine(text(args.role_text)))}` };
    }
    case "rewrite_social_file": {
      const role = findRole(roles, args.role);
      const file = fileOf(args.file);
      return { kind: "edit", title: `${role.name} · ${SOCIAL_FILE_NAMES[file]}`, detail: `改写整份：${short(firstLine(text(args.text)))}` };
    }
    case "rewrite_social_version": {
      const role = findRole(roles, args.role);
      const id = text(args.id);
      if (!role.questions.some((group) => group.versions.some((version) => version.id === id))) throw new Error(`No version "${id}" under role "${role.name}"`);
      const turns = turnsOf(args.turns);
      return { kind: "edit", title: `${role.name} · ${id}`, detail: `改写 ${turns.length} 轮 Q/A${typeof args.evaluation === "string" ? "和评估" : ""}` };
    }
    default:
      throw new Error(`Unknown social tool ${change.name}`);
  }
}

/** Staged roles count as existing for later calls in the same turn. */
export function applySocialChange(roles: SocialRole[], change: ChangeInput): SocialRole[] {
  if (change.name !== "new_social_role") return roles;
  return [...roles, { name: text(change.arguments.name).trim(), scene: "", favorites: [], questions: [] }];
}

/**
 * Writes confirmed social changes in order. A rewrite is checked against the file as it is now;
 * new roles are not undoable (delete them from the tree), file and version rewrites are.
 */
export async function commitSocialChanges(changes: AiChange[]) {
  const failed: Failure[] = [];
  const before: SocialSnapshot[] = [];
  const after: SocialSnapshot[] = [];
  const created = new Map<string, string>();
  const roleName = (value: unknown) => created.get(text(value).trim()) ?? text(value).trim();
  for (const change of changes) {
    const args = change.arguments;
    try {
      switch (change.name) {
        case "new_social_role": {
          const name = await newSocialRole(text(args.name));
          created.set(text(args.name).trim(), name);
          for (const [file, body] of [["role", text(args.role_text)], ["playbook", text(args.playbook_text)]] as const) {
            if (!body.trim()) continue;
            const base = await loadSocialFile(name, file);
            await saveSocialFile({ role: name, kind: file, base, body: `${body.trim()}\n` });
          }
          break;
        }
        case "rewrite_social_file": {
          const role = roleName(args.role);
          const file = fileOf(args.file);
          const base = await loadSocialFile(role, file);
          const body = `${text(args.text).trim()}\n`;
          const outcome = await saveSocialFile({ role, kind: file, base, body });
          if (outcome.status === "conflict") throw new Error(`${SOCIAL_FILE_NAMES[file]} 刚在别处被改过，没有写入`);
          before.push({ kind: "file", role, file, body: base });
          after.push({ kind: "file", role, file, body });
          break;
        }
        case "rewrite_social_version": {
          const role = roleName(args.role);
          const current: SocialVersion = await loadSocialVersion(role, text(args.id));
          const next = { ...current, turns: turnsOf(args.turns), ...(typeof args.evaluation === "string" && { evaluation: args.evaluation.trim() }) };
          const saved = await saveSocialVersion(role, next);
          before.push({ kind: "version", role, version: current });
          after.push({ kind: "version", role, version: saved });
          break;
        }
        default:
          throw new Error(`Unknown social tool ${change.name}`);
      }
    } catch (error) {
      failed.push({ changeId: change.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { before, after, failed, created: created.size > 0 };
}
