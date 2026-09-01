import { useEffect, useRef, useState } from "react";
import { Check, GitBranch, GitMerge, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import type { WorktreeMergeResult, WorktreeStatusInfo } from "@shared/protocol";
import { useAppStore, type ChatState } from "@/stores/app-store";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

/**
 * The worktree chip doubles as a small human-review gate. A task snapshot is
 * committed to its isolated branch before the merge button is even offered.
 */
export function WorktreeMergePanel({ chat }: { chat: ChatState }): React.JSX.Element | null {
  const t = useT();
  const closeChat = useAppStore((s) => s.closeChat);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<WorktreeStatusInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [result, setResult] = useState<WorktreeMergeResult | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const wt = chat.worktree;

  const refresh = (): void => {
    if (!wt) return;
    setStatus(null);
    setError(null);
    setResult(null);
    window.pi.worktrees
      .status(wt.projectPath, chat.cwd, wt.branch, wt.taskId)
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) refresh();
  // refresh depends on current chat identity; it is intentionally recreated with it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wt, chat.cwd]);

  if (!wt) return null;

  const doPrepareReview = async (): Promise<void> => {
    if (!wt.taskId) {
      setError(t("worktree.legacyTask"));
      return;
    }
    setReviewing(true);
    setError(null);
    try {
      setStatus(await window.pi.worktrees.prepareReview(wt.projectPath, chat.cwd, wt.branch, wt.taskId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReviewing(false);
    }
  };

  const doMerge = async (): Promise<void> => {
    if (!wt.taskId) {
      setError(t("worktree.legacyTask"));
      return;
    }
    if (!window.confirm(t("worktree.mergeConfirm", { branch: status?.mainBranch ?? "main" }))) return;
    setMerging(true);
    setError(null);
    try {
      const next = await window.pi.worktrees.merge(wt.projectPath, chat.cwd, wt.branch, wt.taskId);
      setResult(next);
      if (!next.merged) setError(next.error ?? t("worktree.mergeFailed"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMerging(false);
    }
  };

  const doDiscard = async (): Promise<void> => {
    setCleaning(true);
    setError(null);
    try {
      if (!wt.taskId) {
        await window.pi.worktrees.remove(wt.projectPath, chat.cwd, wt.branch);
        closeChat(chat.chatId);
        return;
      }
      let next = await window.pi.worktrees.discard(wt.projectPath, chat.cwd, wt.branch, wt.taskId, false);
      if (next.requiresConfirmation) {
        const confirmed = window.confirm(
          t("worktree.discardConfirm", { dirty: next.dirtyFiles, commits: next.ahead }),
        );
        if (!confirmed) return;
        next = await window.pi.worktrees.discard(wt.projectPath, chat.cwd, wt.branch, wt.taskId, true);
      }
      if (!next.discarded) {
        setError(next.error ?? t("worktree.discardFailed"));
        return;
      }
      closeChat(chat.chatId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCleaning(false);
    }
  };

  const task = status?.task;
  const pending = status ? status.ahead + (status.dirtyFiles > 0 ? 1 : 0) : 0;
  const changedAfterReview = task?.taskChangedAfterReview ?? false;
  const targetMoved = task?.targetAdvanced || task?.targetBranchChanged;
  const reviewReady = task?.state === "review_ready" && !changedAfterReview;
  const canMerge = reviewReady && !targetMoved && !chat.isStreaming;

  return (
    <div ref={ref} className="relative inline-flex shrink-0 translate-y-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("worktree.title")}
        className={cn(
          "no-drag inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] transition-colors",
          open ? "bg-accent text-accent-fg" : "bg-accent-muted text-accent hover:bg-accent/25",
        )}
      >
        <GitBranch size={10} />
        {wt.branch}
      </button>

      {open && (
        <div className="dialog-in absolute left-0 top-7 z-40 w-[315px] rounded-xl border border-border-strong bg-bg-secondary p-3 shadow-xl">
          {!status && !error && (
            <div className="flex items-center gap-2 py-2 text-xs text-fg-muted">
              <Loader2 size={12} className="animate-spin" />
              {t("worktree.checking")}
            </div>
          )}

          {status && !result && (
            <>
              <div className="space-y-1 pb-2 text-[11.5px] text-fg-secondary">
                <div>
                  {t("worktree.target")}
                  <span className="font-mono text-fg">{status.mainBranch}</span>
                </div>
                <div>
                  {t("worktree.pending")}
                  <span className="text-fg">{status.ahead}</span>
                  {status.dirtyFiles > 0 && (
                    <span className="text-warning">{t("worktree.dirty", { n: status.dirtyFiles })}</span>
                  )}
                </div>
              </div>

              {task && (
                <div className="mb-2 rounded-lg border border-border bg-bg px-2 py-1.5 text-[10.5px] leading-relaxed text-fg-muted">
                  <div className="flex items-center gap-1 text-fg-secondary">
                    <ShieldCheck size={11} className="text-accent" />
                    {task.state === "review_ready" ? t("worktree.reviewReady") : t("worktree.reviewRequired")}
                  </div>
                  {targetMoved && <div className="pt-1 text-warning">{t("worktree.targetMoved")}</div>}
                  {changedAfterReview && <div className="pt-1 text-warning">{t("worktree.changedAfterReview")}</div>}
                </div>
              )}

              {status.changedFiles.length > 0 && (
                <div className="mb-2 max-h-28 overflow-y-auto rounded-lg border border-border bg-bg px-2 py-1.5">
                  {status.changedFiles.slice(0, 12).map((file) => (
                    <div key={file} className="truncate font-mono text-[10.5px] text-fg-muted">
                      {file}
                    </div>
                  ))}
                  {status.changedFiles.length > 12 && (
                    <div className="pt-0.5 text-[10px] text-fg-muted">
                      {t("worktree.moreFiles", { n: status.changedFiles.length })}
                    </div>
                  )}
                </div>
              )}

              {pending === 0 && !task ? (
                <div className="py-1 text-[11.5px] text-fg-muted">{t("worktree.noNeed")}</div>
              ) : reviewReady ? (
                <button
                  type="button"
                  disabled={!canMerge || merging}
                  onClick={() => void doMerge()}
                  title={chat.isStreaming ? t("worktree.waitAgent") : undefined}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
                >
                  {merging ? <Loader2 size={12} className="animate-spin" /> : <GitMerge size={12} />}
                  {t("worktree.mergeTo", { branch: status.mainBranch })}
                </button>
              ) : task ? (
                <button
                  type="button"
                  disabled={reviewing || chat.isStreaming}
                  onClick={() => void doPrepareReview()}
                  title={chat.isStreaming ? t("worktree.waitAgent") : undefined}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
                >
                  {reviewing ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                  {t("worktree.prepareReview")}
                </button>
              ) : (
                <div className="py-1 text-[11.5px] text-warning">{t("worktree.legacyTask")}</div>
              )}
            </>
          )}

          {result?.merged && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs text-success">
                <Check size={13} />
                {result.mergedCommits > 0
                  ? t("worktree.merged", { n: result.mergedCommits, branch: result.mainBranch })
                  : t("worktree.alreadySynced")}
              </div>
            </div>
          )}

          {(status || result) && (
            <button
              type="button"
              disabled={cleaning}
              onClick={() => void doDiscard()}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-fg-secondary transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40"
            >
              {cleaning ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              {t("worktree.discard")}
            </button>
          )}

          {error && <div className="pt-1.5 text-[11px] leading-relaxed text-danger">{error}</div>}
        </div>
      )}
    </div>
  );
}
