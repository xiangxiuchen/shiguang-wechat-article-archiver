// SPDX-License-Identifier: MPL-2.0

export const TERMINAL_JOB_STATUSES = new Set([
  "success",
  "partial",
  "error",
  "cancelled"
]);

export function isTerminalJob(job) {
  return Boolean(job && TERMINAL_JOB_STATUSES.has(job.status));
}

export function classifyAbortReason(reason) {
  if (reason?.code === "SL-CANCELLED") {
    return { status: "cancelled", code: "SL-CANCELLED", message: "已取消保存" };
  }
  if (reason?.code === "SL-JOB-TIMEOUT" || reason?.name === "TimeoutError") {
    return { status: "error", code: "SL-JOB-TIMEOUT", message: "保存任务超时" };
  }
  return {
    status: "error",
    code: "SL-JOB-INTERRUPTED",
    message: "浏览器中断了保存任务"
  };
}

export function findBusyJob(jobs, activeDownloads = new Map()) {
  for (const job of jobs.values()) {
    if (job.processing || job.status === "running" || activeDownloads.has(job.id)) {
      return job;
    }
  }
  return null;
}

export function findRecoverableJob(
  jobs,
  { jobId = null, sourceUrl = null, includeGlobalBusy = false } = {},
  activeDownloads = new Map()
) {
  if (jobId) return jobs.get(jobId) || null;
  if (includeGlobalBusy) {
    const busy = findBusyJob(jobs, activeDownloads);
    if (busy) return busy;
  }
  if (!sourceUrl) return null;

  const ordered = Array.from(jobs.values()).sort(
    (left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
  );
  return ordered.find((job) => job.sourceUrl === sourceUrl) || null;
}
