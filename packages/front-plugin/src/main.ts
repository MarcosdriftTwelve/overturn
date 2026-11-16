import {
  type AppSettings,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  type FetchLike,
  type FrontConversationSnapshot,
  type FrontMessageItem,
  inScope,
  postCapture,
  quickReasons,
  settingsFrom,
  statusLine,
} from "./capture";

/** Minimal strict surface of the Front Plugin SDK used by this plugin. */
export interface FrontSdkDraft {
  id: string;
  content?: { body?: string; type?: string };
}

export interface FrontSdkMessage {
  id: string;
  content?: { body?: string; type?: string };
  author?: { name?: string; email?: string; handle?: string };
  status?: "inbound" | "outbound" | string;
  date?: Date | string;
  isComment?: boolean;
}

export interface FrontSdkConversation {
  id: string;
  subject?: string;
  recipient?: { name?: string; handle?: string };
  tags?: Array<{ id: string; name: string }>;
  customFields?: Record<string, unknown>;
  links?: { self?: string };
}

export interface FrontSingleConversationContext {
  type: "singleConversation";
  conversation: FrontSdkConversation;
  teammate?: { email?: string; name?: string };
  listMessages(): Promise<{ results: FrontSdkMessage[] }>;
  listDrafts?(): Promise<{ results: FrontSdkDraft[] }>;
  on?(event: string, handler: (data?: unknown) => void): void;
}

export interface FrontOtherContext {
  type: string;
}

export type FrontContext = FrontSingleConversationContext | FrontOtherContext;

export interface FrontSdk {
  contextUpdates: {
    subscribe(callback: (context: FrontContext) => void): { unsubscribe(): void };
  };
}

declare global {
  interface Window {
    Front?: FrontSdk;
    OVERTURN_FRONT_SETTINGS?: Record<string, unknown>;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function querySettings(): Record<string, unknown> {
  const params = new URLSearchParams(window.location.search);
  const raw: Record<string, unknown> = { ...(window.OVERTURN_FRONT_SETTINGS ?? {}) };
  params.forEach((v, k) => {
    raw[k] = v;
  });
  return raw;
}

function mapDecisionFields(
  customFields: Record<string, unknown> | undefined,
  settings: AppSettings,
): Record<string, unknown> {
  if (settings.decisionFields.length === 0) return {};
  const src = customFields ?? {};
  return Object.fromEntries(settings.decisionFields.map((f) => [f.label, src[f.id] ?? null]));
}

function mapMessages(items: FrontSdkMessage[]): FrontMessageItem[] {
  return items.map((m) => ({
    id: m.id,
    body: m.content?.body ?? "",
    isInbound: m.status === "inbound",
    isComment: Boolean(m.isComment),
    authorName: m.author?.name ?? null,
    authorEmail: m.author?.email ?? m.author?.handle ?? null,
    createdAt: m.date instanceof Date ? m.date.toISOString() : (m.date ?? null),
  }));
}

async function readComposerDraft(ctx: FrontSingleConversationContext): Promise<string> {
  if (!ctx.listDrafts) return "";
  try {
    const res = await ctx.listDrafts();
    return res.results[0]?.content?.body ?? "";
  } catch {
    return "";
  }
}

export function initFrontPlugin(): void {
  const root = document.getElementById("app");
  if (!root || !window.Front) return;

  const settings = settingsFrom(querySettings());
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const status = el("div", { class: "status" }, "Waiting for a draft");
  let reasonCode: string | null = null;
  const quick = el("div", {
    class: "quick",
    role: "radiogroup",
    "aria-label": "Why did you change it?",
  });
  const chips: HTMLButtonElement[] = [];
  for (const q of quickReasons(settings)) {
    const b = el("button", { type: "button", class: "chip", "data-code": q.code }, q.label);
    b.addEventListener("click", () => {
      reasonCode = reasonCode === q.code ? null : q.code;
      for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
    });
    chips.push(b);
    quick.appendChild(b);
  }
  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  });
  const actions = el("div", { class: "actions" });
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const sendBtn = el("button", { type: "button", class: "link" }, "Capture send");
  actions.append(mark, sendBtn);
  const note = el("div", { class: "note" }, "");
  root.append(status, quick, reason, actions, note);

  let activeCtx: FrontSingleConversationContext | null = null;
  let draftFields: Record<string, unknown> = {};
  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  let pollTimer: number | null = null;

  const render = (): void => {
    status.textContent = statusLine(detector.current(), lastResult);
  };

  const handleSend = async (sentBodyHtml?: string): Promise<void> => {
    if (!activeCtx) return;
    const draft: DraftState | null = detector.current();
    // Out of scope: never read conversation messages unless a draft exists.
    if (!draft) return;

    const tags = (activeCtx.conversation.tags ?? []).map((t) => t.name);
    if (!inScope(tags, settings)) return;

    const finalBody = sentBodyHtml ?? (await readComposerDraft(activeCtx));
    const msgs = await activeCtx.listMessages();
    const conv = activeCtx.conversation;
    const snapshot: FrontConversationSnapshot = {
      id: conv.id,
      subject: conv.subject ?? null,
      recipientHandle: conv.recipient?.handle ?? null,
      recipientName: conv.recipient?.name ?? null,
      messages: mapMessages(msgs.results),
      fields: mapDecisionFields(conv.customFields, settings),
      tags,
      url: conv.links?.self ?? null,
    };

    const decision = decideOnSend({
      conversation: snapshot,
      draft,
      draftFields,
      send: { text: finalBody, type: "publicReply", fields: snapshot.fields },
      reasonCode,
      reason: reason.value,
      actor: activeCtx.teammate?.email ?? activeCtx.teammate?.name ?? null,
      settings,
      now: Date.now(),
    });

    if (decision.action === "skip") return;
    if (decision.action === "need-reason") {
      chips[0]?.focus();
      note.textContent = `Overturn: pick why you changed the ${decision.changedFields.length ? decision.changedFields.join(", ") : "reply"} before sending.`;
      return;
    }

    const outcome = await postCapture(fetch as unknown as FetchLike, settings, decision.body);
    if (outcome.ok) {
      lastResult = {
        kind: outcome.result.kind,
        changed: outcome.result.changed,
        dedup: outcome.result.deduplicated,
      };
      note.textContent =
        outcome.result.changed && outcome.result.case ? `Case: ${outcome.result.case.title}` : "";
      reason.value = "";
      reasonCode = null;
      for (const c of chips) c.classList.remove("on");
      detector.set(null);
      render();
    } else {
      // Never block sending on capture failure.
      note.textContent = `Overturn could not save this correction (${outcome.status}).`;
    }
  };

  mark.addEventListener("click", async () => {
    if (!activeCtx) return;
    const text = await readComposerDraft(activeCtx);
    if (!text.trim()) return;
    detector.set({ text, origin: "manual", at: Date.now() });
    lastResult = null;
    note.textContent = "";
    render();
  });

  sendBtn.addEventListener("click", () => {
    void handleSend();
  });

  window.Front.contextUpdates.subscribe((ctx) => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    if (ctx.type !== "singleConversation") {
      activeCtx = null;
      detector.set(null);
      status.textContent = "Open a conversation to track AI drafts";
      return;
    }

    const single = ctx as FrontSingleConversationContext;
    activeCtx = single;
    detector.set(null);
    lastResult = null;
    note.textContent = "";

    const tags = (single.conversation.tags ?? []).map((t) => t.name);
    if (!inScope(tags, settings)) {
      status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
      return;
    }

    draftFields = mapDecisionFields(single.conversation.customFields, settings);
    render();

    const checkDraft = async (): Promise<void> => {
      const body = await readComposerDraft(single);
      if (detector.onComposer(body)) render();
    };
    void checkDraft();
    pollTimer = window.setInterval(() => void checkDraft(), 1200);

    if (single.on) {
      single.on("draft_sent", (payload) => {
        const p = payload as { content?: { body?: string } } | undefined;
        void handleSend(p?.content?.body);
      });
    }
  });
}

if (typeof document !== "undefined") {
  initFrontPlugin();
}
