import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve(import.meta.dirname, "../apps/desktop/package.json"));
// Electron may download its binary on first access; keep setup outside the test timeout.
const executable = require("electron");
if (typeof executable !== "string") throw new Error("Electron binary is unavailable");
console.log("Electron binary ready.");
