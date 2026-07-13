import { readFileSync } from "node:fs";
import { join } from "node:path";

const styleLayers = ["legacy.css", "workspace-refresh.css"];

/** Reads the effective source order used by the app stylesheet entrypoint. */
export function readAppStyles(): string {
  return styleLayers
    .map((fileName) => readFileSync(join(process.cwd(), "src/app/styles", fileName), "utf8"))
    .join("");
}
