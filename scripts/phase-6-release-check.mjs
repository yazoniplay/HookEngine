import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function configuredSupportEmail(source) {
  const match = source.match(/export const SUPPORT_EMAIL\s*=\s*["']([^"']*)["']/);
  if (!match || !match[1].trim()) {
    throw new Error("Phase 6 release blocked: SUPPORT_EMAIL must be configured before publishing.");
  }
  return match[1].trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = await readFile(new URL("../support.js", import.meta.url), "utf8");
  configuredSupportEmail(source);
  console.log("Phase 6 release check passed: support contact is configured.");
}
