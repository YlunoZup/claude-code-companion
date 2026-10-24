// Tests for translate.cjs: Claude Code's Messages API to OpenAI's Responses API
// and back. Plain data in, plain data out — no network.
//
// The shapes on the OpenAI side are the ones its endpoint was seen to send and
// accept when the router was built: the answer arrives only as stream events
// (with nothing stored, response.completed lists no output), reasoning comes as
// an encrypted blob, and input items carry no ids.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import translate from "../src/translate.cjs";

const { REASONING_MARK, toResponsesRequest, StreamTranslator, toAnthropicError, clampEffort, chooseEffort, estimateTokens, toUsage } = translate;

const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const opts = (more = {}) => ({ model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", efforts: EFFORTS, ...more });

function body(more = {}) {
  return {
    model: "gpt-6.1-sol",
    max_tokens: 32000,
    stream: true,
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.310; cc_entrypoint=cli;" },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Be careful." },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "", session_id: "session-123" }) },
    thinking: { type: "adaptive", display: "updates" },
    output_config: { effort: "high" },
    context_management: { edits: [] },
    ...more,
  };
}

// Feed a list of Responses events through a translator, collecting what it emits.
function run(events, { model = "gpt-6.1-sol", names } = {}) {
  const emitted = [];
  const t = new StreamTranslator({ model, names, messageId: "msg_test", emit: (event, data) => emitted.push({ event, data }) });
  t.start();
  for (const e of events) t.handle(e);
  return { t, emitted, types: emitted.map((e) => e.event) };
}

describe("the request", () => {
  test("the system prompt becomes instructions, with a note in front and Anthropic's billing line left out", () => {
    const { request } = toResponsesRequest(body(), opts());
    assert.match(request.instructions, /^You are GPT-6\.1-Sol \(gpt-6\.1-sol\), an OpenAI model, running inside Claude Code/);
    assert.match(request.instructions, /say GPT-6\.1-Sol\.\n\nYou are Claude Code/);
    assert.match(request.instructions, /Be careful\.$/);
    assert.doesNotMatch(request.instructions, /billing-header/);
  });

  test("a plain string system prompt works too", () => {
    const { request } = toResponsesRequest(body({ system: "Only this." }), opts());
    assert.match(request.instructions, /\n\nOnly this\.$/);
  });

  test("nothing is stored at OpenAI, the answer streams, and Anthropic-only fields stay behind", () => {
    const { request } = toResponsesRequest(body({ temperature: 1, top_k: 5 }), opts());
    assert.equal(request.store, false);
    assert.equal(request.stream, true);
    for (const field of ["max_tokens", "metadata", "temperature", "top_k", "context_management", "thinking", "output_config", "system", "messages"]) {
      assert.equal(field in request, false, `${field} must not be sent`);
    }
  });

  test("asks for the encrypted reasoning, so the next turn can send it back", () => {
    const { request } = toResponsesRequest(body(), opts());
    assert.deepEqual(request.include, ["reasoning.encrypted_content"]);
  });

  test("a stable prompt-cache key comes from the session, and says nothing about it", () => {
    const a = toResponsesRequest(body(), opts()).request.prompt_cache_key;
    const b = toResponsesRequest(body({ messages: [{ role: "user", content: "other" }] }), opts()).request.prompt_cache_key;
    assert.match(a, /^ccc-[0-9a-f]{32}$/);
    assert.equal(a, b, "the same session must keep the same key");
    assert.doesNotMatch(a, /session-123/);
    const other = toResponsesRequest(body({ metadata: { user_id: JSON.stringify({ session_id: "another" }) } }), opts()).request.prompt_cache_key;
    assert.notEqual(a, other);
  });

  test("fields the endpoint refused earlier are left out", () => {
    const omit = new Set(["include", "prompt_cache_key", "reasoning.summary"]);
    const { request } = toResponsesRequest(body(), opts({ omit }));
    assert.equal("include" in request, false);
    assert.equal("prompt_cache_key" in request, false);
    assert.equal("summary" in request.reasoning, false);
  });
});

describe("effort", () => {
  test("Claude Code's effort maps across directly, with summaries when it shows thinking", () => {
    const { request } = toResponsesRequest(body(), opts());
    assert.deepEqual(request.reasoning, { effort: "high", summary: "auto" });
  });

  test("no summaries when Claude Code has thinking display turned off", () => {
    const { request } = toResponsesRequest(body({ thinking: { type: "adaptive", display: "omitted" } }), opts());
    assert.deepEqual(request.reasoning, { effort: "high" });
  });

  test("thinking turned off — a background request — becomes the weakest effort", () => {
    const { request } = toResponsesRequest(body({ thinking: { type: "disabled" }, output_config: { effort: "high" } }), opts());
    assert.deepEqual(request.reasoning, { effort: "low" });
  });

  test("an older thinking budget becomes the nearest effort", () => {
    const b = (budget) => chooseEffort({ thinking: { type: "enabled", budget_tokens: budget } }, EFFORTS);
    assert.equal(b(1024), "low");
    assert.equal(b(8000), "medium");
    assert.equal(b(20000), "high");
    assert.equal(b(64000), "xhigh");
  });

  test("with nothing to go by, medium", () => {
    assert.equal(chooseEffort({}, EFFORTS), "medium");
  });

  test("an effort the model lacks steps down to the nearest it has", () => {
    assert.equal(clampEffort("xhigh", ["low", "medium", "high"]), "high");
    assert.equal(clampEffort("max", ["low", "medium", "high", "xhigh", "max"]), "max");
    assert.equal(clampEffort("low", ["medium", "high"]), "medium", "below its weakest gives its weakest");
    assert.equal(clampEffort("high", []), "high", "no list passes it as it is");
  });
});

describe("the conversation", () => {
  test("user and assistant text become typed messages, in order", () => {
    const { request } = toResponsesRequest(
      body({
        messages: [
          { role: "user", content: "plain string" },
          { role: "assistant", content: [{ type: "text", text: "answer" }] },
          { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
        ],
      }),
      opts()
    );
    assert.deepEqual(request.input, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "plain string" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }] },
    ]);
  });

  test("a tool call and its result become a function call and its output, ids kept", () => {
    const { request } = toResponsesRequest(
      body({
        messages: [
          { role: "user", content: "list files" },
          { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_01abc", name: "Bash", input: { command: "ls" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01abc", content: [{ type: "text", text: "a.txt" }] }, { type: "text", text: "<system-reminder>x</system-reminder>" }] },
        ],
      }),
      opts()
    );
    assert.deepEqual(request.input.slice(1), [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looking." }] },
      { type: "function_call", call_id: "toolu_01abc", name: "Bash", arguments: '{"command":"ls"}' },
      { type: "function_call_output", call_id: "toolu_01abc", output: "a.txt" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "<system-reminder>x</system-reminder>" }] },
    ]);
  });

  test("an empty tool result still says something", () => {
    const { request } = toResponsesRequest(body({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] }] }), opts());
    assert.deepEqual(request.input, [{ type: "function_call_output", call_id: "t1", output: "(no output)" }]);
  });

  test("images a tool returned follow in a message of their own", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const { request } = toResponsesRequest(
      body({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "screenshot" }, image] }] }] }),
      opts()
    );
    assert.deepEqual(request.input, [
      { type: "function_call_output", call_id: "t1", output: "screenshot" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "The tool calls above returned these:" }, { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" }] },
    ]);
  });

  test("images and documents the user attached go along", () => {
    const { request } = toResponsesRequest(
      body({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
              { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
              { type: "document", title: "notes", source: { type: "text", media_type: "text/plain", data: "remember this" } },
            ],
          },
        ],
      }),
      opts()
    );
    assert.deepEqual(request.input[0].content, [
      { type: "input_image", image_url: "https://example.com/a.png", detail: "auto" },
      { type: "input_file", filename: "spec.pdf", file_data: "data:application/pdf;base64,JVBERi0=" },
      { type: "input_text", text: "notes\n\nremember this" },
    ]);
  });

  test("GPT reasoning carried in a thinking block goes back as a reasoning item, without an id", () => {
    const { request } = toResponsesRequest(
      body({
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Weighing it up.", signature: `${REASONING_MARK}rs_123:ENCRYPTED==` },
              { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/a" } },
            ],
          },
        ],
      }),
      opts()
    );
    assert.deepEqual(request.input[1], { type: "reasoning", summary: [{ type: "summary_text", text: "Weighing it up." }], encrypted_content: "ENCRYPTED==" });
    assert.equal(request.input[2].type, "function_call");
  });

  test("a Claude model's thinking, and Anthropic's own tool blocks, are left out", () => {
    const { request } = toResponsesRequest(
      body({
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Claude's", signature: "EqQBCkYIBRgCKkB..." },
              { type: "redacted_thinking", data: "abc" },
              { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
              { type: "text", text: "done" },
            ],
          },
        ],
      }),
      opts()
    );
    assert.deepEqual(request.input[1], { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] });
    assert.equal(request.input.length, 2);
  });

  test("reasoning with nothing after it in its turn is dropped, as OpenAI wants it paired", () => {
    const { request } = toResponsesRequest(
      body({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "thinking", thinking: "", signature: `${REASONING_MARK}rs_1:ENC` }] }] }),
      opts()
    );
    assert.deepEqual(request.input.map((i) => i.type), ["message"]);
  });
});

describe("tools", () => {
  const tools = [
    { name: "Bash", description: "Run a command", input_schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { command: { type: "string" } } } },
    { name: "DeferredToolPlaceholder", description: "never call", input_schema: { type: "object", properties: {} }, defer_loading: true },
    { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    { name: "mcp__server.with.dots__a_rather_long_tool_name_that_goes_on_and_on_and_on", description: "d", input_schema: { type: "object" } },
  ];

  test("Claude Code's tools become functions; not-yet-loaded and server-side tools are left out", () => {
    const { request } = toResponsesRequest(body({ tools }), opts());
    assert.equal(request.tools.length, 2);
    assert.deepEqual(request.tools[0], {
      type: "function",
      name: "Bash",
      description: "Run a command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      strict: false,
    });
  });

  test("a name OpenAI would refuse is shortened, the same way every time, and maps back", () => {
    const first = toResponsesRequest(body({ tools }), opts());
    const second = toResponsesRequest(body({ tools }), opts());
    const sent = first.request.tools[1].name;
    assert.match(sent, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(second.request.tools[1].name, sent);
    assert.equal(first.names.original(sent), tools[3].name);
    assert.equal(first.names.original("Bash"), "Bash");
  });

  test("the history's calls to such a tool use the same shortened name", () => {
    const { request } = toResponsesRequest(
      body({ tools, messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: tools[3].name, input: {} }] }] }),
      opts()
    );
    assert.equal(request.input[1].name, request.tools[1].name);
  });

  test("tool choice maps across, and so does turning off parallel calls", () => {
    const pick = (tool_choice) => toResponsesRequest(body({ tools, tool_choice }), opts()).request;
    assert.equal(pick({ type: "auto" }).tool_choice, "auto");
    assert.equal(pick({ type: "any" }).tool_choice, "required");
    assert.equal(pick({ type: "none" }).tool_choice, "none");
    assert.deepEqual(pick({ type: "tool", name: "Bash" }).tool_choice, { type: "function", name: "Bash" });
    assert.equal(pick({ type: "auto", disable_parallel_tool_use: true }).parallel_tool_calls, false);
    assert.equal("parallel_tool_calls" in pick({ type: "auto" }), false);
  });

  test("no tools, no tool fields", () => {
    const { request } = toResponsesRequest(body({ tool_choice: { type: "auto" } }), opts());
    assert.equal("tools" in request, false);
    assert.equal("tool_choice" in request, false);
  });

  test("a structured-output request becomes a JSON schema text format", () => {
    const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };
    const { request } = toResponsesRequest(body({ thinking: { type: "disabled" }, output_config: { effort: "high", format: { type: "json_schema", schema } } }), opts());
    assert.deepEqual(request.text, { format: { type: "json_schema", name: "output", schema, strict: false } });
  });
});

describe("the answer", () => {
  const usage = { input_tokens: 9000, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 1000 }, output_tokens: 120 };

  test("a text answer becomes message_start, one text block and message_stop", () => {
    const { t, types, emitted } = run([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hel" },
      { type: "response.metadata", metadata: {} },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "lo" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "Hello" },
      { type: "response.content_part.done", output_index: 0, content_index: 0 },
      { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
      { type: "response.completed", response: { id: "resp_1", output: [], usage } },
    ]);
    assert.deepEqual(types, ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    assert.equal(emitted[0].data.message.model, "gpt-6.1-sol");
    assert.deepEqual(t.message.content, [{ type: "text", text: "Hello" }]);
    assert.equal(t.message.stop_reason, "end_turn");
    assert.deepEqual(emitted[5].data.usage, { input_tokens: 4000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 4000, output_tokens: 120 });
  });

  test("reasoning becomes a thinking block whose signature carries the encrypted reasoning", () => {
    const { t, emitted } = run([
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_9", summary: [] } },
      { type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 0 },
      { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "First." },
      { type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 1 },
      { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 1, delta: "Second." },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_9", encrypted_content: "BLOB" } },
      { type: "response.completed", response: { usage } },
    ]);
    assert.deepEqual(t.message.content, [{ type: "thinking", thinking: "First.\n\nSecond.", signature: `${REASONING_MARK}rs_9:BLOB` }]);
    assert.equal(emitted[1].data.content_block.type, "thinking");
    // And it round-trips: what comes back is what the next request sends.
    const next = toResponsesRequest(body({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: [...t.message.content, { type: "text", text: "a" }] }] }), opts());
    assert.equal(next.request.input[1].encrypted_content, "BLOB");
  });

  test("a function call becomes a tool_use block under its original name, and the turn stops for it", () => {
    const names = { original: (n) => (n === "short_abc" ? "a.long.name" : n) };
    const { t, emitted } = run(
      [
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "short_abc", arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"command":' },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: '"ls"}' },
        { type: "response.function_call_arguments.done", output_index: 0, arguments: '{"command":"ls"}' },
        { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "short_abc", arguments: '{"command":"ls"}' } },
        { type: "response.completed", response: { usage } },
      ],
      { names }
    );
    assert.deepEqual(t.message.content, [{ type: "tool_use", id: "call_1", name: "a.long.name", input: { command: "ls" } }]);
    assert.equal(t.message.stop_reason, "tool_use");
    const deltas = emitted.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.partial_json);
    assert.deepEqual(deltas, ['{"command":', '"ls"}'], "the arguments stream as they arrive, once");
  });

  test("arguments that only arrive with the finished call are still sent", () => {
    const { t } = run([
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_2", name: "Read", arguments: '{"file_path":"/x"}' } },
      { type: "response.completed", response: { usage } },
    ]);
    assert.deepEqual(t.message.content, [{ type: "tool_use", id: "call_2", name: "Read", input: { file_path: "/x" } }]);
  });

  test("a call with no arguments gets an empty object", () => {
    const { t } = run([
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_3", name: "Now", arguments: "" } },
      { type: "response.completed", response: { usage } },
    ]);
    assert.deepEqual(t.message.content[0].input, {});
  });

  test("an answer cut short by its token limit stops as max_tokens", () => {
    const { t } = run([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" },
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage } },
    ]);
    assert.equal(t.message.stop_reason, "max_tokens");
    assert.deepEqual(t.message.content, [{ type: "text", text: "partial" }]);
  });

  test("a failure mid-stream becomes an error event", () => {
    const { types, emitted, t } = run([
      { type: "response.created", response: {} },
      { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } },
    ]);
    assert.deepEqual(types, ["message_start", "error"]);
    assert.equal(emitted[1].data.error.type, "rate_limit_error");
    assert.match(emitted[1].data.error.message, /chatgpt\.com\/settings\/usage/);
    assert.ok(t.done && t.error);
  });

  test("nothing is handled after the end", () => {
    const { types } = run([
      { type: "response.completed", response: { usage } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "late" },
    ]);
    assert.deepEqual(types, ["message_start", "message_delta", "message_stop"]);
  });

  test("usage with no details is plain input and output", () => {
    assert.deepEqual(toUsage({ input_tokens: 10, output_tokens: 2 }), { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 });
    assert.deepEqual(toUsage(undefined), { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
  });
});

describe("errors", () => {
  const err = (status, code, message = "m", param = null) => toAnthropicError(status, JSON.stringify({ error: { code, message, param } }));

  test("the plan's usage limit: 429, not retried, and where to manage it", () => {
    const e = err(429, "subscription_sharing_usage_limit_exceeded");
    assert.equal(e.status, 429);
    assert.equal(e.error.type, "rate_limit_error");
    assert.equal(e.retry, false);
    assert.match(e.error.message, /https:\/\/chatgpt\.com\/settings\/usage/);
  });

  test("not eligible: 403, not retried", () => {
    const e = err(403, "subscription_sharing_user_not_eligible");
    assert.deepEqual([e.status, e.error.type, e.retry], [403, "permission_error", false]);
  });

  test("usage could not be checked: retried, as overloaded", () => {
    const e = err(503, "subscription_sharing_usage_unavailable");
    assert.deepEqual([e.status, e.error.type, e.retry], [529, "overloaded_error", true]);
  });

  test("an unsupported capability names the field", () => {
    const e = err(400, "subscription_sharing_unsupported_capability", "nope", "prompt_cache_key");
    assert.equal(e.status, 400);
    assert.equal(e.param, "prompt_cache_key");
    assert.match(e.error.message, /prompt_cache_key/);
  });

  test("a context overflow reads the way Claude Code compacts on", () => {
    const e = err(400, "context_length_exceeded", "Your input exceeds the context window");
    assert.match(e.error.message, /^prompt is too long/);
  });

  test("a rejected sign-in never comes back as 401, which Claude Code would blame on its own login", () => {
    const e = toAnthropicError(401, JSON.stringify({ error: { code: "invalid_api_key", message: "bad" } }));
    assert.equal(e.status, 403);
    assert.match(e.error.message, /ccc gpt login/);
    assert.equal(err(401, "subscription_sharing_invalid_user").status, 403);
  });

  test("server errors are retried; other client errors are not", () => {
    assert.deepEqual([err(500, "server_error").status, err(500, "server_error").retry], [529, true]);
    assert.deepEqual([err(502, "").error.type, err(502, "").retry], ["overloaded_error", true]);
    assert.equal(err(404, "model_not_found").status, 404);
    assert.equal(err(422, "x").retry, false);
  });

  test("a {detail} body and a body that is not JSON both read sensibly", () => {
    assert.match(toAnthropicError(403, JSON.stringify({ detail: "region blocked" })).error.message, /region blocked/);
    assert.match(toAnthropicError(502, "<html>bad gateway</html>").error.message, /bad gateway/);
  });
});

test("token counts are estimated from the size of the request", () => {
  const n = estimateTokens({ system: "x".repeat(400), messages: [], tools: [] });
  assert.ok(n > 90 && n < 130, `got ${n}`);
});
