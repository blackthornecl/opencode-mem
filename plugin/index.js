/**
 * opencode-mem - Persistent memory plugin for OpenCode
 *
 * Based on claude-mem by Alex Newman (thedotmack)
 * https://github.com/thedotmack/claude-mem
 *
 * Licensed under Apache License 2.0
 * See LICENSE file for details
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
    mkdirSync(projectDir || configDir, { recursive: true });
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

export const Plugin = async (ctx) => {
  const projectName = ctx.directory?.split("/").pop() || ctx.project?.name || "opencode";

  // Inject context on plugin load
  const context = await fetchContextFromWorker(projectName);
  if (context) {
    injectContextIntoAgentsMd(context, ctx.directory);
  }

  return {
    // Capture tool executions via event hook
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

    // Handle all events
    event: async ({ event }) => {
      const eventType = event?.type;
      const data = event?.data;
      const sessionID = data?.sessionID || event?.properties?.sessionID;

      // Capture tool completions via message.part.updated
      if (eventType === "message.part.updated" && data?.part?.type === "tool") {
        const tool = data.part;
        if (tool.state?.status === "completed") {
          const sessionId = `opencode-${sessionID}`;
          await initSession(sessionId, projectName);
          postObservation(
            sessionId,
            tool.name || tool.tool,
            tool.state.input,
            JSON.stringify(tool.state.content || "").slice(0, 1000),
            ctx.directory
          );
        }
      }

      // Capture assistant text via message.part.updated
      if (eventType === "message.part.updated" && data?.part?.type === "text") {
        const text = data.part.text;
        if (text) {
          const sessionId = `opencode-${sessionID}`;
          await initSession(sessionId, projectName);
          postObservation(sessionId, "assistant_message", {}, text.slice(0, 1000), ctx.directory);
        }
      }

      // Session idle - summarize
      if (eventType === "session.idle" && sessionID) {
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
