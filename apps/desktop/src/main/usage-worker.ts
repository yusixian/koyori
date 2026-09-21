import { parentPort, workerData } from "node:worker_threads";
import type { HistorySource } from "@koyori/core";
import { importUsage } from "@koyori/core";

const sources: HistorySource[] = workerData;
parentPort?.postMessage(await importUsage(sources));
