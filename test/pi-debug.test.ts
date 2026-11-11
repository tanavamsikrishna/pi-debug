/**
 * Checks that /pi-debug and the pi-debug tool call a module's default export,
 * and that the tool description includes TEMPLATE.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import extension from "../src/index.ts";

const template = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../static/TEMPLATE.ts"),
    "utf8",
);

interface RegisteredTool {
    name: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    executionMode?: string;
    execute: (
        toolCallId: string,
        params: { code: string },
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: { cwd: string },
    ) => Promise<{
        content: { type: string; text: string }[];
        details: { truncated: boolean; fullOutputPath?: string };
        isError?: boolean;
    }>;
}

interface RegisteredCommand {
    handler: (
        args: string,
        ctx: { cwd: string; ui: { notify: (message: string, level?: string) => void } },
    ) => Promise<void>;
}

function load(): { tool: RegisteredTool; command: RegisteredCommand; pi: { getActiveTools: () => string[] } } {
    let tool: RegisteredTool | undefined;
    let command: RegisteredCommand | undefined;
    const pi = {
        getActiveTools: () => ["read"],
        on() {},
        registerCommand(_name: string, spec: RegisteredCommand) {
            command = spec;
        },
        registerTool(spec: RegisteredTool) {
            tool = spec;
        },
    };
    extension(pi as never);
    if (!tool || !command) throw new Error("pi-debug was not registered");
    return { tool, command, pi };
}

function tempDir(): string {
    return mkdtempSync(path.join(tmpdir(), "pi-debug-test-"));
}

test("tool description includes TEMPLATE.ts and the tool runs that module shape", async () => {
    const { tool, pi } = load();
    assert.equal(tool.name, "pi-debug");
    assert.equal(tool.executionMode, "sequential");
    assert.ok(tool.description.includes(template.trim()));
    assert.equal(tool.promptSnippet?.includes("export default"), false);
    for (const guideline of tool.promptGuidelines ?? []) {
        assert.match(guideline, /pi-debug/);
    }

    const cwd = tempDir();
    try {
        const result = await tool.execute(
            "call-1",
            {
                code: `
                    export default function (api, getCtx) {
                        return { tools: api.getActiveTools(), cwd: getCtx().cwd };
                    }
                `,
            },
            undefined,
            undefined,
            { cwd },
        );
        assert.equal(result.isError, undefined);
        assert.deepEqual(JSON.parse(result.content[0].text), {
            tools: pi.getActiveTools(),
            cwd,
        });
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("slash command and tool both call the default export", async () => {
    const { tool, command } = load();
    const cwd = tempDir();
    const notes: { message: string; level?: string }[] = [];
    try {
        const relative = "./mod.ts";
        writeFileSync(
            path.join(cwd, "mod.ts"),
            `export default function () { return { from: "file" }; }\n`,
        );
        writeFileSync(
            path.join(cwd, "local.ts"),
            `export const n = 7;\n`,
        );

        await command.handler(relative, {
            cwd,
            ui: {
                notify(message, level) {
                    notes.push({ message, level });
                },
            },
        });
        assert.deepEqual(notes, [
            { message: `Result:\n${JSON.stringify({ from: "file" }, null, 2)}`, level: "info" },
        ]);

        const result = await tool.execute(
            "call-2",
            {
                code: `
                    import { n } from "./local.ts";
                    export default async function () {
                        const loaded = await import("./local.ts");
                        return { n, loaded: loaded.n };
                    }
                `,
            },
            undefined,
            undefined,
            { cwd },
        );
        assert.deepEqual(JSON.parse(result.content[0].text), { n: 7, loaded: 7 });
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("tool reports a missing default export and empty code as errors", async () => {
    const { tool } = load();
    const cwd = tempDir();
    try {
        const missing = await tool.execute(
            "call-3",
            { code: "export const n = 1;\n" },
            undefined,
            undefined,
            { cwd },
        );
        assert.equal(missing.isError, true);
        assert.match(missing.content[0].text, /No default export function found/);

        const empty = await tool.execute(
            "call-4",
            { code: "   \n" },
            undefined,
            undefined,
            { cwd },
        );
        assert.equal(empty.isError, true);
        assert.match(empty.content[0].text, /No code provided/);
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("tool truncates output and keeps the full text in a temp file", async () => {
    const { tool } = load();
    const cwd = tempDir();
    let fullOutputPath: string | undefined;
    try {
        const result = await tool.execute(
            "call-5",
            {
                code: `export default function () { return ${JSON.stringify("x".repeat(60_000))}; }`,
            },
            undefined,
            undefined,
            { cwd },
        );
        fullOutputPath = result.details.fullOutputPath;
        assert.equal(result.isError, undefined);
        assert.equal(result.details.truncated, true);
        assert.match(result.content[0].text, /Full output saved to:/);
        assert.equal(readFileSync(fullOutputPath!, "utf8"), "x".repeat(60_000));
    } finally {
        rmSync(cwd, { recursive: true, force: true });
        if (fullOutputPath) rmSync(path.dirname(fullOutputPath), { recursive: true, force: true });
    }
});

test("slash command reports a missing export and a missing return without a Result prefix", async () => {
    const { command } = load();
    const cwd = tempDir();
    const notes: { message: string; level?: string }[] = [];
    const ctx = {
        cwd,
        ui: {
            notify(message: string, level?: string) {
                notes.push({ message, level });
            },
        },
    };
    try {
        writeFileSync(path.join(cwd, "empty-export.ts"), "export const n = 1;\n");
        writeFileSync(path.join(cwd, "no-return.ts"), "export default function () {}\n");

        await command.handler("empty-export.ts", ctx);
        await command.handler("no-return.ts", ctx);

        assert.deepEqual(notes, [
            { message: "Error: No default export function found", level: "error" },
            { message: "Done (no return value)", level: "info" },
        ]);
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("slash command evaluates file source from the session directory", async () => {
    const { command } = load();
    const cwd = tempDir();
    const notes: { message: string; level?: string }[] = [];
    try {
        writeFileSync(path.join(cwd, "local.ts"), "export const n = 7;\n");
        mkdirSync(path.join(cwd, "nested"));
        writeFileSync(
            path.join(cwd, "nested/mod.ts"),
            `
                import { n } from "./local.ts";
                export default function () {
                    return { n, url: import.meta.url };
                }
            `,
        );

        await command.handler("nested/mod.ts", {
            cwd,
            ui: {
                notify(message, level) {
                    notes.push({ message, level });
                },
            },
        });

        assert.equal(notes.length, 1);
        assert.equal(notes[0].level, "info");
        const parsed = JSON.parse(notes[0].message.replace(/^Result:\n/, ""));
        assert.equal(parsed.n, 7);
        assert.match(parsed.url, /\.pi-debug-eval\.ts$/);
        assert.equal(existsSync(path.join(cwd, ".pi-debug-eval.ts")), false);
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("empty slash-command target is filled from TEMPLATE.ts and not executed", async () => {
    const { command } = load();
    const cwd = tempDir();
    const notes: string[] = [];
    try {
        await command.handler("debug.ts", {
            cwd,
            ui: {
                notify(message) {
                    notes.push(message);
                },
            },
        });
        assert.deepEqual(notes, ["debug.ts updated with a code template"]);
        assert.equal(readFileSync(path.join(cwd, "debug.ts"), "utf8"), template);
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});
