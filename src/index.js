// dsh-tool-cordis-local — 独立于官方创造模式的 cordis 工具集(普通工具,宿主层挂载)。
//
// 为什么存在:
// 随部署附带的 `cordis` 预设(创造模式)是只读的,要改只能复制一份。但它的
// `@deepseek-ai/dsh-tool-cordis` 行会把自己的检查 provider 注册进进程级单例注册表
// cordisInspect,而那张注册表对重复 id 直接抛错;原件随部署常驻,复制品再挂同一行
// 就必然撞车,新会话创建时报 agent-preset/invalid —— 官方创造模式因此不可复制。
// 本插件把同一套能力改写成宿主层普通工具:挂一次对所有会话生效,不占注册表,
// 于是任意数量的 cordis 能力预设可以共存,原件照常可用。
//
// 设计约束:
// - 只用 node 内置模块与 ctx 注入面,不 import 任何 @deepseek-ai 包;
// - 检查实现全部活读运行时(ctx.reflect.store / ctx.tools.schemas),或自持清单;
// - 不向官方 cordisInspect 注册表注册任何 provider —— 这是与官方 dsh-tool-cordis
//   的关键差异:因此任意数量的 cordis 能力预设可以在同一进程共存,无注册冲突;
// - 动态插件执行面(dynamicCordisRunner)按会话键控,通过注入消费,属于框架正常组合。

const name = "dsh-tool-cordis-local";
const inject = ["tools", "systemPrompt", "dynamicCordisRunner", "cordisInspect"];

const SYSTEM_PROMPT = [
  "You have a self-contained Cordis toolset for reading and modifying the live runtime of this session.",
  "- cordis_inspect_list / cordis_inspect_query: inspect registered services (live reflection), a curated event directory, sandbox builtins, and your own tool catalog.",
  "- cordis_define: record an immutable Package (host and/or client half) owned by this session; it only records source, it does not execute anything.",
  "- cordis_run: activate one Package. An unauthorized client Package returns awaiting-approval — tell the user they must allow or reject it in the UI, and do not wait inside the tool.",
  "- cordis_stop / cordis_undefine: stop or permanently remove a Plugin owned by this session.",
  "Dynamic plugin code runs inside the harness process under a guarded context (ctx.tools.register / ctx.on / ctx.provide / ctx.effect / declared injects). Treat code you define and run as trusted, session-scoped automation.",
].join("\n");

// ---------- 通用小工具 ----------
function requireAgent(exec) {
  if (exec.agent === void 0) throw new Error("Cordis dynamic tools require an Agent-backed session");
  return exec.agent;
}
function jsonRender(_args, value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}
function requireJsonObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object");
  return value;
}
function requireJsonString(value, key) {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`expected JSON string field "${key}"`);
  return field;
}
function readOptionalString(input, field) {
  if (input === void 0 || input === null || Array.isArray(input) || typeof input !== "object") return void 0;
  const value = input[field];
  return typeof value === "string" ? value : void 0;
}

// ---------- 宿主面检查:自研实现(活读运行时) ----------
function liveServices(ctx) {
  const store = ctx.reflect.store;
  const out = [];
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key];
    if (!impl || typeof impl.name !== "string") continue;
    const methods = [];
    const value = impl.value;
    if (value !== null && value !== void 0 && (typeof value === "object" || typeof value === "function")) {
      const proto = Object.getPrototypeOf(value);
      for (const m of Object.getOwnPropertyNames(proto)) {
        if (m === "constructor") continue;
        try {
          if (typeof value[m] === "function") methods.push(m);
        } catch {
          /* hostile getter on the instance — skip */
        }
      }
    }
    out.push({ name: impl.name, methods: methods.sort() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// 事件目录:自持的精简清单(名字+一句摘要)。活运行时没有公开的事件名枚举面,
// 因此这是"声明清单"而非全量目录;查询未收录事件会得到明确提示。
const KNOWN_EVENTS = [
  { name: "turn/start", summary: "A model turn began." },
  { name: "turn/end", summary: "A model turn finished (reason: normal, interrupted, error)." },
  { name: "step/start", summary: "One agent step began." },
  { name: "step/end", summary: "One agent step finished." },
  { name: "user/message", summary: "A user message was recorded." },
  { name: "assistant/chunk", summary: "A streamed assistant chunk arrived." },
  { name: "assistant/message", summary: "A complete assistant message was recorded." },
  { name: "tool/call", summary: "The model invoked a tool (name, arguments, callId)." },
  { name: "tool/result", summary: "A tool call produced a result or error." },
  { name: "tool/code-dispatch-start", summary: "A code-dispatch program started." },
  { name: "tool/code-dispatch", summary: "A code-dispatch program produced work." },
  { name: "todo/write", summary: "The todo list was replaced." },
  { name: "request/header", summary: "A request epoch header was committed." },
  { name: "request/context", summary: "Request context was captured." },
  { name: "session/end-seed", summary: "The session's seed prefix ended." },
  { name: "session/title", summary: "The session title changed." },
  { name: "session/title-llm-request", summary: "A title-generation LLM request was made." },
  { name: "agent/inbox/spliced", summary: "Messages were spliced into the agent inbox." },
  { name: "command/run", summary: "A slash command ran." },
  { name: "command/done", summary: "A slash command finished." },
  { name: "approval/asked", summary: "An approval request was published." },
  { name: "approval/decided", summary: "An approval request was decided." },
  { name: "approval/policy", summary: "The approval policy changed." },
  { name: "approval/request", summary: "Approval dispatch interception (allow/deny/ask)." },
  { name: "goal/change", summary: "A goal was created, edited, or changed state." },
  { name: "plan/mode", summary: "The plan-mode state changed." },
  { name: "compaction/start", summary: "Context compaction began." },
  { name: "compaction/summary", summary: "A compaction summary was produced." },
  { name: "compaction/prune", summary: "Tool results were pruned." },
  { name: "compaction/end", summary: "Context compaction finished." },
  { name: "llm/retry-started", summary: "An LLM retry attempt began." },
  { name: "llm/retry", summary: "An LLM retry outcome was recorded." },
  { name: "subagent/provider-added", summary: "A subagent provider became resolvable." },
  { name: "subagent/provider-removed", summary: "A subagent provider left the registry." },
  { name: "subagent/start", summary: "A subagent run was established." },
  { name: "subagent/end", summary: "A subagent run ended." },
  { name: "workflow/agent-start", summary: "A workflow agent run started." },
  { name: "workflow/agent-end", summary: "A workflow agent run ended." },
  { name: "workflow/run-start", summary: "A workflow run started." },
  { name: "workflow/run-end", summary: "A workflow run ended." },
  { name: "skill/catalog-changed", summary: "The skill catalog may have changed." },
  { name: "settings/change", summary: "A settings namespace changed." },
  { name: "cordis/inspect-query-resolved", summary: "A pending client inspect query was resolved." },
];

// 沙箱内建面:动态插件宿主半边可用的表面(与运行时的守卫面一致)。
const BUILTINS = [
  { id: "ctx.tools.register", summary: "Register a tool (schema + execute) for the current agent." },
  { id: "ctx.on", summary: "Subscribe to runtime events; dispatch is scope-filtered by the plugin's context." },
  { id: "ctx.provide", summary: "Publish a service instance under a name for the plugin's lifetime." },
  { id: "ctx.effect", summary: "Register teardown-safe side effects (disposers)." },
  { id: "inject", summary: "Declare service names the plugin consumes; resolved from the host plane." },
  { id: "timer", summary: "Timer helpers become available after injecting the timer service." },
];

function providerDirectory() {
  return [
    {
      platform: "host",
      id: "Service",
      description: "Live service directory read from the running runtime: every registered service name with its instance method names (live reflection; no build-time doc comments).",
      methods: [{
        name: "listService",
        description: "List every live service name with method names, or one exact service when input.service is given.",
        inputSchema: {
          type: "object",
          properties: { service: { type: "string", description: "Optional exact service name." } },
          additionalProperties: false,
        },
        outputSchema: {},
      }],
    },
    {
      platform: "host",
      id: "Event",
      description: "Curated directory of harness event names with one-line summaries. The live runtime exposes no public enumeration of event names, so this directory is a curated snapshot and may lag the exact vocabulary.",
      methods: [{
        name: "listEvents",
        description: "List the curated event directory, or one exact event when input.event is given.",
        inputSchema: {
          type: "object",
          properties: { event: { type: "string", description: "Optional exact event name." } },
          additionalProperties: false,
        },
        outputSchema: {},
      }],
    },
    {
      platform: "host",
      id: "Builtin",
      description: "The guarded surface available to dynamic host-half plugins (runtime-provided, see the runner sandbox).",
      methods: [{
        name: "listBuiltins",
        description: "List the runtime surface available to dynamic host plugins.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: {},
      }],
    },
    {
      platform: "host",
      id: "Tool",
      description: "Tools visible to the requesting agent, including scoped and dynamic registrations (live read).",
      methods: [{
        name: "listTools",
        description: "Return every tool schema currently callable by this agent.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: {},
      }],
    },
  ];
}

function clientProviders(ctx) {
  try {
    const list = ctx.cordisInspect ? ctx.cordisInspect.list() : [];
    return list.filter((p) => p.platform === "client");
  } catch {
    return [];
  }
}

function queryHost(ctx, provider, method, input, agent) {
  if (provider === "Service") {
    if (method !== "listService") throw new Error(`unknown Service inspect method "${method}"`);
    const services = liveServices(ctx);
    const want = readOptionalString(input, "service");
    if (want !== void 0) {
      const found = services.find((s) => s.name === want);
      if (found === void 0) throw new Error(`service "${want}" is not registered`);
      return found;
    }
    return { services };
  }
  if (provider === "Event") {
    if (method !== "listEvents") throw new Error(`unknown Event inspect method "${method}"`);
    const want = readOptionalString(input, "event");
    if (want !== void 0) {
      const found = KNOWN_EVENTS.find((e) => e.name === want);
      if (found === void 0) throw new Error(`event "${want}" is not in the curated directory; call listEvents without input`);
      return found;
    }
    return { events: KNOWN_EVENTS };
  }
  if (provider === "Builtin") {
    if (method !== "listBuiltins") throw new Error(`unknown Builtin inspect method "${method}"`);
    return { builtins: BUILTINS };
  }
  if (provider === "Tool") {
    if (method !== "listTools") throw new Error(`unknown Tool inspect method "${method}"`);
    return { tools: ctx.tools.schemas(agent) };
  }
  throw new Error(`unknown host inspect provider "${provider}"`);
}

// ---------- 运行状态辅助(与官方同语义,自研实现) ----------
function withinFiber(fiber, root) {
  let current = fiber;
  while (true) {
    if (current === root) return true;
    const parent = current.parent ? current.parent.fiber : current;
    if (parent === current) return false;
    current = parent;
  }
}
function providedServices(ctx, fiber) {
  const out = [];
  const store = ctx.reflect.store;
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key];
    if (!impl || typeof impl.name !== "string") continue;
    if (impl.fiber !== void 0 && withinFiber(impl.fiber, fiber)) out.push(impl.name);
  }
  return out.sort();
}
function missingServices(ctx, fiber) {
  const injectMap = fiber.inject ?? {};
  return Object.keys(injectMap).filter((service) => ctx.get(service) === void 0);
}
function selfState(reference) {
  const status = reference.latestRun?.status;
  if (status === "awaiting-approval") return "awaiting-approval";
  if (status === "client-pending" || status === "starting-host") return "client-pending";
  if (status === "failed" || status === "rejected" || status === "cancelled") return "failed";
  if (status === "waiting") return "waiting";
  if (status === "running") return "running";
  if (reference.activeRun !== void 0) return "running";
  return reference.currentPackageId === void 0 ? "defined" : "stopped";
}
function selfSummary(reference) {
  const latest = reference.latestRun;
  return {
    pluginId: String(reference.pluginId),
    name: reference.name,
    packageCount: reference.packages?.length ?? 1,
    state: selfState(reference),
    ...(reference.currentPackageId === void 0 ? {} : { currentPackageId: String(reference.currentPackageId) }),
    ...(reference.nextPackageId === void 0 ? {} : { nextPackageId: String(reference.nextPackageId) }),
    ...(reference.activeRun === void 0 ? {} : { activeRun: {
      pluginRunId: String(reference.activeRun.pluginRunId),
      packageId: String(reference.activeRun.packageId),
    } }),
    ...(latest?.status !== "awaiting-approval" ? {} : { pendingApproval: {
      pluginRunId: String(latest.pluginRunId),
      packageId: String(latest.packageId),
      mode: latest.mode,
    } }),
  };
}
function inspectSelfPackage(ctx, agent, pluginId, packageId) {
  const inspected = ctx.dynamicCordisRunner.inspectPackage(agent, pluginId, packageId);
  const row = ctx.dynamicCordisRunner.snapshot(agent).find((candidate) => candidate.pluginId === pluginId);
  const pkg = row?.packages.find((candidate) => candidate.packageId === packageId);
  const active = row?.activeRun?.packageId === packageId ? row.activeRun : void 0;
  const latest = inspected.latestRun?.packageId === packageId ? inspected.latestRun : void 0;
  const hostWaiting = active?.fiber === void 0 ? [...(latest?.host?.waitingFor ?? [])] : missingServices(ctx, active.fiber);
  const hostStatus = pkg?.hasHostHalf !== true ? "absent" : latest?.host?.status ?? (active === void 0 ? "stopped" : hostWaiting.length === 0 ? "running" : "waiting");
  const clientStatus = pkg?.hasClientHalf !== true ? "absent" : latest?.client?.status ?? "stopped";
  return {
    mode: "package",
    plugin: selfSummary(inspected),
    packageId: String(packageId),
    name: inspected.name,
    purpose: inspected.purpose,
    code: inspected.code,
    runtime: {
      state: selfState(inspected),
      host: {
        status: hostStatus,
        provides: active?.fiber === void 0 ? [] : providedServices(ctx, active.fiber),
        waitingFor: hostWaiting,
        handlers: active?.handlers ?? [],
        ...(latest?.host?.error === void 0 ? {} : { error: latest.host.error }),
      },
      client: {
        status: clientStatus,
        waitingFor: [...(latest?.client?.waitingFor ?? [])],
        ...(latest?.client?.error === void 0 ? {} : { error: latest.client.error }),
        ...(active?.renderFailure === void 0 ? {} : { renderFailure: active.renderFailure }),
      },
    },
  };
}

// ---------- 插件主体 ----------
function apply(ctx) {
  ctx.systemPrompt.section({
    name: "tool:cordis",
    order: 115,
    text: SYSTEM_PROMPT,
  });

  ctx.tools.register({
    name: "cordis_inspect_list",
    description: "List every runtime inspection provider known to this toolset: the four local host providers (Service, Event, Builtin, Tool — live reflection and curated directories) followed by client providers mirrored from the browser pages. Call this tool before cordis_inspect_query to learn exact provider and method names.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: { schema: {}, render: jsonRender },
    execute(_args, _exec) {
      return Promise.resolve({
        providers: [...providerDirectory(), ...clientProviders(ctx)],
      });
    },
  });

  ctx.tools.register({
    name: "cordis_inspect_query",
    description: "Run a read-only inspection query. For platform:\"host\", use the providers returned by cordis_inspect_list: Service.listService (live service directory), Event.listEvents (curated event directory), Builtin.listBuiltins (dynamic-plugin surface), Tool.listTools (this agent's callable tools). For platform:\"client\", the query is routed to the browser page that registers the provider and resolves when the page answers.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["platform", "provider", "method"],
      properties: {
        platform: {
          type: "string",
          enum: ["host", "client"],
          description: "Runtime platform that owns the provider.",
        },
        provider: {
          type: "string",
          description: "Exact provider id returned by cordis_inspect_list.",
        },
        method: {
          type: "string",
          description: "Exact method name declared by the provider.",
        },
        input: {
          type: "object",
          description: "Optional query input object; must satisfy the method input schema.",
        },
      },
    },
    output: { schema: {}, render: jsonRender },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      if (args.platform === "host") {
        const data = queryHost(ctx, args.provider, args.method, args.input, agent);
        return { platform: "host", provider: args.provider, method: args.method, data };
      }
      if (ctx.cordisInspect === void 0) throw new Error("client inspection is unavailable: no cordisInspect service");
      const data = await ctx.cordisInspect.query("client", args.provider, args.method, args.input, agent, exec.signal);
      return { platform: "client", provider: args.provider, method: args.method, data };
    },
  });

  ctx.tools.register({
    name: "cordis_inspect_self",
    description: "Inspect dynamic Cordis objects owned by the current session. With no ids, list plugin summaries. With pluginId alone, return the plugin and its packages. pluginId plus packageId returns the immutable package's host/client source and runtime diagnostics. Read-only.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pluginId: {
          type: "string",
          description: "Stable plugin id returned by cordis_define; omit to list every plugin of this session.",
        },
        packageId: {
          type: "string",
          description: "Exact immutable package id owned by pluginId; when specified, source and diagnostics are returned.",
        },
      },
    },
    output: { schema: {}, render: jsonRender },
    execute(args, exec) {
      const agent = requireAgent(exec);
      if (args.packageId !== void 0 && args.pluginId === void 0) throw new Error("cordis_inspect_self packageId requires pluginId");
      if (args.pluginId === void 0) {
        return Promise.resolve({
          mode: "plugins",
          plugins: ctx.dynamicCordisRunner.listPlugins(agent).map((reference) => selfSummary(reference)),
        });
      }
      const pluginId = args.pluginId;
      if (args.packageId === void 0) {
        const plugin = ctx.dynamicCordisRunner.inspectPlugin(agent, pluginId);
        return Promise.resolve({
          mode: "plugin",
          ...selfSummary(plugin),
          packages: plugin.packages.map((pkg) => ({
            ...pkg,
            packageId: String(pkg.packageId),
            isCurrent: pkg.packageId === plugin.currentPackageId,
            isNext: pkg.packageId === plugin.nextPackageId,
          })),
        });
      }
      return Promise.resolve(inspectSelfPackage(ctx, agent, pluginId, args.packageId));
    },
  });

  ctx.tools.register({
    name: "cordis_define",
    description: "Define an immutable Cordis Package for the current session. For a new Plugin, use kind:\"new\" with a semantic prefix of 3-6 lowercase English letters; the host returns the final pluginId and packageId. To modify an existing Plugin, use kind:\"existing\" with its exact pluginId to append a Package without overwriting older versions. Provide at least one of code.host and code.client. Each value is a plain JavaScript function body that returns a Cordis Plugin. Define only validates and records source: it does not request approval, execute apply, or change the running version. On success, call cordis_run with the returned ids.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "name", "purpose", "code"],
      properties: {
        kind: {
          type: "string",
          enum: ["new", "existing"],
          description: "\"new\" defines a fresh Plugin (the host appends a unique numeric suffix to idPrefix); \"existing\" appends a Package to an already-defined Plugin.",
        },
        idPrefix: {
          type: "string",
          description: "Required when kind is \"new\": semantic prefix of 3-6 lowercase English letters.",
        },
        pluginId: {
          type: "string",
          description: "Required when kind is \"existing\": exact id of the Plugin to extend.",
        },
        name: { type: "string", description: "Short, readable Package name." },
        purpose: { type: "string", description: "One-sentence, user-facing description of the Package purpose." },
        code: {
          type: "object",
          additionalProperties: false,
          properties: {
            host: { type: "string", description: "Plain JavaScript function body that returns the host-half Cordis Plugin." },
            client: { type: "string", description: "Plain JavaScript function body that returns the browser client-half Cordis Plugin." },
          },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["pluginId", "packageId", "name", "purpose", "hasHostHalf", "hasClientHalf"],
        properties: {
          pluginId: { type: "string" },
          packageId: { type: "string" },
          name: { type: "string" },
          purpose: { type: "string" },
          hasHostHalf: { type: "boolean" },
          hasClientHalf: { type: "boolean" },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `Defined ${value.pluginId}/${value.packageId} (${value.name}); it is not running yet. Use cordis_run to activate this Package.`,
      }],
    },
    execute(args, exec) {
      if (args.kind === "new" && typeof args.idPrefix !== "string") throw new Error('cordis_define kind "new" requires idPrefix (3-6 lowercase English letters)');
      if (args.kind === "existing" && typeof args.pluginId !== "string") throw new Error('cordis_define kind "existing" requires pluginId');
      const plugin = args.kind === "new" ? { kind: "new", idPrefix: args.idPrefix } : { kind: "existing", pluginId: args.pluginId };
      const receipt = ctx.dynamicCordisRunner.define({
        sessionId: requireAgent(exec).id,
        plugin,
        name: args.name,
        purpose: args.purpose,
        code: {
          ...(args.code.host === void 0 ? {} : { host: args.code.host }),
          ...(args.code.client === void 0 ? {} : { client: args.code.client }),
        },
      });
      return Promise.resolve({
        ...receipt,
        pluginId: String(receipt.pluginId),
        packageId: String(receipt.packageId),
      });
    },
  });

  ctx.tools.register({
    name: "cordis_run",
    description: "Activate one exact Package of a dynamic Plugin. Use mode:\"run\" for the first activation, restarting the current version, or rollback. When a current version exists, use mode:\"update\" to switch to a different Package. An unauthorized client Package creates an approval request and returns awaiting-approval; an authorized Package returns starting and continues asynchronously in the browser. Neither result waits for the final outcome inside this tool. After a technical failure, read diagnostics with cordis_inspect_self, correct the same Plugin, and retry. Do not request approval again after the user rejects it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pluginId", "packageId", "mode"],
      properties: {
        pluginId: { type: "string", description: "Stable Plugin id returned by cordis_define." },
        packageId: { type: "string", description: "Exact immutable Package id to activate under that Plugin." },
        mode: {
          type: "string",
          enum: ["run", "update"],
          description: "Use run for the first activation, restarting current, or rollback; use update to switch from current to a different Package.",
        },
      },
    },
    output: {
      schema: {},
      render: (_args, value) => {
        const result = requireJsonObject(value);
        const pluginId = requireJsonString(result, "pluginId");
        const packageId = requireJsonString(result, "packageId");
        const pluginRunId = requireJsonString(result, "pluginRunId");
        return [{
          type: "text",
          text: result.status === "awaiting-approval"
            ? `${pluginId}/${packageId} is awaiting user approval (${pluginRunId}).`
            : result.status === "starting"
              ? `${pluginId}/${packageId} is starting asynchronously (${pluginRunId}).`
              : `${pluginId}/${packageId} is running (${pluginRunId}).`,
        }];
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const pluginId = args.pluginId;
      const packageId = args.packageId;
      const receipt = await ctx.dynamicCordisRunner.run(agent, pluginId, packageId, args.mode, exec.signal);
      if (!receipt.ok) throw new Error(receipt.message);
      if (receipt.status !== "running") {
        return {
          status: receipt.status,
          pluginId: args.pluginId,
          packageId: args.packageId,
          pluginRunId: String(receipt.pluginRunId),
          mode: receipt.mode,
          ...(receipt.currentPackageId === void 0 ? {} : { currentPackageId: String(receipt.currentPackageId) }),
          nextPackageId: String(receipt.nextPackageId),
        };
      }
      const row = ctx.dynamicCordisRunner.snapshot(agent).find((candidate) => candidate.pluginId === pluginId);
      const fiber = row?.activeRun?.pluginRunId === receipt.pluginRunId ? row.activeRun.fiber : void 0;
      return {
        status: "running",
        pluginId: args.pluginId,
        packageId: args.packageId,
        pluginRunId: String(receipt.pluginRunId),
        currentPackageId: String(receipt.currentPackageId),
        ...(receipt.nextPackageId === void 0 ? {} : { nextPackageId: String(receipt.nextPackageId) }),
        host: {
          status: fiber === void 0 ? "absent" : missingServices(ctx, fiber).length === 0 ? "running" : "waiting",
          provides: fiber === void 0 ? [] : providedServices(ctx, fiber),
          waitingFor: fiber === void 0 ? [] : missingServices(ctx, fiber),
        },
        client: {
          status: receipt.clientWaitingFor === void 0 ? "absent" : receipt.clientWaitingFor.length === 0 ? "running" : "waiting",
          waitingFor: [...(receipt.clientWaitingFor ?? [])],
        },
      };
    },
  });

  ctx.tools.register({
    name: "cordis_stop",
    description: "Stop the current run of a dynamic Plugin and cancel unfinished approval or activation requests. Retains the Plugin, every immutable Package, grants, and version pointers so it can later run or update directly. Stopping an already stopped Plugin succeeds idempotently. Use cordis_undefine for permanent removal.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pluginId"],
      properties: {
        pluginId: { type: "string", description: "Stable dynamic Plugin id to stop." },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: false, required: ["pluginId"], properties: { pluginId: { type: "string" } } },
      render: (_args, value) => [{
        type: "text",
        text: `Dynamic Plugin ${value.pluginId} is stopped; its definition and versions remain.`,
      }],
    },
    async execute(args, exec) {
      const receipt = await ctx.dynamicCordisRunner.stop(requireAgent(exec), args.pluginId);
      if (!receipt.ok && receipt.reason !== "not-running") throw new Error(receipt.message);
      return { pluginId: args.pluginId };
    },
  });

  ctx.tools.register({
    name: "cordis_undefine",
    description: "Permanently remove a dynamic Plugin owned by the current session. If it is running or awaiting approval, it is stopped first and the request cancelled, then every Package, grant, and version pointer is deleted. After this returns, its ids and views are invalid. Use cordis_stop when versions must remain available for restart or rollback.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pluginId"],
      properties: {
        pluginId: { type: "string", description: "Stable dynamic Plugin id to remove permanently." },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["pluginId", "wasRunning"],
        properties: {
          pluginId: { type: "string" },
          wasRunning: { type: "boolean" },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `Removed dynamic Plugin ${value.pluginId} and all of its Packages.`,
      }],
    },
    async execute(args, exec) {
      const receipt = await ctx.dynamicCordisRunner.undefine(requireAgent(exec), args.pluginId);
      if (!receipt.ok) throw new Error(receipt.message);
      return { pluginId: args.pluginId, wasRunning: receipt.wasRunning };
    },
  });
}

export { apply, inject, name };
