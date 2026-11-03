import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { piGateway } from "../src/llm/gateways/pi.js";

const tempRoot = () => mkdtemp(path.join(os.tmpdir(), "aip-pi-"));

function fakeDeps({ prompt, writeOutput } = {}) {
  let sessionOptions;
  const model = { provider: "openai-codex", id: "gpt-6-luna" };
  const deps = {
    ModelRuntime: { create: async () => ({ getModel: () => model }) },
    SettingsManager: { inMemory: () => ({}) },
    SessionManager: { inMemory: (cwd) => ({ cwd }) },
    DefaultResourceLoader: class {
      constructor(options) { this.options = options; }
      async reload() {}
    },
    createAgentSession: async (options) => {
      sessionOptions = options;
      const session = {
        messages: [],
        prompt: async (message) => {
          assert.equal(message, "stage prompt");
          if (prompt) await prompt(options.cwd);
          if (writeOutput) await writeFile(path.join(options.cwd, "output.md"), writeOutput);
          session.messages = [
            { role: "assistant", content: [{ type: "text", text: "assistant answer" }], usage: { input: 5, output: 2 } },
          ];
        },
        waitForIdle: async () => {},
        dispose: async () => {},
      };
      return { session };
    },
  };
  return { deps, getSessionOptions: () => sessionOptions };
}

test("Pi gateway uses work cwd, loads tool modules with context, and prefers outputFile", async () => {
  const temp = await tempRoot();
  const priorCodexHome = process.env.CODEX_HOME;
  try {
    const attemptDir = path.join(temp, "run", "steps", "step", "v1", "a1");
    const gatewayDir = path.join(temp, "workflow");
    await mkdir(gatewayDir, { recursive: true });
    const codexHome = path.join(temp, "codex");
    await mkdir(codexHome, { recursive: true });
    const payload = Buffer.from(JSON.stringify({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url");
    await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: {
      access_token: `header.${payload}.signature`, refresh_token: "test-refresh",
    } }));
    process.env.CODEX_HOME = codexHome;
    await writeFile(path.join(gatewayDir, "tool.js"),
      "export default (context) => [{ name: 'sample_tool', context }];");
    const fake = fakeDeps({ writeOutput: "file answer" });
    const result = await piGateway({
      provider: "codex",
      tools: ["read", "write"],
      toolModules: ["tool.js"],
      outputFile: "output.md",
    }, { model: "gpt-6-luna", effort: "low", prompt: "stage prompt", attemptDir, gatewaysDir: gatewayDir }, { deps: fake.deps });
    const options = fake.getSessionOptions();
    assert.equal(result.text, "file answer");
    assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    assert.equal(options.cwd, path.join(attemptDir, "work"));
    assert.deepEqual(options.tools, ["read", "write"]);
    assert.equal(options.model.id, "gpt-6-luna");
    assert.equal(options.thinkingLevel, "low");
    assert.deepEqual(options.customTools[0].context, {
      workdir: path.join(attemptDir, "work"),
      attemptDir,
      runDir: path.join(temp, "run"),
    });
  } finally {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
    await rm(temp, { recursive: true, force: true });
  }
});

test("Pi gateway rejects empty assistant and outputFile responses", async () => {
  const temp = await tempRoot();
  try {
    const fake = fakeDeps();
    fake.deps.createAgentSession = async () => ({ session: {
      messages: [{ role: "assistant", content: [] }],
      prompt: async () => {},
      dispose: async () => {},
    } });
    await assert.rejects(piGateway({}, {
      model: "m", prompt: "stage prompt", attemptDir: path.join(temp, "attempt"),
    }, { deps: fake.deps }), /empty response/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Pi gateway falls back to the last assistant message without an outputFile", async () => {
  const temp = await tempRoot();
  try {
    const fake = fakeDeps();
    const result = await piGateway({}, {
      model: "m", prompt: "stage prompt", attemptDir: path.join(temp, "attempt"),
    }, { deps: fake.deps });
    assert.equal(result.text, "assistant answer");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Pi gateway classifies provider limits for route fallback", async () => {
  const temp = await tempRoot();
  try {
    const fake = fakeDeps();
    fake.deps.createAgentSession = async () => ({ session: {
      messages: [],
      prompt: async () => { throw Object.assign(new Error("provider limited"), { status: 429 }); },
      dispose: async () => {},
    } });
    await assert.rejects(piGateway({}, {
      model: "m", prompt: "stage prompt", attemptDir: path.join(temp, "attempt"),
    }, { deps: fake.deps }), (error) => {
      assert.equal(error.kind, "limit");
      return true;
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
