// SPDX-License-Identifier: MPL-2.0

export function classifyDownloadTerminal(state, cancelRequested = false) {
  if (state === "complete") return "complete";
  if (state === "interrupted") {
    return cancelRequested ? "cancelled" : "interrupted";
  }
  return null;
}

export function mergeTerminalObservation(current, next) {
  if (!next) return current || null;
  if (!current) return next;
  if (current.state === "complete") return current;
  if (next.state === "complete") return next;
  return current;
}

export async function withTimeout(promise, timeoutMs, error, onTimeout = null) {
  let timeoutId;
  const timeoutError = error instanceof Error
    ? error
    : Object.assign(new Error("操作超时"), { code: "SL-TIMEOUT" });

  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          if (typeof onTimeout === "function") onTimeout();
          reject(timeoutError);
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}
