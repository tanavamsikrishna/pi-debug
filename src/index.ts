/**
 * Pi extension that runs user TypeScript inside the agent process.
 *
 * Registers `/pi-debug` and the `pi-debug` tool. Both evaluate module source
 * on one shared jiti instance and call the default export as `(pi, getCtx) => ...`.
 * The command reads a file, filling an empty target from TEMPLATE.ts. The tool
 * evaluates the given source. Scripts share the agent process: no sandbox, no reload.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { createJiti, type Jiti } from "jiti";
import { Type } from "typebox";

interface PiDebugDetails {
  truncated: boolean;
  fullOutputPath?: string;
}

type ScriptRun =
  | { ok: true; value: unknown; text: string }
  | { ok: false; text: string };

function templateFilePath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const beside = path.join(dir, "TEMPLATE.ts");
  if (existsSync(beside)) return beside;
  return path.join(dir, "../static/TEMPLATE.ts");
}

function readCommandSource(fullPath: string): string | undefined {
  const existing = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
  if (existing.trim()) return existing;
  writeFileSync(fullPath, readFileSync(templateFilePath()));
  return undefined;
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

async function runDefaultExport(
  load: () => Promise<unknown>,
  pi: ExtensionAPI,
  getCtx: () => ExtensionContext | null,
): Promise<ScriptRun> {
  try {
    const value = await invokeDefaultExport(await load(), pi, getCtx);
    const text =
      value === undefined
        ? "Done (no return value)"
        : typeof value === "object"
          ? JSON.stringify(value, null, 2)
          : String(value);
    return { ok: true, value, text };
  } catch (error: unknown) {
    return {
      ok: false,
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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

async function present(
  text: string,
): Promise<{ text: string; details: PiDebugDetails }> {
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
  const shown = truncation.firstLineExceedsLimit
    ? notice
    : truncation.content + notice;
  return { text: shown, details: { truncated: true, fullOutputPath } };
}

async function toolResult(text: string, isError = false) {
  const presented = await present(text);
  return {
    content: [{ type: "text" as const, text: presented.text }],
    details: presented.details,
    ...(isError ? { isError: true as const } : {}),
  };
}

export default function (pi: ExtensionAPI) {
  let lastCtx: ExtensionContext | null = null;
  let jiti: Jiti | undefined;

  // One instance for /pi-debug and the pi-debug tool. moduleCache is off so
  // each call re-reads imports.
  const getJiti = (): Jiti => {
    jiti ||= createJiti(import.meta.url, {
      fsCache: false,
      moduleCache: false,
    });
    return jiti;
  };
  const getCtx = () => lastCtx;

  // Virtual file in cwd: imports resolve from the session directory, and
  // import.meta.url is not a file on disk. Same path for both entry points.
  const loadSource = (code: string, cwd: string) =>
    getJiti().evalModule(code, {
      filename: path.join(cwd, ".pi-debug-eval.ts"),
      async: true,
    });

  // lastCtx stays current for deferred callbacks.
  for (const event of ["session_start", "turn_start"] as const) {
    pi.on(event, (_event, ctx) => {
      lastCtx = ctx;
    });
  }

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
      const code = readCommandSource(fullPath);
      if (code === undefined) {
        ctx.ui.notify(`${filePath} updated with a code template`);
        return;
      }

      const run = await runDefaultExport(
        () => loadSource(code, ctx.cwd),
        pi,
        getCtx,
      );
      if (!run.ok) {
        ctx.ui.notify(run.text, "error");
        return;
      }
      ctx.ui.notify(
        run.value === undefined ? run.text : `Result:\n${run.text}`,
        "info",
      );
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
      if (signal?.aborted) return toolResult("Cancelled", true);

      lastCtx = ctx;
      if (!params.code.trim())
        return toolResult("Error: No code provided", true);

      const run = await runDefaultExport(
        () => loadSource(params.code, ctx.cwd),
        pi,
        getCtx,
      );
      return toolResult(run.text, !run.ok);
    },
  });
}
