import { parentPort, workerData } from "node:worker_threads";
import { type ResourceRoot, scanSkills } from "@koyori/core";

const roots: ResourceRoot[] = workerData;
scanSkills(roots)
  .then((result) => parentPort?.postMessage(result))
  .catch(() => {
    throw new Error("Skill scan failed");
  });
