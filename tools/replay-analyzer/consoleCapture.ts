import type { LogsSummary, WarningSummary } from "./types";
import { topN } from "./utils";

export function createConsoleCapture(opts: {
  verbose: boolean;
  topN: number;
}): {
  restore: () => void;
  summarize: () => { warnings: WarningSummary; logs: LogsSummary };
} {
  const originalWarn = console.warn.bind(console);
  const originalInfo = console.info.bind(console);
  const originalLog = console.log.bind(console);

  let total = 0;
  const missingClientId = new Map<string, number>();
  const missingTargetId = new Map<string, number>();
  const other = new Map<string, number>();

  let totalLog = 0;
  let totalInfo = 0;
  const logMessages = new Map<string, number>();
  const infoMessages = new Map<string, number>();

  const missingClientRe = /^player with clientID ([a-zA-Z0-9]{8}) not found$/;
  const targetNotFoundRe =
    /^(?:TransportShipExecution: |TargetPlayerExecution: )?target ([a-zA-Z0-9]{8}) not found$/;

  console.log = (...args: unknown[]) => {
    totalLog++;
    const msg = args.map((a) => String(a)).join(" ");
    logMessages.set(msg, (logMessages.get(msg) ?? 0) + 1);
    if (opts.verbose) originalLog(...args);
  };

  console.info = (...args: unknown[]) => {
    totalInfo++;
    const msg = args.map((a) => String(a)).join(" ");
    infoMessages.set(msg, (infoMessages.get(msg) ?? 0) + 1);
    if (opts.verbose) originalInfo(...args);
  };

  console.warn = (...args: unknown[]) => {
    total++;
    const msg = args.map((a) => String(a)).join(" ");

    const missingClientMatch = msg.match(missingClientRe);
    if (missingClientMatch) {
      const id = missingClientMatch[1];
      missingClientId.set(id, (missingClientId.get(id) ?? 0) + 1);
      if (opts.verbose) originalWarn(...args);
      return;
    }

    const targetMatch = msg.match(targetNotFoundRe);
    if (targetMatch) {
      const id = targetMatch[1];
      missingTargetId.set(id, (missingTargetId.get(id) ?? 0) + 1);
      if (opts.verbose) originalWarn(...args);
      return;
    }

    other.set(msg, (other.get(msg) ?? 0) + 1);
    if (opts.verbose) originalWarn(...args);
  };

  return {
    restore: () => {
      console.warn = originalWarn;
      console.info = originalInfo;
      console.log = originalLog;
    },
    summarize: () => {
      const missingClientTotal = [...missingClientId.values()].reduce((a, b) => a + b, 0);
      const missingTargetTotal = [...missingTargetId.values()].reduce((a, b) => a + b, 0);
      const otherTotal = [...other.values()].reduce((a, b) => a + b, 0);

      const warnings: WarningSummary = {
        total,
        missingClientId: {
          total: missingClientTotal,
          top: topN(missingClientId, opts.topN).map((x) => ({ clientID: x.key, count: x.count })),
        },
        missingTargetId: {
          total: missingTargetTotal,
          top: topN(missingTargetId, opts.topN).map((x) => ({ targetID: x.key, count: x.count })),
        },
        other: {
          total: otherTotal,
          top: topN(other, opts.topN).map((x) => ({ message: x.key, count: x.count })),
        },
      };

      const logs: LogsSummary = {
        total: totalLog + totalInfo,
        log: {
          total: totalLog,
          top: topN(logMessages, opts.topN).map((x) => ({ message: x.key, count: x.count })),
        },
        info: {
          total: totalInfo,
          top: topN(infoMessages, opts.topN).map((x) => ({ message: x.key, count: x.count })),
        },
      };

      return { warnings, logs };
    },
  };
}

