import { FileText, MessagesSquare, Star, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyProposals, proposalFile, splitId } from "../socialLogic";
import {
  listSocialRoles, loadSocialFile, loadSocialVersion, newSocialRole, newSocialVersion,
  renameSocialRole, renameSocialVersion, saveSocialFile, saveSocialVersion, SOCIAL_FILE_NAMES, trashSocial, type SocialProposal, type SocialSnapshot,
} from "../socialStorage";
import type { SocialFileKind, SocialRole, SocialVersion } from "../types";
import { SocialFilePane } from "./SocialFilePane";
import { SocialTree, windowKey, type SocialWindow } from "./SocialTree";
import { SocialVersionPane } from "./SocialVersionPane";

interface SocialViewProps {
  /** Bump to re-read (edited in Obsidian, undo, an AI batch). */
  revision: number;
  onHistory: (before: SocialSnapshot, after: SocialSnapshot) => void;
}

const message = (error: unknown) => (typeof error === "string" ? error : error instanceof Error ? error.message : "出现了未知错误");

/** 社交模拟器: role tree on the left, tabbed windows (versions and the two md files) on the right. */
export function SocialView({ revision, onHistory }: SocialViewProps) {
  const [roles, setRoles] = useState<SocialRole[] | null>(null);
  const [windows, setWindows] = useState<SocialWindow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, SocialVersion>>({});
  const [fileRevision, setFileRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const versionsRef = useRef(versions);
  versionsRef.current = versions;
  const windowsRef = useRef(windows);
  windowsRef.current = windows;

  const refreshRoles = useCallback(async () => {
    try {
      setRoles(await listSocialRoles());
    } catch (problem) {
      setError(`无法读取社交模拟器：${message(problem)}`);
      setRoles([]);
    }
  }, []);

  // Re-read the tree, every open version and the md windows.
  useEffect(() => {
    void refreshRoles();
    setFileRevision((value) => value + 1);
    for (const window of windowsRef.current) {
      if (window.kind !== "version") continue;
      const key = windowKey(window);
      loadSocialVersion(window.role, window.id)
        .then((version) => setVersions((map) => ({ ...map, [key]: version })))
        .catch(() => close(key));
    }
  }, [refreshRoles, revision]);

  async function open(window: SocialWindow) {
    const key = windowKey(window);
    setError(null);
    if (window.kind === "version" && !versionsRef.current[key]) {
      try {
        const version = await loadSocialVersion(window.role, window.id);
        setVersions((map) => ({ ...map, [key]: version }));
      } catch (problem) {
        setError(message(problem));
        return;
      }
    }
    setWindows((list) => (list.some((item) => windowKey(item) === key) ? list : [...list, window]));
    setActive(key);
  }

  function close(key: string) {
    setWindows((list) => {
      const index = list.findIndex((item) => windowKey(item) === key);
      const next = list.filter((item) => windowKey(item) !== key);
      setActive((current) => (current === key ? (next[Math.min(index, next.length - 1)] ? windowKey(next[Math.min(index, next.length - 1)]) : null) : current));
      return next;
    });
    setVersions((map) => {
      const next = { ...map };
      delete next[key];
      return next;
    });
  }

  async function saveVersion(role: string, next: SocialVersion) {
    const key = windowKey({ kind: "version", role, id: next.id });
    const before = versionsRef.current[key] ?? (await loadSocialVersion(role, next.id));
    const saved = await saveSocialVersion(role, next);
    setVersions((map) => ({ ...map, [key]: saved }));
    onHistory({ kind: "version", role, version: before }, { kind: "version", role, version: saved });
    void refreshRoles();
  }

  /** ★ from any of the four places: the tree row, 收藏, the window tab, the version title. */
  async function star(role: string, id: string, starred: boolean) {
    const key = windowKey({ kind: "version", role, id });
    try {
      const version = versionsRef.current[key] ?? (await loadSocialVersion(role, id));
      await saveVersion(role, { ...version, starred });
    } catch (problem) {
      setError(message(problem));
    }
  }

  /** `练` (question + topic) and the dashed 新问题 row (both empty). */
  async function practice(role: string, question = "", topic = "") {
    try {
      const version = await newSocialVersion(role, question, topic);
      const key = windowKey({ kind: "version", role, id: version.id });
      setVersions((map) => ({ ...map, [key]: version }));
      setWindows((list) => [...list, { kind: "version", role, id: version.id }]);
      setActive(key);
      await refreshRoles();
    } catch (problem) {
      setError(message(problem));
    }
  }

  /** Checked proposals, one save per md file; each file is one undo step. */
  async function writeProposals(role: string, source: string, proposals: SocialProposal[]) {
    const byFile = new Map<SocialFileKind, SocialProposal[]>();
    proposals.forEach((item) => byFile.set(proposalFile(item.kind), [...(byFile.get(proposalFile(item.kind)) ?? []), item]));
    for (const [file, items] of byFile) {
      const before = await loadSocialFile(role, file);
      const body = applyProposals(before, items, source);
      const outcome = await saveSocialFile({ role, kind: file, base: before, body });
      if (outcome.status === "conflict") throw new Error(`${SOCIAL_FILE_NAMES[file]} 刚在别处被改过，没有写入`);
      onHistory({ kind: "file", role, file, body: before }, { kind: "file", role, file, body });
    }
    setFileRevision((value) => value + 1);
  }

  async function newRole(name: string) {
    try {
      const created = await newSocialRole(name);
      await refreshRoles();
      void open({ kind: "file", role: created, file: "role" });
      return true;
    } catch (problem) {
      setError(message(problem));
      return false;
    }
  }

  async function renameRole(role: string, name: string) {
    try {
      const renamed = await renameSocialRole(role, name);
      if (renamed !== role) {
        const move = (window: SocialWindow): SocialWindow => (window.role === role ? { ...window, role: renamed } : window);
        const keys = new Map(windowsRef.current.map((window) => [windowKey(window), windowKey(move(window))]));
        setWindows((list) => list.map(move));
        setVersions((map) => Object.fromEntries(Object.entries(map).map(([key, value]) => [keys.get(key) ?? key, value])));
        setActive((current) => (current ? keys.get(current) ?? current : current));
      }
      await refreshRoles();
      return true;
    } catch (problem) {
      setError(message(problem));
      return false;
    }
  }

  /**
   * Real file rename; open windows, loaded versions and the active tab follow the new id. Returns
   * false with `error` set when the name is taken or has no date, for both the tree and the pane.
   */
  async function renameVersion(role: string, id: string, name: string) {
    const key = windowKey({ kind: "version", role, id });
    try {
      const renamed = await renameSocialVersion(role, id, name);
      if (renamed !== id) {
        const to = windowKey({ kind: "version", role, id: renamed });
        setWindows((list) => list.map((item) => (windowKey(item) === key ? ({ kind: "version", role, id: renamed } as SocialWindow) : item)));
        setVersions((map) => {
          if (!(key in map)) return map;
          const { [key]: moved, ...rest } = map;
          return { ...rest, [to]: { ...moved, id: renamed, topic: splitId(renamed).tag } };
        });
        setActive((current) => (current === key ? to : current));
      }
      await refreshRoles();
      return true;
    } catch (problem) {
      setError(message(problem));
      return false;
    }
  }

  async function trash(role: string, id?: string) {
    try {
      await trashSocial(role, id);
      windowsRef.current
        .filter((window) => window.role === role && (id === undefined || (window.kind === "version" && window.id === id)))
        .forEach((window) => close(windowKey(window)));
      await refreshRoles();
    } catch (problem) {
      setError(message(problem));
    }
  }

  const starredOf = (window: SocialWindow) => (window.kind === "version" ? versions[windowKey(window)]?.starred ?? false : false);

  return (
    <main className="social-workspace">
      <div className="social-layout">
        <SocialTree
          roles={roles}
          active={active}
          onOpen={(window) => void open(window)}
          onStar={(role, id, starred) => void star(role, id, starred)}
          onPractice={(role, question, topic) => void practice(role, question, topic)}
          onNewBlank={(role) => void practice(role)}
          onNewRole={newRole}
          onRenameRole={renameRole}
          onRenameVersion={renameVersion}
          onTrashRole={(role) => void trash(role)}
        />
        <section className="social-work" aria-label="窗口">
          {windows.length > 0 && (
            <div className="social-strip" role="tablist" aria-label="打开的窗口">
              {windows.map((window) => {
                const key = windowKey(window);
                const name = window.kind === "version" ? window.id : SOCIAL_FILE_NAMES[window.file].replace(/\.md$/, "");
                return (
                  <div key={key} className={`social-wt ${active === key ? "active" : ""}`} role="tab" aria-selected={active === key} tabIndex={0} title={`${window.role} · ${name}`} onClick={() => setActive(key)} onKeyDown={(event) => event.key === "Enter" && setActive(key)}>
                    {window.kind === "version"
                      ? <button type="button" className={`social-star ${starredOf(window) ? "on" : ""}`} aria-label={starredOf(window) ? `取消收藏 ${window.id}` : `收藏 ${window.id}`} aria-pressed={starredOf(window)} onClick={(event) => { event.stopPropagation(); void star(window.role, window.id, !starredOf(window)); }}><Star size={11} aria-hidden="true" /></button>
                      : <FileText size={11} aria-hidden="true" />}
                    <span>{name}</span>
                    <button type="button" className="social-wt-x" aria-label={`关闭 ${name}`} onClick={(event) => { event.stopPropagation(); close(key); }}><X size={11} aria-hidden="true" /></button>
                  </div>
                );
              })}
            </div>
          )}
          {error && <p className="inline-error social-message" role="alert">{error}</p>}
          {windows.length === 0 && (
            <div className="social-empty">
              <MessagesSquare size={22} aria-hidden="true" />
              <p>在左边点一个版本或 md 打开；点问题旁的「练」开始今天的练习。</p>
            </div>
          )}
          {windows.map((window) => {
            const key = windowKey(window);
            if (window.kind === "file") {
              return <SocialFilePane key={key} role={window.role} file={window.file} hidden={active !== key} revision={fileRevision} onHistory={(before, after) => onHistory({ kind: "file", role: window.role, file: window.file, body: before }, { kind: "file", role: window.role, file: window.file, body: after })} />;
            }
            const version = versions[key];
            if (!version) return null;
            return (
              <SocialVersionPane
                key={key}
                role={window.role}
                version={version}
                hidden={active !== key}
                onSave={(next) => saveVersion(window.role, next)}
                onRename={(name) => renameVersion(window.role, version.id, name)}
                onStar={() => void star(window.role, version.id, !version.starred)}
                onTrash={() => void trash(window.role, version.id)}
                onProposals={(items) => writeProposals(window.role, version.id, items)}
              />
            );
          })}
        </section>
      </div>
    </main>
  );
}
