/**
 * Pi extension that runs user TypeScript inside the agent process.
 *
 * Registers `/pi-debug` and the `pi-debug` tool. Both call a module's default
 * export as `(pi, getCtx) => ...` on one shared jiti instance. The command
 * loads a file, filling an empty target from TEMPLATE.ts. The tool evaluates
 * module source. Scripts share the agent process: no sandbox, no reload.
 */
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    formatSize,
    truncateHead,
    withFileMutationQueue,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJiti, type Jiti } from "jiti";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface PiDebugDetails {
    truncated: boolean;
    fullOutputPath?: string;
}

function templateFilePath(): string {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const beside = path.join(dir, "TEMPLATE.ts");
    if (existsSync(beside)) return beside;
    return path.join(dir, "../static/TEMPLATE.ts");
}

function createIfEmpty(fullPath: string): "was-empty" | "was-not-empty" {
    if (!existsSync(fullPath) || !readFileSync(fullPath, "utf8").trim()) {
        writeFileSync(fullPath, readFileSync(templateFilePath()));
        return "was-empty";
    }
    return "was-not-empty";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatDebugResult(result: unknown): string {
    if (result === undefined) return "Done (no return value)";
    if (typeof result === "object") return JSON.stringify(result, null, 2);
    return String(result);
}

async function invokeDefaultExport(
    mod: unknown,
    pi: ExtensionAPI,
    getCtx: () => ExtensionContext | null,
): Promise<unknown> {
    const exported = (mod as { default?: unknown } | null)?.default ?? mod;
    if (typeof exported !== "function") {
        throw new Error("No default export function found");
    }
    return await exported(pi, getCtx);
}

function toolDescription(template: string): string {
    return [
        "Evaluates a TypeScript module on this session's jiti instance and returns what its default export returns.",
        "The default export is called as (pi, getCtx) => result. pi is the agent ExtensionAPI. getCtx() returns the current ExtensionContext. Listeners registered on pi remain after this call. The module runs in the agent process with this extension's privileges. There is no sandbox.",
        "Imports resolve from the session working directory and are read again on each call. import.meta.url is not a file on disk.",
        'An object or array result is JSON. undefined is the text "Done (no return value)". Any other result is String(value). A thrown error, or a module with no default-export function, is an error result whose text starts with "Error: ".',
        `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}, whichever is hit first. The notice names the temp file that holds the full text.`,
        "Module shape:",
        template.trimEnd(),
    ].join("\n\n");
}

async function present(text: string): Promise<{ text: string; details: PiDebugDetails }> {
    const truncation = truncateHead(text);
    if (!truncation.truncated) {
        return { text, details: { truncated: false } };
    }

    const dir = await mkdtemp(path.join(tmpdir(), "pi-debug-"));
    const fullOutputPath = path.join(dir, "output.txt");
    await withFileMutationQueue(fullOutputPath, async () => {
        await writeFile(fullOutputPath, text, "utf8");
    });

    const notice = truncation.firstLineExceedsLimit
        ? `[Output truncated: first line exceeds ${formatSize(DEFAULT_MAX_BYTES)}. Full output saved to: ${fullOutputPath}]`
        : `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
    const shown = truncation.firstLineExceedsLimit ? notice : truncation.content + notice;
    return { text: shown, details: { truncated: true, fullOutputPath } };
}

export default function (pi: ExtensionAPI) {
    let lastCtx: ExtensionContext | null = null;
    let jiti: Jiti | undefined;

    // One instance for /pi-debug and the pi-debug tool. moduleCache is off so
    // each call re-reads imports. lastCtx stays current for deferred callbacks.
    const getJiti = (): Jiti => {
        jiti ||= createJiti(import.meta.url, {
            fsCache: false,
            moduleCache: false,
        });
        return jiti;
    };
    const getCtx = () => lastCtx;

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

            const fullPath = path.resolve(ctx.cwd, filePath);
            if (createIfEmpty(fullPath) === "was-empty") {
                ctx.ui.notify(`${filePath} updated with a code template`);
                return;
            }

            try {
                const mod = await getJiti().import(fullPath);
                const result = await invokeDefaultExport(mod, pi, getCtx);
                if (result === undefined) {
                    ctx.ui.notify("Done (no return value)", "info");
                } else {
                    ctx.ui.notify(`Result:\n${formatDebugResult(result)}`, "info");
                }
            } catch (error: unknown) {
                ctx.ui.notify(`Error: ${errorMessage(error)}`, "error");
            }
        },
    });

    pi.registerTool({
        name: "pi-debug",
        label: "Pi Debug",
        description: toolDescription(readFileSync(templateFilePath(), "utf8")),
        promptSnippet: "Run TypeScript inside the live Pi agent",
        promptGuidelines: [
            "Use pi-debug when the answer depends on live agent state, such as the system prompt, active tools, or session entries, instead of inferring that state from files.",
            "Do not use bash or a subprocess instead of pi-debug for live agent state; a subprocess cannot see this process.",
            "After pi-debug returns, use that result, and call pi-debug again only if agent state may have changed.",
        ],
        parameters: Type.Object({
            code: Type.String({
                description:
                    "TypeScript module source to evaluate. Include imports and the default export; not a function body.",
            }),
        }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            if (signal?.aborted) {
                const cancelled = await present("Cancelled");
                return {
                    content: [{ type: "text", text: cancelled.text }],
                    details: cancelled.details,
                    isError: true,
                };
            }

            lastCtx = ctx;
            if (!params.code.trim()) {
                const empty = await present("Error: No code provided");
                return {
                    content: [{ type: "text", text: empty.text }],
                    details: empty.details,
                    isError: true,
                };
            }

            try {
                const mod = await getJiti().evalModule(params.code, {
                    filename: path.join(ctx.cwd, ".pi-debug-eval.ts"),
                    async: true,
                });
                const result = await invokeDefaultExport(mod, pi, getCtx);
                const presented = await present(formatDebugResult(result));
                return {
                    content: [{ type: "text", text: presented.text }],
                    details: presented.details,
                };
            } catch (error: unknown) {
                const presented = await present(`Error: ${errorMessage(error)}`);
                return {
                    content: [{ type: "text", text: presented.text }],
                    details: presented.details,
                    isError: true,
                };
            }
        },
    });
}
