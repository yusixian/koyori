import { parentPort, workerData } from "node:worker_threads";
import type { HistorySource, UsageImportCache } from "@koyori/core";
import { importUsageIncremental } from "@koyori/core";

const data: { sources: HistorySource[]; cache: UsageImportCache } = workerData;
parentPort?.postMessage(await importUsageIncremental(data.sources, data.cache));
