/**
 * opencode-mem - Persistent memory plugin for OpenCode
 *
 * Based on claude-mem by Alex Newman (thedotmack)
 * https://github.com/thedotmack/claude-mem
 *
 * Licensed under Apache License 2.0
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT || "37700";
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
const initialized = new Set();
const AGENTS_MD_TAG_OPEN = "<claude-mem-context>";
const AGENTS_MD_TAG_CLOSE = "</claude-mem-context>";

let lastUserMessage = "";

function getConfigDir() {
  return process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode");
}

function getAgentsMdPath(projectDir) {
  return join(projectDir || getConfigDir(), "AGENTS.md");
}

async function initSession(sessionId, project) {
  if (initialized.has(sessionId)) return;
  try {
    await fetch(`${WORKER_URL}/api/sessions/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentSessionId: sessionId, project, prompt: "" }),
    });
    initialized.add(sessionId);
  } catch (e) {}
}

async function postObservation(sessionId, toolName, toolInput, toolResponse, cwd) {
  await initSession(sessionId, "opencode");
  try {
    // Build rich context for better AI summaries
    const context = [
      `## User Request`,
      lastUserMessage || "No specific request",
      ``,
      `## Tool Execution`,
      `Tool: ${toolName}`,
      `Input: ${JSON.stringify(toolInput || {}).slice(0, 1000)}`,
      ``,
      `## Tool Output`,
      (toolResponse || "").slice(0, 3000),
    ].join("\n");

    const res = await fetch(`${WORKER_URL}/api/sessions/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: sessionId,
        tool_name: toolName,
        tool_input: toolInput || {},
        tool_response: context.slice(0, 4000),
        cwd,
      }),
    });
    const data = await res.json();
    writeFileSync("/tmp/opencode-mem-post.txt", `posted: ${toolName} -> ${JSON.stringify(data)}\n`, { flag: "a" });
  } catch (e) {
    writeFileSync("/tmp/opencode-mem-post.txt", `error: ${e.message}\n`, { flag: "a" });
  }
}

async function fetchContextFromWorker(project) {
  try {
    const r = await fetch(`${WORKER_URL}/api/context/inject?project=${encodeURIComponent(project)}`);
    if (!r.ok) return null;
    const t = await r.text();
    return t && t.trim() ? t : null;
  } catch (e) { return null; }
}

function injectContextIntoAgentsMd(context, projectDir) {
  const agentsMdPath = getAgentsMdPath(projectDir);
  try { mkdirSync(projectDir || getConfigDir(), { recursive: true }); } catch (e) {}
  let content = "";
  if (existsSync(agentsMdPath)) {
    try { content = readFileSync(agentsMdPath, "utf-8"); } catch (e) {}
  }
  const tagStart = content.indexOf(AGENTS_MD_TAG_OPEN);
  const tagEnd = content.indexOf(AGENTS_MD_TAG_CLOSE);
  const block = `${AGENTS_MD_TAG_OPEN}\n${context}\n${AGENTS_MD_TAG_CLOSE}`;
  if (tagStart !== -1 && tagEnd !== -1) {
    content = content.slice(0, tagStart) + block + content.slice(tagEnd + AGENTS_MD_TAG_CLOSE.length);
  } else {
    content = content.trim() ? content.trimEnd() + "\n\n" + block + "\n" : `# Claude-Mem Memory Context\n\n${block}\n`;
  }
  try { writeFileSync(agentsMdPath, content, "utf-8"); } catch (e) {}
}

export const Plugin = async (ctx) => {
  const projectName = ctx.directory?.split("/").pop() || ctx.project?.name || "opencode";
  writeFileSync("/tmp/opencode-mem-loaded.txt", `initialized at ${new Date().toISOString()}\nproject: ${projectName}\n`, { flag: "a" });

  const context = await fetchContextFromWorker(projectName);
  if (context) injectContextIntoAgentsMd(context, ctx.directory);

  return {
    "tool.execute.after": async (input, output) => {
      writeFileSync("/tmp/opencode-mem-tool.txt", `tool: ${input?.tool} at ${new Date().toISOString()}\n`, { flag: "a" });
      const sessionId = `opencode-${input?.sessionID || "unknown"}`;
      await initSession(sessionId, projectName);
      postObservation(sessionId, input?.tool, output?.args, output?.output, ctx.directory);
    },

    event: async ({ event }) => {
      const data = event?.data;
      const sessionID = data?.sessionID || event?.properties?.sessionID;

      if (event?.type === "message.updated" && data?.role === "user") {
        lastUserMessage = data.content || data.text || "";
      }

      if (event?.type === "message.part.updated" && data?.part?.type === "tool") {
        const tool = data.part;
        if (tool.state?.status === "completed") {
          const sessionId = `opencode-${sessionID}`;
          await initSession(sessionId, projectName);
          postObservation(
            sessionId,
            tool.name || tool.tool,
            tool.state.input,
            JSON.stringify(tool.state.content || "").slice(0, 2000),
            ctx.directory
          );
        }
      }

      if (event?.type === "session.idle" && sessionID) {
        const sessionId = `opencode-${sessionID}`;
        await initSession(sessionId, projectName);
        fetch(`${WORKER_URL}/api/sessions/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentSessionId: sessionId, last_assistant_message: "" }),
        }).catch(() => {});
      }
    },

    tool: {
      claude_mem_search: {
        description: "Search claude-mem memory database",
        args: { query: { type: "string", description: "Search query" } },
        async execute(args) {
          const q = args.query || "";
          if (!q) return "Provide a query";
          try {
            const r = await fetch(`${WORKER_URL}/api/search/observations?query=${encodeURIComponent(q)}&limit=10`);
            const d = await r.json();
            return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim() || "No results";
          } catch { return "Worker not running"; }
        },
      },
    },
  };
};
