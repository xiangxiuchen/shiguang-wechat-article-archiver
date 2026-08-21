// SPDX-License-Identifier: MPL-2.0

const startButton = document.getElementById("start");
const statusOutput = document.getElementById("status");
let jobId = null;
let pollTimer = null;

const sampleArticle = {
  sourceUrl: "https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1&sn=fixture",
  title: "拾光存档完整链路测试",
  account: "拾光测试号",
  author: "测试作者",
  publishTime: "2026-08-20 10:30",
  bodyHtml: "<section><h2>离线存档正文</h2><p>这段文字必须真实写入下载文件。</p></section>",
  images: [],
  unsupportedMediaCount: 0
};

function setState(state, message, extra = {}) {
  statusOutput.dataset.state = state;
  statusOutput.textContent = message;
  for (const [key, value] of Object.entries(extra)) {
    statusOutput.dataset[key] = String(value ?? "");
  }
}

async function finishFromJob(job) {
  clearInterval(pollTimer);
  const items = Number.isInteger(job.downloadId)
    ? await chrome.downloads.search({ id: job.downloadId })
    : [];
  const item = items[0];
  setState(job.status, job.message || job.status, {
    jobId: job.id,
    downloadId: job.downloadId,
    filename: item?.filename || "",
    downloadState: item?.state || ""
  });
  startButton.disabled = false;
}

async function pollJob() {
  if (!jobId) return;
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: "QUERY_JOB",
    jobId
  });
  const job = response?.job;
  if (!job) return;
  if (["success", "partial", "error", "cancelled"].includes(job.status)) {
    await finishFromJob(job);
    return;
  }
  setState("running", job.message || "正在保存", {
    jobId,
    downloadId: job.downloadId
  });
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  setState("starting", "正在建立保存任务");
  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "START_ARCHIVE",
      article: sampleArticle
    });
    if (!response?.ok) throw new Error(response?.error?.message || "保存任务创建失败");
    jobId = response.jobId;
    setState("running", response.job?.message || "正在保存", { jobId });
    pollTimer = setInterval(() => pollJob().catch((error) => {
      clearInterval(pollTimer);
      setState("error", error.message);
      startButton.disabled = false;
    }), 100);
    await pollJob();
  } catch (error) {
    setState("error", error.message || "测试失败");
    startButton.disabled = false;
  }
});
