/**
 * opencode-mem - Persistent memory plugin for OpenCode
 *
 * Based on claude-mem by Alex Newman (thedotmack)
 * https://github.com/thedotmack/claude-mem
 *
 * Licensed under Apache License 2.0
 * See LICENSE file for details
 *
 * This plugin captures tool usage observations and assistant messages,
 * stores them in the claude-mem worker, and makes them available for
 * future sessions via the claude_mem_search tool.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT || "37700";
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
const initialized = new Set();
const AGENTS_MD_TAG_OPEN = "<claude-mem-context>";
const AGENTS_MD_TAG_CLOSE = "</claude-mem-context>";

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
      body: JSON.stringify({
        contentSessionId: sessionId,
        project,
        prompt: "",
      }),
    });
    initialized.add(sessionId);
  } catch (e) {}
}

async function postObservation(sessionId, toolName, toolInput, toolResponse, cwd) {
  await initSession(sessionId, "opencode");
  try {
    await fetch(`${WORKER_URL}/api/sessions/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: sessionId,
        tool_name: toolName,
        tool_input: toolInput || {},
        tool_response: String(toolResponse || "").slice(0, 1000),
        cwd,
      }),
    });
  } catch (e) {}
}

async function fetchContextFromWorker(project) {
  try {
    const response = await fetch(
      `${WORKER_URL}/api/context/inject?project=${encodeURIComponent(project)}`
    );
    if (!response.ok) return null;
    const text = await response.text();
    return text && text.trim() ? text : null;
  } catch (e) {
    return null;
  }
}

function injectContextIntoAgentsMd(context, projectDir) {
  const agentsMdPath = getAgentsMdPath(projectDir);
  const configDir = getConfigDir();

  try {
    mkdirSync(configDir, { recursive: true });
  } catch (e) {}

  let content = "";
  if (existsSync(agentsMdPath)) {
    try {
      content = readFileSync(agentsMdPath, "utf-8");
    } catch (e) {}
  }

  const tagStart = content.indexOf(AGENTS_MD_TAG_OPEN);
  const tagEnd = content.indexOf(AGENTS_MD_TAG_CLOSE);

  const contextBlock = `${AGENTS_MD_TAG_OPEN}\n${context}\n${AGENTS_MD_TAG_CLOSE}`;

  if (tagStart !== -1 && tagEnd !== -1) {
    content =
      content.slice(0, tagStart) +
      contextBlock +
      content.slice(tagEnd + AGENTS_MD_TAG_CLOSE.length);
  } else {
    if (content.trim()) {
      content = content.trimEnd() + "\n\n" + contextBlock + "\n";
    } else {
      content = `# Claude-Mem Memory Context\n\n${contextBlock}\n`;
    }
  }

  try {
    writeFileSync(agentsMdPath, content, "utf-8");
  } catch (e) {}
}

export const OpenCodeMem = async (ctx) => {
  const projectName = ctx.project?.name || "opencode";

  // Inject context on plugin load (session start)
  const context = await fetchContextFromWorker(projectName);
  if (context) {
    injectContextIntoAgentsMd(context, ctx.directory);
  }

  return {
    // Capture every tool execution as an observation
    "tool.execute.after": async (input, output) => {
      const sessionId = `opencode-${input?.sessionID || "unknown"}`;
      await initSession(sessionId, projectName);
      postObservation(
        sessionId,
        input?.tool,
        output?.args,
        output?.output,
        ctx.directory
      );
    },

    // Capture assistant messages as observations via message.updated bus event
    "chat.message": async (_input, output) => {
      // This hook may not fire in OpenCode - fallback is in event handler
    },

    // Handle session lifecycle and message events
    event: async ({ event }) => {
      if (event?.type === "session.idle") {
        const sessionID = event?.properties?.sessionID;
        if (sessionID) {
          const sessionId = `opencode-${sessionID}`;
          await initSession(sessionId, projectName);
          try {
            await fetch(`${WORKER_URL}/api/sessions/summarize`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contentSessionId: sessionId,
                last_assistant_message: "",
              }),
            });
          } catch (e) {}
        }
      }

      // Capture assistant messages via message.updated bus event
      if (event?.type === "message.updated") {
        const data = event?.data;
        if (data?.role === "assistant" && data?.content) {
          const text = (data.content || [])
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n");

          if (text) {
            const sessionID = event?.properties?.sessionID || "unknown";
            const sessionId = `opencode-${sessionID}`;
            await initSession(sessionId, projectName);
            postObservation(sessionId, "assistant_message", {}, text, ctx.directory);
          }
        }
      }
    },

    // Custom tool for searching memory
    tool: {
      claude_mem_search: {
        description:
          "Search claude-mem memory database for past observations, sessions, and context",
        args: {
          query: {
            type: "string",
            description: "Search query for memory observations",
          },
        },
        async execute(args) {
          const query = args.query || "";
          if (!query) return "Please provide a search query.";

          try {
            const response = await fetch(
              `${WORKER_URL}/api/search/observations?query=${encodeURIComponent(query)}&limit=10`
            );

            if (!response.ok) {
              return "Worker not running. Start with: npx claude-mem start";
            }

            const data = await response.json();
            const content = data.content || [];
            const rendered = content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n")
              .trim();

            return rendered || `No results found for "${query}".`;
          } catch (e) {
            return "Worker not running. Start with: npx claude-mem start";
          }
        },
      },
    },
  };
};

export default OpenCodeMem;
