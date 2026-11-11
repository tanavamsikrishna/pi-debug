/**
 * Pi extension that runs a user TypeScript file inside the agent process.
 *
 * Registers `/pi-debug`. An empty target is filled from TEMPLATE.ts; otherwise
 * jiti loads the file and calls its default export as `(pi, getCtx) => ...`.
 * Scripts share the agent process: no sandbox, no reload.
 */
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import path, { resolve } from "path";
import { createJiti, Jiti } from "jiti";
import { fileURLToPath } from "node:url";

function createIfEmpty(fullPath: string): "was-empty" | "was-not-empty" {
    if (!existsSync(fullPath) || !readFileSync(fullPath, "utf8").trim()) {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const templateFileLocation = path.join(__dirname, "./TEMPLATE.ts");
        const codeTemplate = readFileSync(templateFileLocation);
        writeFileSync(fullPath, codeTemplate, "utf-8");
        return "was-empty";
    }
    return "was-not-empty";
}

export default function (pi: ExtensionAPI) {
    let lastCtx: ExtensionContext | null = null;
    let jiti: Jiti | undefined = undefined;

    // Keep lastCtx current so the `() => lastCtx` getter remains valid
    // after /pi-debug returns (for deferred callbacks in user scripts).
    pi.on("session_start", async (_event, ctx) => {
        lastCtx = ctx;
    });
    pi.on("turn_start", async (_event, ctx) => {
        lastCtx = ctx;
    });

    pi.registerCommand("pi-debug", {
        description: "Run a .ts file with default export function",
        handler: async (args, ctx) => {
            lastCtx = ctx;

            let filePath = args?.trim() || "";
            if (filePath.startsWith("@")) filePath = filePath.slice(1);
            if (!filePath) {
                ctx.ui.notify("Usage: /pi-debug <file-path>", "info");
                return;
            }

            const fullPath = resolve(ctx.cwd, filePath);
            if (createIfEmpty(fullPath) == "was-empty") {
                ctx.ui.notify(`${filePath} updated with a code template`);
                return;
            }

            try {
                jiti ||= createJiti(import.meta.url, {
                    fsCache: false,
                    moduleCache: false,
                });
                const mod = await jiti.import(fullPath, { default: true });
                const fn = mod;

                if (typeof fn !== "function") {
                    ctx.ui.notify(
                        `Error: No default export function found`,
                        "error",
                    );
                    return;
                }

                const result = await fn(pi, () => lastCtx);

                if (result !== undefined) {
                    const str =
                        typeof result === "object"
                            ? JSON.stringify(result, null, 2)
                            : String(result);
                    ctx.ui.notify(`Result:\n${str}`, "info");
                } else {
                    ctx.ui.notify("Done (no return value)", "info");
                }
            } catch (e: any) {
                ctx.ui.notify(`Error: ${e.message}`, "error");
            }
        },
    });
}
