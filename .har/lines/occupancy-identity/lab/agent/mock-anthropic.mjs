#!/usr/bin/env node
/**
 * Scripted Anthropic Messages mock for the Claude Code lab scenario.
 *
 * Vendored from os-factory/otel-hook `har-plugins/agent-lab`. Copy the jig, not
 * the package: publishing a shared `@osfactory/agent-lab` waits until a second
 * repository wants the same install (#316).
 *
 * Serves POST /v1/messages as SSE (or a JSON body when stream=false) with
 * frozen usage and a deterministic tool_use → final-text trajectory. Nothing
 * here talks to a real model. Usage numbers come from scenario.json so the
 * wrapping harness can attach the same figures to Stop.
 */

import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const LAB_AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const readJson = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") {
    return { raw, body: {} };
  }
  try {
    return { raw, body: JSON.parse(raw) };
  } catch {
    return { raw, body: undefined };
  }
};

const hasToolResult = (body) => {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    if (content.some((block) => block?.type === "tool_result")) {
      return true;
    }
  }
  return false;
};

const findTool = (body, wanted) => {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const lower = wanted.toLowerCase();
  return tools.find((tool) => typeof tool?.name === "string" && tool.name.toLowerCase() === lower);
};

const toolInputFor = (body, toolName, widgetPath) => {
  const tool = findTool(body, toolName);
  const properties = tool?.input_schema?.properties ?? {};
  if (properties.path && !properties.file_path) {
    return { path: widgetPath };
  }
  return { file_path: widgetPath };
};

const usagePayload = (usage) => ({
  input_tokens: usage.input_tokens,
  output_tokens: usage.output_tokens,
  cache_read_input_tokens: usage.cache_read_input_tokens,
  cache_creation_input_tokens: usage.cache_creation_input_tokens,
});

const streamToolUse = ({ model, toolName, toolId, toolInput, usage }) => {
  const inputJson = JSON.stringify(toolInput);
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_lab_tool",
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: usagePayload({ ...usage, output_tokens: 1 }),
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: toolId, name: toolName, input: {} },
    }),
    sse("ping", { type: "ping" }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: inputJson },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
};

const streamText = ({ model, text, usage }) =>
  [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_lab_final",
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: usagePayload({ ...usage, output_tokens: 1 }),
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");

const jsonToolUse = ({ model, toolName, toolId, toolInput, usage }) => ({
  id: "msg_lab_tool",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "tool_use", id: toolId, name: toolName, input: toolInput }],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: usagePayload(usage),
});

const jsonText = ({ model, text, usage }) => ({
  id: "msg_lab_final",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: usagePayload(usage),
});

const isMessagesPath = (url) => {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return pathname.endsWith("/messages") && !pathname.endsWith("/count_tokens");
};

const isCountTokensPath = (url) => {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return pathname.endsWith("/count_tokens");
};

const isModelsPath = (url) => {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return pathname === "/v1/models" || pathname === "/models" || pathname.startsWith("/v1/models/");
};

export const startMockServer = async (options) => {
  const scenario = options.scenario;
  const widgetPath = options.widgetPath;
  const logPath = options.logPath;
  const requests = [];
  let lastUsage = usagePayload(scenario.usage.toolTurn);
  let messageCalls = 0;

  const persistLog = async () => {
    if (logPath === undefined) {
      return;
    }
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, `${requests.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const write = (status, headers, body) => {
      res.writeHead(status, headers);
      res.end(body);
    };

    if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/health" || url.pathname === "/api/hello")) {
      write(200, { "content-type": "application/json" }, JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/last-usage") {
      write(200, { "content-type": "application/json" }, JSON.stringify(lastUsage));
      return;
    }
    if (req.method === "GET" && url.pathname === "/requests") {
      write(200, { "content-type": "application/json" }, JSON.stringify(requests));
      return;
    }
    if (req.method === "GET" && isModelsPath(url)) {
      write(
        200,
        { "content-type": "application/json" },
        JSON.stringify({
          data: [
            {
              id: scenario.model,
              type: "model",
              display_name: "Claude Lab Mock",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      );
      return;
    }

    void (async () => {
      const { raw, body } = await readJson(req);
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const record = {
        method: req.method,
        path: url.pathname,
        stream: body?.stream === true,
        hasToolResult: hasToolResult(body),
        model: typeof body?.model === "string" ? body.model : undefined,
        messageCount: messages.length,
        lastRole: messages.at(-1)?.role,
        toolNames: Array.isArray(body?.tools)
          ? body.tools.map((tool) => tool?.name).filter((name) => typeof name === "string")
          : [],
        bytes: raw.length,
      };
      requests.push(record);
      await persistLog();

      if (req.method === "POST" && isCountTokensPath(url)) {
        write(
          200,
          { "content-type": "application/json" },
          JSON.stringify({ input_tokens: scenario.usage.toolTurn.input_tokens }),
        );
        return;
      }

      if (req.method !== "POST" || !isMessagesPath(url)) {
        write(404, { "content-type": "application/json" }, JSON.stringify({ error: { type: "not_found", message: url.pathname } }));
        return;
      }
      if (body === undefined) {
        write(400, { "content-type": "application/json" }, JSON.stringify({ error: { type: "invalid_request_error", message: "invalid json" } }));
        return;
      }

      messageCalls += 1;
      const final = hasToolResult(body) || messageCalls >= 2;
      const usage = final ? scenario.usage.finalTurn : scenario.usage.toolTurn;
      lastUsage = usagePayload(usage);
      const model = typeof body.model === "string" && body.model.length > 0 ? body.model : scenario.model;
      const payload = final
        ? {
            model,
            text: scenario.finalText,
            usage,
          }
        : {
            model,
            toolName: findTool(body, scenario.toolName)?.name ?? scenario.toolName,
            toolId: "toolu_lab_read_01",
            toolInput: toolInputFor(body, scenario.toolName, widgetPath),
            usage,
          };

      if (body.stream === false) {
        const json = final ? jsonText(payload) : jsonToolUse(payload);
        write(200, { "content-type": "application/json" }, JSON.stringify(json));
        return;
      }

      const stream = final ? streamText(payload) : streamToolUse(payload);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-request-id": `req_lab_${String(messageCalls)}`,
      });
      res.end(stream);
    })().catch((error) => {
      if (!res.headersSent) {
        write(
          500,
          { "content-type": "application/json" },
          JSON.stringify({ error: { type: "api_error", message: error instanceof Error ? error.message : "mock failure" } }),
        );
      } else {
        res.end();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock server bound to an unexpected address");
  }
  const url = `http://127.0.0.1:${String(address.port)}`;

  return {
    url,
    requests,
    lastUsage: () => lastUsage,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { readFile } = await import("node:fs/promises");
  const scenario = JSON.parse(
    await readFile(path.join(LAB_AGENT_DIR, "scenario.json"), "utf8"),
  );
  const mock = await startMockServer({
    scenario,
    widgetPath: process.env.LAB_WIDGET_PATH ?? path.join(process.cwd(), scenario.widgetFileName),
  });
  process.stdout.write(`${mock.url}\n`);
}
