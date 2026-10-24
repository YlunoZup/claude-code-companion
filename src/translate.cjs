"use strict";

// translate.cjs — between Claude Code and the GPT models.
//
// Claude Code speaks Anthropic's Messages API; OpenAI's models speak the
// Responses API. The router (router.cjs) uses this file to turn a Messages
// request into a Responses request, and the Responses event stream that comes
// back into the Messages event stream Claude Code expects.
//
// Everything here is plain data in, plain data out, so it is all testable
// without a network.

const crypto = require("crypto");

// The signature on a thinking block that carries a GPT model's reasoning.
//
// With nothing stored on OpenAI's side, a model keeps its train of thought
// across turns only if its encrypted reasoning is sent back with the next
// request. Claude Code keeps thinking blocks in the conversation and returns
// them untouched, so that is where it travels: "ccc-gpt1:<id>:<encrypted>".
// Anthropic would reject such a block as forged, so the router strips them
// from any request bound for a Claude model.
const REASONING_MARK = "ccc-gpt1:";

// Reasoning efforts OpenAI's models accept, weakest first.
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// System prompt blocks Claude Code adds for Anthropic's billing, which mean
// nothing to another model.
const BILLING_HEADER = /^x-anthropic-billing-header:/;

const USAGE_URL = "https://chatgpt.com/settings/usage";

// ── Names ────────────────────────────────────────────────────

// OpenAI takes function names of 1–64 letters, digits, _ and -. Anthropic
// allows longer ones, and an MCP server can produce them. Such a name is sent
// as a shortened one with a hash of the original, the same every time, so the
// tool calls in the history keep matching.
function toolNamer(tools) {
  const toWire = new Map();
  const toOriginal = new Map();
  const wire = (name) => {
    const key = String(name);
    if (toWire.has(key)) return toWire.get(key);
    let sent = key;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
      const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
      sent = `${key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 55)}_${hash}`;
    }
    toWire.set(key, sent);
    toOriginal.set(sent, key);
    return sent;
  };
  for (const tool of tools || []) if (tool && tool.name) wire(tool.name);
  return { wire, original: (sent) => toOriginal.get(sent) || sent };
}

// ── Effort ───────────────────────────────────────────────────

// The nearest effort the model offers at or below the one asked for, or its
// weakest when it offers nothing that low. With no list to go by, the request
// passes as it is.
function clampEffort(wanted, supported) {
  if (!supported || supported.length === 0) return wanted;
  if (supported.includes(wanted)) return wanted;
  const rank = EFFORTS.indexOf(wanted);
  const known = supported.filter((e) => EFFORTS.includes(e)).sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  if (known.length === 0) return wanted;
  const below = known.filter((e) => EFFORTS.indexOf(e) <= rank);
  return below.length ? below[below.length - 1] : known[0];
}

// What Claude Code asked for, in OpenAI's terms. Its effort setting maps across
// directly. Thinking turned off — which is how it makes small background
// requests such as a session title — becomes the weakest effort, since GPT
// models cannot skip reasoning altogether. An older-style thinking budget
// becomes the effort nearest its size.
function chooseEffort(body, supported) {
  const thinking = body.thinking || {};
  if (thinking.type === "disabled") {
    return clampEffort("low", supported);
  }
  let wanted = body.output_config && typeof body.output_config.effort === "string" ? body.output_config.effort : null;
  if (!wanted && thinking.type === "enabled" && typeof thinking.budget_tokens === "number") {
    const budget = thinking.budget_tokens;
    wanted = budget < 4000 ? "low" : budget < 16000 ? "medium" : budget < 32000 ? "high" : "xhigh";
  }
  if (!wanted || !EFFORTS.includes(wanted)) wanted = "medium";
  return clampEffort(wanted, supported);
}

// ── Content ──────────────────────────────────────────────────

function imagePart(block) {
  const source = block.source || {};
  if (source.type === "base64" && source.data) {
    return { type: "input_image", image_url: `data:${source.media_type || "image/png"};base64,${source.data}`, detail: "auto" };
  }
  if (source.type === "url" && source.url) return { type: "input_image", image_url: source.url, detail: "auto" };
  return null;
}

function documentPart(block) {
  const source = block.source || {};
  const title = block.title ? `${block.title}\n\n` : "";
  if (source.type === "text" && typeof source.data === "string") return { type: "input_text", text: title + source.data };
  if (source.type === "content" && Array.isArray(source.content)) {
    const text = source.content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
    return { type: "input_text", text: title + text };
  }
  if (source.type === "base64" && source.data) {
    const name = block.title ? String(block.title).replace(/[^\w.-]+/g, "_").slice(0, 60) : "document";
    const ext = source.media_type === "application/pdf" && !/\.pdf$/i.test(name) ? ".pdf" : "";
    return { type: "input_file", filename: name + ext, file_data: `data:${source.media_type || "application/pdf"};base64,${source.data}` };
  }
  if (source.type === "url" && source.url) return { type: "input_text", text: `${title}Document: ${source.url}` };
  return null;
}

// A tool result as the text the model reads, plus any images or files it
// returned, which OpenAI takes only in a message of their own.
function toolResultParts(content) {
  if (typeof content === "string") return { text: content, media: [] };
  const texts = [];
  const media = [];
  for (const block of content || []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") texts.push(block.text);
    else if (block.type === "image") {
      const part = imagePart(block);
      if (part) media.push(part);
    } else if (block.type === "document") {
      const part = documentPart(block);
      if (part && part.type === "input_text") texts.push(part.text);
      else if (part) media.push(part);
    } else if (block.type === "tool_reference") texts.push(`Tool ${block.tool_name} is loaded and can be called now.`);
    else if (block.type === "search_result") {
      const body = (block.content || []).filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
      texts.push([block.title, block.source, body].filter(Boolean).join("\n"));
    }
  }
  return { text: texts.join("\n"), media };
}

// The parts of a thinking block that carries GPT reasoning, or null.
function parseReasoning(block) {
  if (!block || block.type !== "thinking" || typeof block.signature !== "string") return null;
  if (!block.signature.startsWith(REASONING_MARK)) return null;
  const rest = block.signature.slice(REASONING_MARK.length);
  const colon = rest.indexOf(":");
  const id = colon >= 0 ? rest.slice(0, colon) : "";
  const encrypted = colon >= 0 ? rest.slice(colon + 1) : rest;
  return { id, encrypted, summary: typeof block.thinking === "string" ? block.thinking : "" };
}

function isGptReasoning(block) {
  return parseReasoning(block) !== null;
}

// Claude Code's conversation as Responses input items, in order. Thinking from
// a Claude model and Anthropic's own server-side tool blocks have no meaning to
// another model and are left out.
function toInput(messages, wireName) {
  const input = [];
  for (const message of messages || []) {
    if (!message || typeof message !== "object") continue;
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content || [];

    if (message.role === "assistant") {
      let parts = [];
      const flush = () => {
        if (parts.length) input.push({ type: "message", role: "assistant", content: parts });
        parts = [];
      };
      const start = input.length;
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text") {
          if (block.text) parts.push({ type: "output_text", text: block.text });
        } else if (block.type === "tool_use") {
          flush();
          input.push({
            type: "function_call",
            call_id: block.id,
            name: wireName(block.name),
            arguments: JSON.stringify(block.input === undefined ? {} : block.input),
          });
        } else if (block.type === "thinking") {
          const reasoning = parseReasoning(block);
          if (!reasoning || !reasoning.encrypted) continue;
          flush();
          input.push({
            type: "reasoning",
            summary: reasoning.summary ? [{ type: "summary_text", text: reasoning.summary }] : [],
            encrypted_content: reasoning.encrypted,
          });
        }
      }
      flush();
      // Reasoning has to be followed by what it produced; a turn that ended
      // on reasoning alone has nothing to pair it with.
      while (input.length > start && input[input.length - 1].type === "reasoning") input.pop();
      continue;
    }

    // A user turn: tool results, then whatever Claude Code adds after them.
    let parts = [];
    const media = [];
    const flush = () => {
      if (parts.length) input.push({ type: "message", role: "user", content: parts });
      parts = [];
    };
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_result") {
        flush();
        const result = toolResultParts(block.content);
        input.push({ type: "function_call_output", call_id: block.tool_use_id, output: result.text || "(no output)" });
        media.push(...result.media);
      } else if (block.type === "text") {
        if (block.text) parts.push({ type: "input_text", text: block.text });
      } else if (block.type === "image") {
        const part = imagePart(block);
        if (part) parts.push(part);
      } else if (block.type === "document") {
        const part = documentPart(block);
        if (part) parts.push(part);
      }
    }
    flush();
    if (media.length) {
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "The tool calls above returned these:" }, ...media] });
    }
  }
  return input;
}

// ── Tools ────────────────────────────────────────────────────

const isWebSearch = (tool) => Boolean(tool && typeof tool.type === "string" && /^web_search/.test(tool.type));

// The deferred tools ToolSearch has loaded in this conversation. Claude Code
// marks them as loaded by the tool_reference blocks ToolSearch returns, and
// from then on sends them with defer_loading still set, leaving it to
// Anthropic's servers to make them callable — here that falls to the router.
function loadedTools(messages) {
  const loaded = new Set();
  for (const message of messages || []) {
    if (!message || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      for (const inner of block.content) if (inner && inner.type === "tool_reference" && inner.tool_name) loaded.add(String(inner.tool_name));
    }
  }
  return loaded;
}

function toTools(tools, wireName, { loaded = new Set() } = {}) {
  const out = [];
  let search = false;
  for (const tool of tools || []) {
    if (!tool || typeof tool !== "object" || !tool.name) continue;
    // Anthropic's web search becomes OpenAI's: Claude Code's WebSearch tool
    // asks the session's model to run it, and builds its results from what
    // comes back.
    if (isWebSearch(tool)) {
      if (!search) out.push({ type: "web_search" });
      search = true;
      continue;
    }
    // Anthropic's other server-side tools (code execution and the like) run on
    // Anthropic's servers and cannot be offered to another model.
    if (tool.type && tool.type !== "custom") continue;
    // A deferred tool counts once ToolSearch has loaded it.
    if (tool.defer_loading && !loaded.has(tool.name)) continue;
    const parameters = tool.input_schema && typeof tool.input_schema === "object" ? { ...tool.input_schema } : { type: "object", properties: {} };
    delete parameters.$schema;
    if (!parameters.type) parameters.type = "object";
    out.push({ type: "function", name: wireName(tool.name), description: tool.description || "", parameters, strict: false });
  }
  return out;
}

function toToolChoice(choice, wireName, tools) {
  if (!choice || typeof choice !== "object") return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) {
    const named = (tools || []).find((t) => t && t.name === choice.name);
    return isWebSearch(named) ? { type: "web_search" } : { type: "function", name: wireName(choice.name) };
  }
  return undefined;
}

// ── Instructions ─────────────────────────────────────────────

// Claude Code's system prompt, with a note in front so the model knows where it
// is. The prompt itself says it is Claude Code; Claude Code also tells the
// model which model it is, and the note keeps the two from reading as a claim
// to be Claude.
function toInstructions(system, { model, displayName }) {
  const name = displayName || model;
  const note =
    `You are ${name} (${model}), an OpenAI model, running inside Claude Code, Anthropic's command-line coding agent, ` +
    `through the user's ChatGPT plan. The instructions below were written for Claude models: follow them as written, ` +
    `and if asked which model you are, say ${name}.`;
  const blocks = typeof system === "string" ? [{ type: "text", text: system }] : Array.isArray(system) ? system : [];
  const texts = blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string" && b.text.trim() && !BILLING_HEADER.test(b.text.trim()))
    .map((b) => b.text);
  return [note, ...texts].join("\n\n");
}

// ── The request ──────────────────────────────────────────────

// A stable key for OpenAI's prompt cache, so the turns of one session reuse
// what the previous turn already sent. Derived from Claude Code's session id;
// nothing identifying leaves the machine.
function cacheKeyFor(body) {
  const raw = body && body.metadata && body.metadata.user_id;
  if (typeof raw !== "string" || !raw) return undefined;
  let session = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.session_id) session = String(parsed.session_id);
  } catch {}
  return `ccc-${crypto.createHash("sha256").update(session).digest("hex").slice(0, 32)}`;
}

// A Messages request as a Responses request.
//
//   opts.model        the GPT model to ask
//   opts.displayName  its name, for the note in front of the instructions
//   opts.efforts      the efforts it accepts, if known
//   opts.omit         optional fields to leave out, because the endpoint
//                     refused them earlier: "reasoning.summary", "include",
//                     "prompt_cache_key", "parallel_tool_calls", "text"
//
// Returns { request, names }, names being what translates tool names back.
function toResponsesRequest(body, opts) {
  const { model, displayName, efforts, omit = new Set() } = opts;
  const names = toolNamer(body.tools);
  const request = {
    model,
    instructions: toInstructions(body.system, { model, displayName }),
    input: toInput(body.messages, names.wire),
    store: false,
    stream: true,
  };

  const tools = toTools(body.tools, names.wire, { loaded: loadedTools(body.messages) });
  if (tools.length) {
    request.tools = tools;
    const choice = toToolChoice(body.tool_choice, names.wire, body.tools);
    if (choice !== undefined) request.tool_choice = choice;
    if (body.tool_choice && body.tool_choice.disable_parallel_tool_use && !omit.has("parallel_tool_calls")) {
      request.parallel_tool_calls = false;
    }
  }

  request.reasoning = { effort: chooseEffort(body, efforts) };
  const thinking = body.thinking || {};
  if (thinking.type !== "disabled" && thinking.display !== "omitted" && !omit.has("reasoning.summary")) {
    request.reasoning.summary = "auto";
  }
  if (!omit.has("include")) {
    request.include = ["reasoning.encrypted_content"];
    // The pages a search read, for the results Claude Code lists.
    if (tools.some((t) => t.type === "web_search")) request.include.push("web_search_call.action.sources");
  }

  const format = body.output_config && body.output_config.format;
  if (format && format.type === "json_schema" && format.schema && !omit.has("text")) {
    request.text = { format: { type: "json_schema", name: "output", schema: format.schema, strict: false } };
  }

  const cacheKey = cacheKeyFor(body);
  if (cacheKey && !omit.has("prompt_cache_key")) request.prompt_cache_key = cacheKey;

  return { request, names };
}

// ── The answer ───────────────────────────────────────────────

// OpenAI counts cached and cache-written tokens inside input_tokens; Anthropic
// counts them apart, which is how Claude Code adds them up.
// Whether a Messages request asked for thinking, as Anthropic decides it.
function wantsThinking(body) {
  const thinking = body && body.thinking;
  return Boolean(thinking && typeof thinking === "object" && thinking.type && thinking.type !== "disabled");
}

function toUsage(usage) {
  const u = usage || {};
  const details = u.input_tokens_details || {};
  const cached = details.cached_tokens || 0;
  const written = details.cache_write_tokens || 0;
  return {
    input_tokens: Math.max(0, (u.input_tokens || 0) - cached - written),
    cache_creation_input_tokens: written,
    cache_read_input_tokens: cached,
    output_tokens: u.output_tokens || 0,
  };
}

// Turns Responses stream events into Messages stream events, as they arrive.
//
// emit(event, data) receives each Messages event. The finished message is kept
// as well, for a caller that asked for no streaming.
//   thinking  whether the request asked for thinking. Anthropic sends no
//             thinking blocks when it did not, and some of Claude Code's own
//             requests — auto mode's safety check among them — read the first
//             block of the answer as its text.
//   stops     the request's stop sequences, which OpenAI has no field for: the
//             text ends just before the first one, and the answer stops
//             there, as Anthropic's would
class StreamTranslator {
  constructor({ model, names, messageId, emit, thinking = true, stops = [] }) {
    this.model = model;
    this.thinking = thinking;
    this.stops = stops;
    this.names = names || { original: (n) => n };
    this.emit = emit || (() => {});
    this.message = {
      id: messageId || `msg_ccc_${crypto.randomBytes(12).toString("hex")}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    this.started = false;
    this.done = false;
    this.error = null;
    this.open = new Map(); // key -> { index, kind }
    this.next = 0;
    this.sawToolUse = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const { content, ...rest } = this.message;
    this.emit("message_start", { type: "message_start", message: { ...rest, content: [] } });
  }

  openBlock(key, block) {
    const index = this.next++;
    this.open.set(key, { index, kind: block.type, args: "", sentArgs: false });
    this.message.content[index] = JSON.parse(JSON.stringify(block));
    this.emit("content_block_start", { type: "content_block_start", index, content_block: block });
    return this.open.get(key);
  }

  delta(key, delta) {
    const state = this.open.get(key);
    if (!state) return;
    const block = this.message.content[state.index];
    if (delta.type === "text_delta") block.text += delta.text;
    else if (delta.type === "thinking_delta") block.thinking += delta.thinking;
    else if (delta.type === "signature_delta") block.signature = delta.signature;
    else if (delta.type === "input_json_delta") state.args += delta.partial_json;
    this.emit("content_block_delta", { type: "content_block_delta", index: state.index, delta });
  }

  closeBlock(key) {
    const state = this.open.get(key);
    if (!state) return;
    // Text held back as a possible stop sequence turned out not to be one.
    if (state.held) {
      const held = state.held;
      state.held = "";
      this.delta(key, { type: "text_delta", text: held });
    }
    if (state.kind === "tool_use" || state.kind === "server_tool_use") {
      let input = {};
      try {
        input = state.args ? JSON.parse(state.args) : {};
      } catch {}
      this.message.content[state.index].input = input;
    }
    this.open.delete(key);
    this.emit("content_block_stop", { type: "content_block_stop", index: state.index });
  }

  closeAll() {
    for (const key of [...this.open.keys()]) this.closeBlock(key);
  }

  finish(stopReason, usage, stopSequence = null) {
    if (this.done) return;
    this.start();
    this.closeAll();
    this.done = true;
    this.message.stop_reason = stopReason;
    this.message.stop_sequence = stopSequence;
    this.message.usage = toUsage(usage);
    this.emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: stopSequence },
      usage: this.message.usage,
    });
    this.emit("message_stop", { type: "message_stop" });
  }

  fail(error) {
    if (this.done) return;
    this.done = true;
    this.error = error;
    this.emit("error", { type: "error", error: { type: error.type, message: error.message } });
  }

  // Text as it arrives, cut short at a stop sequence. A sequence can straddle
  // two deltas, so text that could be the start of one is held back until the
  // next delta settles it.
  textDelta(key, text) {
    if (!this.stops.length) {
      this.delta(key, { type: "text_delta", text });
      return;
    }
    const state = this.open.get(key);
    const sent = this.message.content[state.index].text;
    const all = sent + (state.held || "") + text;
    let cut = -1;
    let hit = null;
    for (const stop of this.stops) {
      const at = all.indexOf(stop);
      if (at >= 0 && (cut < 0 || at < cut)) {
        cut = at;
        hit = stop;
      }
    }
    if (hit !== null) {
      state.held = "";
      const keep = all.slice(sent.length, cut);
      if (keep) this.delta(key, { type: "text_delta", text: keep });
      this.finish("stop_sequence", null, hit);
      return;
    }
    let hold = 0;
    for (const stop of this.stops) {
      for (let n = Math.min(stop.length - 1, all.length - sent.length); n > hold; n--) {
        if (stop.startsWith(all.slice(all.length - n))) {
          hold = n;
          break;
        }
      }
    }
    state.held = all.slice(all.length - hold);
    const ready = all.slice(sent.length, all.length - hold);
    if (ready) this.delta(key, { type: "text_delta", text: ready });
  }

  // A search OpenAI ran, as the pair of blocks Anthropic's web search gives:
  // what was searched for, then the pages found. Claude Code's WebSearch tool
  // lists those pages as the search's links.
  webSearch(item, outputIndex) {
    this.start();
    const action = item.action || {};
    const query = action.query || (Array.isArray(action.queries) && action.queries[0]) || "";
    const id = `srvtoolu_${String(item.id || outputIndex).replace(/^ws_/, "")}`;
    const call = `${outputIndex}:search`;
    this.openBlock(call, { type: "server_tool_use", id, name: "web_search", input: {} });
    this.delta(call, { type: "input_json_delta", partial_json: JSON.stringify({ query }) });
    this.closeBlock(call);

    const seen = new Set();
    const results = [];
    for (const source of action.sources || []) {
      const url = source && source.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      results.push({ type: "web_search_result", url, title: source.title || url, encrypted_content: "", page_age: null });
      if (results.length === 10) break;
    }
    const found = `${outputIndex}:results`;
    this.openBlock(found, { type: "web_search_tool_result", tool_use_id: id, content: results });
    this.closeBlock(found);
  }

  // One Responses event.
  handle(event) {
    if (this.done || !event || typeof event !== "object") return;
    const type = event.type;
    const item = event.item || {};
    const at = (suffix) => `${event.output_index}:${suffix}`;

    switch (type) {
      case "response.created":
      case "response.in_progress":
        this.start();
        return;

      case "response.output_item.added":
        this.start();
        if (item.type === "reasoning" && !this.thinking) return;
        if (item.type === "reasoning") {
          this.openBlock(at("reasoning"), { type: "thinking", thinking: "", signature: "" });
        } else if (item.type === "function_call") {
          this.sawToolUse = true;
          this.openBlock(at("call"), { type: "tool_use", id: item.call_id || item.id, name: this.names.original(item.name), input: {} });
          if (item.arguments) {
            this.open.get(at("call")).sentArgs = true;
            this.delta(at("call"), { type: "input_json_delta", partial_json: item.arguments });
          }
        }
        return;

      case "response.reasoning_summary_part.added":
        // Parts after the first are new paragraphs of the same reasoning.
        if (event.summary_index > 0) this.delta(at("reasoning"), { type: "thinking_delta", thinking: "\n\n" });
        return;

      case "response.reasoning_summary_text.delta":
        if (event.delta) this.delta(at("reasoning"), { type: "thinking_delta", thinking: event.delta });
        return;

      case "response.content_part.added":
        this.start();
        if (event.part && (event.part.type === "output_text" || event.part.type === "refusal")) {
          this.openBlock(at(`text:${event.content_index}`), { type: "text", text: "" });
        }
        return;

      case "response.output_text.delta":
      case "response.refusal.delta": {
        const key = at(`text:${event.content_index}`);
        if (!this.open.has(key)) {
          this.start();
          this.openBlock(key, { type: "text", text: "" });
        }
        if (event.delta) this.textDelta(key, event.delta);
        return;
      }

      case "response.content_part.done":
        this.closeBlock(at(`text:${event.content_index}`));
        return;

      case "response.function_call_arguments.delta": {
        const state = this.open.get(at("call"));
        if (state && event.delta) {
          state.sentArgs = true;
          this.delta(at("call"), { type: "input_json_delta", partial_json: event.delta });
        }
        return;
      }

      case "response.output_item.done":
        if (item.type === "reasoning" && !this.thinking) return;
        if (item.type === "reasoning") {
          const key = at("reasoning");
          if (!this.open.has(key)) this.openBlock(key, { type: "thinking", thinking: "", signature: "" });
          this.delta(key, { type: "signature_delta", signature: `${REASONING_MARK}${item.id || ""}:${item.encrypted_content || ""}` });
          this.closeBlock(key);
        } else if (item.type === "function_call") {
          const key = at("call");
          if (!this.open.has(key)) {
            this.sawToolUse = true;
            this.openBlock(key, { type: "tool_use", id: item.call_id || item.id, name: this.names.original(item.name), input: {} });
          }
          const state = this.open.get(key);
          if (!state.sentArgs) this.delta(key, { type: "input_json_delta", partial_json: item.arguments || "{}" });
          this.closeBlock(key);
        } else if (item.type === "message") {
          for (const key of [...this.open.keys()]) if (key.startsWith(`${event.output_index}:text:`)) this.closeBlock(key);
        } else if (item.type === "web_search_call") {
          this.webSearch(item, event.output_index);
        }
        return;

      case "response.completed": {
        const response = event.response || {};
        this.finish(this.sawToolUse ? "tool_use" : "end_turn", response.usage);
        return;
      }

      case "response.incomplete": {
        const response = event.response || {};
        const reason = response.incomplete_details && response.incomplete_details.reason;
        const stop = reason === "max_output_tokens" ? "max_tokens" : reason === "content_filter" ? "refusal" : this.sawToolUse ? "tool_use" : "end_turn";
        this.finish(stop, response.usage);
        return;
      }

      case "response.failed": {
        const response = event.response || {};
        this.fail(toAnthropicError(200, JSON.stringify({ error: response.error || {} })).error);
        return;
      }

      case "error":
        this.fail(toAnthropicError(200, JSON.stringify({ error: event.error || event })).error);
        return;

      default:
    }
  }
}

// ── Errors ───────────────────────────────────────────────────

// An OpenAI error, as Claude Code should see it: a status, an Anthropic error
// type, a sentence that says what to do, and whether retrying can help.
// Claude Code retries what the x-should-retry header allows, so a usage limit
// or a refusal is marked not to be retried.
function toAnthropicError(status, bodyText) {
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {}
  const err = (parsed && typeof parsed.error === "object" && parsed.error) || {};
  const code = String(err.code || (parsed && parsed.code) || "");
  const detail = String(err.message || (parsed && parsed.detail) || (bodyText || "").slice(0, 300) || `HTTP ${status}`);
  const param = err.param ? ` (${err.param})` : "";

  const result = (httpStatus, type, message, retry) => ({ status: httpStatus, retry, error: { type, message }, code, param: err.param || null });

  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return result(429, "rate_limit_error", `ChatGPT: the usage limit for ccc on your ChatGPT plan was reached. Manage usage: ${USAGE_URL}`, false);
    case "subscription_sharing_user_not_eligible":
      return result(403, "permission_error", `ChatGPT: plan usage is not available for this ChatGPT account or workspace. ${detail}`, false);
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return result(529, "overloaded_error", `ChatGPT: your plan's usage could not be checked just now. ${detail}`, true);
    case "subscription_sharing_unsupported_capability":
      return result(400, "invalid_request_error", `ChatGPT: this request used something plan usage does not support${param}. ${detail}`, false);
    case "subscription_sharing_route_not_supported":
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return result(403, "permission_error", `ChatGPT: ${detail}`, false);
    case "subscription_sharing_invalid_user":
      return result(403, "permission_error", `ChatGPT: the sign-in was not accepted. Sign in again with: ccc gpt login`, false);
    case "context_length_exceeded":
      // Claude Code compacts the conversation when it reads this phrase.
      return result(400, "invalid_request_error", `prompt is too long: ${detail}`, false);
    default:
  }

  if (status === 401) return result(403, "permission_error", "ChatGPT: the sign-in was not accepted. Sign in again with: ccc gpt login", false);
  if (status === 403) return result(403, "permission_error", `ChatGPT: ${detail}`, false);
  if (status === 404) return result(404, "not_found_error", `ChatGPT: ${detail}`, false);
  if (status === 413) return result(413, "request_too_large", `ChatGPT: ${detail}`, false);
  if (status === 429) return result(429, "rate_limit_error", `ChatGPT: ${detail}`, true);
  if (status >= 500) return result(529, "overloaded_error", `ChatGPT: ${detail}`, true);
  if (status >= 400) return result(400, "invalid_request_error", `ChatGPT: ${detail}${param}`, false);
  // A failure reported inside a stream that opened fine.
  if (/context|too long|maximum context/i.test(detail) && /token/i.test(detail)) {
    return result(400, "invalid_request_error", `prompt is too long: ${detail}`, false);
  }
  return result(500, "api_error", `ChatGPT: ${detail}`, true);
}

// ── Counting ─────────────────────────────────────────────────

// Claude Code asks how many tokens a request would take. OpenAI has no such
// endpoint on this route, so this is an estimate at four characters a token —
// close enough for the gauge it feeds.
function estimateTokens(body) {
  const b = body || {};
  const text = JSON.stringify([b.system || "", b.messages || [], b.tools || []]);
  return Math.ceil(text.length / 4);
}

module.exports = {
  REASONING_MARK,
  EFFORTS,
  USAGE_URL,
  toolNamer,
  clampEffort,
  chooseEffort,
  toolResultParts,
  parseReasoning,
  isGptReasoning,
  toInput,
  loadedTools,
  toTools,
  toToolChoice,
  toInstructions,
  cacheKeyFor,
  toResponsesRequest,
  wantsThinking,
  toUsage,
  StreamTranslator,
  toAnthropicError,
  estimateTokens,
};
