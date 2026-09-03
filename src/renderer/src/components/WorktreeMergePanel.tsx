import { useEffect, useRef, useState } from "react";
import { Check, Download, GitBranch, GitMerge, ListOrdered, Loader2, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import type { DockerTaskPatchPreview, WslTaskPatchPreview, WorktreeMergeResult, WorktreeStatusInfo } from "@shared/protocol";
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
  const [dockerPatch, setDockerPatch] = useState<DockerTaskPatchPreview | null>(null);
  const [wslPatch, setWslPatch] = useState<WslTaskPatchPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [result, setResult] = useState<WorktreeMergeResult | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [dockerBusy, setDockerBusy] = useState(false);
  const [wslBusy, setWslBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const wt = chat.worktree;

  const refresh = (): void => {
    if (!wt) return;
    setStatus(null);
    setDockerPatch(null);
    setWslPatch(null);
    setError(null);
    setResult(null);
    window.pi.worktrees
      .status(wt.projectPath, chat.cwd, wt.branch, wt.taskId)
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
    if (wt.taskId) {
      window.pi.worktrees
        .dockerPatch(wt.projectPath, chat.cwd, wt.branch, wt.taskId)
        .then(setDockerPatch)
        .catch((e: Error) => setError(e.message));
      window.pi.worktrees
        .wslPatch(wt.projectPath, chat.cwd, wt.branch, wt.taskId)
        .then(setWslPatch)
        .catch((e: Error) => setError(e.message));
    }
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

  const doQueue = async (): Promise<void> => {
    if (!wt.taskId) {
      setError(t("worktree.legacyTask"));
      return;
    }
    if (!window.confirm(t("worktree.queueConfirm", { branch: status?.mainBranch ?? "main" }))) return;
    setQueueing(true);
    setError(null);
    try {
      const next = await window.pi.worktrees.queue(wt.projectPath, chat.cwd, wt.branch, wt.taskId);
      if (!next.queued) {
        setError(next.error ?? t("worktree.queueFailed"));
        return;
      }
      setStatus(await window.pi.worktrees.status(wt.projectPath, chat.cwd, wt.branch, wt.taskId));
      if (next.blocked) setError(next.blocked.reason);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setQueueing(false);
    }
  };

  const doUnqueue = async (): Promise<void> => {
    if (!wt.taskId) return;
    setQueueing(true);
    setError(null);
    try {
      setStatus(await window.pi.worktrees.unqueue(wt.projectPath, chat.cwd, wt.branch, wt.taskId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setQueueing(false);
    }
  };

  const doRestoreCheckpoint = async (): Promise<void> => {
    if (!wt.taskId || !status?.task?.recovery.latest) return;
    setRecovering(true);
    setError(null);
    try {
      let next = await window.pi.worktrees.restoreCheckpoint(
        wt.projectPath,
        chat.cwd,
        wt.branch,
        wt.taskId,
        status.task.recovery.latest.id,
        false,
      );
      if (next.requiresConfirmation) {
        if (!window.confirm(t("worktree.restoreCheckpointConfirm"))) return;
        next = await window.pi.worktrees.restoreCheckpoint(
          wt.projectPath,
          chat.cwd,
          wt.branch,
          wt.taskId,
          status.task.recovery.latest.id,
          true,
        );
      }
      if (!next.restored) {
        setError(next.error ?? t("worktree.restoreCheckpointFailed"));
        return;
      }
      setStatus(await window.pi.worktrees.status(wt.projectPath, chat.cwd, wt.branch, wt.taskId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRecovering(false);
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

  const doImportDockerPatch = async (): Promise<void> => {
    if (!wt.taskId) return;
    setDockerBusy(true);
    setError(null);
    try {
      let next = await window.pi.worktrees.importDockerPatch(
        wt.projectPath,
        chat.cwd,
        wt.branch,
        wt.taskId,
        false,
      );
      if (next.requiresConfirmation) {
        const confirmed = window.confirm(t("worktree.dockerImportConfirm", { n: next.changedFiles.length }));
        if (!confirmed) return;
        next = await window.pi.worktrees.importDockerPatch(
          wt.projectPath,
          chat.cwd,
          wt.branch,
          wt.taskId,
          true,
        );
      }
      if (!next.imported) {
        setError(next.error ?? t("worktree.dockerImportFailed"));
        return;
      }
      setDockerPatch({ state: "imported", changedFiles: [], patchBytes: 0, error: next.error });
      setStatus(await window.pi.worktrees.status(wt.projectPath, chat.cwd, wt.branch, wt.taskId));
      if (next.error) setError(next.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDockerBusy(false);
    }
  };

  const doDiscardDockerPatch = async (): Promise<void> => {
    if (!wt.taskId) return;
    setDockerBusy(true);
    setError(null);
    try {
      let next = await window.pi.worktrees.discardDockerPatch(
        wt.projectPath,
        chat.cwd,
        wt.branch,
        wt.taskId,
        false,
      );
      if (next.requiresConfirmation) {
        const confirmed = window.confirm(t("worktree.dockerDiscardConfirm", { n: next.changedFiles.length }));
        if (!confirmed) return;
        next = await window.pi.worktrees.discardDockerPatch(
          wt.projectPath,
          chat.cwd,
          wt.branch,
          wt.taskId,
          true,
        );
      }
      if (!next.discarded) {
        setError(next.error ?? t("worktree.dockerDiscardFailed"));
        return;
      }
      setDockerPatch({ state: "discarded", changedFiles: [], patchBytes: 0 });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDockerBusy(false);
    }
  };

  const doImportWslPatch = async (): Promise<void> => {
    if (!wt.taskId) return;
    setWslBusy(true);
    setError(null);
    try {
      let next = await window.pi.worktrees.importWslPatch(
        wt.projectPath,
        chat.cwd,
        wt.branch,
        wt.taskId,
        false,
      );
      if (next.requiresConfirmation) {
        const confirmed = window.confirm(t("worktree.wslImportConfirm", { n: next.changedFiles.length }));
        if (!confirmed) return;
        next = await window.pi.worktrees.importWslPatch(
          wt.projectPath,
          chat.cwd,
          wt.branch,
          wt.taskId,
          true,
        );
      }
      if (!next.imported) {
        setError(next.error ?? t("worktree.wslImportFailed"));
        return;
      }
      setWslPatch({ state: "imported", changedFiles: [], patchBytes: 0, error: next.error });
      setStatus(await window.pi.worktrees.status(wt.projectPath, chat.cwd, wt.branch, wt.taskId));
      if (next.error) setError(next.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWslBusy(false);
    }
  };

  const doDiscardWslPatch = async (): Promise<void> => {
    if (!wt.taskId) return;
    setWslBusy(true);
    setError(null);
    try {
      let next = await window.pi.worktrees.discardWslPatch(
        wt.projectPath,
        chat.cwd,
        wt.branch,
        wt.taskId,
        false,
      );
      if (next.requiresConfirmation) {
        const confirmed = window.confirm(t("worktree.wslDiscardConfirm", { n: next.changedFiles.length }));
        if (!confirmed) return;
        next = await window.pi.worktrees.discardWslPatch(
          wt.projectPath,
          chat.cwd,
          wt.branch,
          wt.taskId,
          true,
        );
      }
      if (!next.discarded) {
        setError(next.error ?? t("worktree.wslDiscardFailed"));
        return;
      }
      setWslPatch({ state: "discarded", changedFiles: [], patchBytes: 0 });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWslBusy(false);
    }
  };

  const task = status?.task;
  const pending = status ? status.ahead + (status.dirtyFiles > 0 ? 1 : 0) : 0;
  const changedAfterReview = task?.taskChangedAfterReview ?? false;
  const targetMoved = task?.targetAdvanced || task?.targetBranchChanged;
  const reviewReady = task?.state === "review_ready" && !changedAfterReview;
  const queued = task?.state === "merge_queued";
  const canMerge = reviewReady && !targetMoved && !chat.isStreaming;
  const dockerCopyReady = dockerPatch?.state === "ready";
  const wslCopyReady = wslPatch?.state === "ready";

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
                    {task.state === "review_ready"
                      ? t("worktree.reviewReady")
                      : task.state === "merge_queued"
                        ? t("worktree.queued")
                        : task.state === "merged"
                          ? t("worktree.taskMerged")
                          : t("worktree.reviewRequired")}
                  </div>
                  {targetMoved && <div className="pt-1 text-warning">{t("worktree.targetMoved")}</div>}
                  {changedAfterReview && <div className="pt-1 text-warning">{t("worktree.changedAfterReview")}</div>}
                  {task.queue && (
                    <div className="pt-1">
                      {t("worktree.queuePosition", { n: task.queue.position })}
                      {task.queue.blockedReason && <span className="text-warning"> · {t("worktree.queuePaused")}</span>}
                    </div>
                  )}
                  {changedAfterReview && task.recovery.latest && (
                    <button
                      type="button"
                      disabled={recovering || chat.isStreaming}
                      onClick={() => void doRestoreCheckpoint()}
                      className="mt-1.5 inline-flex items-center gap-1 text-accent hover:underline disabled:opacity-40"
                    >
                      {recovering ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                      {t("worktree.restoreCheckpoint")}
                    </button>
                  )}
                </div>
              )}

              {dockerCopyReady && (
                <div className="mb-2 rounded-lg border border-border bg-bg px-2 py-1.5 text-[10.5px] leading-relaxed text-fg-muted">
                  <div className="flex items-center gap-1 text-fg-secondary">
                    <ShieldCheck size={11} className="text-accent" />
                    {t("worktree.dockerCopy")}
                  </div>
                  {dockerPatch.error ? (
                    <div className="pt-1 text-danger">{dockerPatch.error}</div>
                  ) : dockerPatch.changedFiles.length > 0 ? (
                    <div className="pt-1">{t("worktree.dockerChanges", { n: dockerPatch.changedFiles.length })}</div>
                  ) : (
                    <div className="pt-1">{t("worktree.dockerNoChanges")}</div>
                  )}
                  <div className="mt-1.5 flex gap-1.5">
                    {dockerPatch.changedFiles.length > 0 && (
                      <button
                        type="button"
                        disabled={dockerBusy || chat.isStreaming || Boolean(dockerPatch.error)}
                        onClick={() => void doImportDockerPatch()}
                        title={chat.isStreaming ? t("worktree.waitAgent") : undefined}
                        className="flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 py-1.5 text-[10.5px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
                      >
                        {dockerBusy ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                        {t("worktree.importDocker")}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={dockerBusy || chat.isStreaming}
                      onClick={() => void doDiscardDockerPatch()}
                      title={chat.isStreaming ? t("worktree.waitAgent") : undefined}
                      className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-[10.5px] text-fg-secondary hover:border-danger/40 hover:text-danger disabled:opacity-40"
                    >
                      <Trash2 size={11} />
                      {t("worktree.discardDocker")}
                    </button>
                  </div>
                </div>
              )}

              {wslCopyReady && (
                <div className="mb-2 rounded-lg border border-border bg-bg px-2 py-1.5 text-[10.5px] leading-relaxed text-fg-muted">
                  <div className="flex items-center gap-1 text-fg-secondary">
                    <ShieldCheck size={11} className="text-accent" />
                    {t("worktree.wslCopy")}
                  </div>
                  {wslPatch.error ? (
                    <div className="pt-1 text-danger">{wslPatch.error}</div>
                  ) : wslPatch.changedFiles.length > 0 ? (
                    <div className="pt-1">{t("worktree.wslChanges", { n: wslPatch.changedFiles.length })}</div>
                  ) : (
                    <div className="pt-1">{t("worktree.wslNoChanges")}</div>
                  )}
                  <div className="mt-1.5 flex gap-1.5">
                    {wslPatch.changedFiles.length > 0 && (
                      <button
                        type="button"
                        disabled={wslBusy || chat.isStreaming || Boolean(wslPatch.error)}
                        onClick={() => void doImportWslPatch()}
                        title={chat.isStreaming ? t("worktree.waitAgent") : undefined}
                        className="flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 py-1.5 text-[10.5px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
                      >
                        {wslBusy ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                        {t("worktree.importWsl")}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={wslBusy || chat.isStreaming}
                      onClick={() => void doDiscardWslPatch()}
                      title={chat.isStreaming ? t("worktree.waitAgent") : undefined}
                      className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-[10.5px] text-fg-secondary hover:border-danger/40 hover:text-danger disabled:opacity-40"
                    >
                      <Trash2 size={11} />
                      {t("worktree.discardWsl")}
                    </button>
                  </div>
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
                <div className="space-y-1.5">
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
                  <button
                    type="button"
                    disabled={queueing || chat.isStreaming}
                    onClick={() => void doQueue()}
                    title={chat.isStreaming ? t("worktree.waitAgent") : undefined}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[11px] text-fg-secondary transition-colors hover:border-accent/50 hover:text-accent disabled:opacity-40"
                  >
                    {queueing ? <Loader2 size={11} className="animate-spin" /> : <ListOrdered size={11} />}
                    {targetMoved ? t("worktree.queueAfterTargetMoved") : t("worktree.queueMerge")}
                  </button>
                </div>
              ) : queued ? (
                <button
                  type="button"
                  disabled={queueing || chat.isStreaming}
                  onClick={() => void doUnqueue()}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-fg-secondary transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40"
                >
                  {queueing ? <Loader2 size={12} className="animate-spin" /> : <ListOrdered size={12} />}
                  {t("worktree.unqueue")}
                </button>
              ) : task && !dockerCopyReady ? (
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
              ) : !task ? (
                <div className="py-1 text-[11.5px] text-warning">{t("worktree.legacyTask")}</div>
              ) : null}
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
