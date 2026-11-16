import {
  type AppSettings,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  type FetchLike,
  type IntercomConversationPart,
  type IntercomConversationSnapshot,
  inScope,
  postCapture,
  quickReasons,
  settingsFrom,
  statusLine,
} from "./capture";

export interface IntercomHostPart {
  id?: string;
  body?: string;
  part_type?: string;
  author?: { type?: string; name?: string; email?: string };
  created_at?: number | string;
}

export interface IntercomHostConversation {
  id: string;
  title?: string;
  contacts?: { contacts?: Array<{ email?: string; name?: string }> };
  tags?: { tags?: Array<{ name: string }> };
  custom_attributes?: Record<string, unknown>;
  conversation_parts?: { conversation_parts?: IntercomHostPart[] };
  composer_state?: { text?: string; is_ai_assist?: boolean };
  url?: string;
}

export interface IntercomInboxBridge {
  getConversation(): Promise<IntercomHostConversation>;
  getCurrentAdmin?(): Promise<{ email?: string; name?: string }>;
  onComposerChange?(cb: (payload: { text: string; isAiAssist?: boolean }) => void): void;
  onReplySent?(cb: (payload: { text: string; type?: string }) => void): void;
}

declare global {
  interface Window {
    IntercomInbox?: IntercomInboxBridge;
    OVERTURN_INTERCOM_SETTINGS?: Record<string, unknown>;
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
  const raw: Record<string, unknown> = { ...(window.OVERTURN_INTERCOM_SETTINGS ?? {}) };
  params.forEach((v, k) => {
    raw[k] = v;
  });
  return raw;
}

function mapFields(
  attrs: Record<string, unknown> | undefined,
  settings: AppSettings,
): Record<string, unknown> {
  if (settings.decisionFields.length === 0) return {};
  const src = attrs ?? {};
  return Object.fromEntries(settings.decisionFields.map((f) => [f.label, src[f.id] ?? null]));
}

function mapParts(parts: IntercomHostPart[] | undefined): IntercomConversationPart[] {
  return (parts ?? []).map((p) => ({
    id: p.id,
    body: p.body ?? "",
    partType: p.part_type ?? "comment",
    authorType: p.author?.type ?? "user",
    authorName: p.author?.name ?? null,
    authorEmail: p.author?.email ?? null,
    createdAt:
      typeof p.created_at === "number" ? new Date(p.created_at * 1000).toISOString() : (p.created_at ?? null),
  }));
}

export async function initIntercomApp(): Promise<void> {
  const root = document.getElementById("app");
  if (!root || !window.IntercomInbox) return;

  const bridge = window.IntercomInbox;
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
  const mark = el("button", { type: "button", class: "link" }, "Mark current text as manual draft");
  const sendBtn = el("button", { type: "button", class: "link" }, "Capture send");
  actions.append(mark, sendBtn);
  const note = el("div", { class: "note" }, "");
  root.append(status, quick, reason, actions, note);

  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  const render = (): void => {
    status.textContent = statusLine(detector.current(), lastResult);
  };

  const conv = await bridge.getConversation();
  const tags = (conv.tags?.tags ?? []).map((t) => t.name);
  if (!inScope(tags, settings)) {
    status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
    quick.remove();
    reason.remove();
    actions.remove();
    return;
  }

  const draftFields = mapFields(conv.custom_attributes, settings);
  if (conv.composer_state?.text) {
    detector.onComposer(conv.composer_state.text, {
      isAiAssist: conv.composer_state.is_ai_assist,
    });
  }
  render();

  bridge.onComposerChange?.((payload) => {
    if (detector.onComposer(payload.text, { isAiAssist: payload.isAiAssist })) render();
  });

  mark.addEventListener("click", async () => {
    const latest = await bridge.getConversation();
    const text = latest.composer_state?.text ?? "";
    if (!text.trim()) return;
    detector.set({ text, origin: "manual", at: Date.now() });
    lastResult = null;
    note.textContent = "";
    render();
  });

  const handleSend = async (sentText?: string, sendType = "publicReply"): Promise<void> => {
    const draft: DraftState | null = detector.current();
    // Out of scope: never read conversation parts unless a draft exists.
    if (!draft) return;

    const latest = await bridge.getConversation();
    const contact = latest.contacts?.contacts?.[0];
    const snapshot: IntercomConversationSnapshot = {
      id: latest.id,
      subject: latest.title ?? null,
      contactEmail: contact?.email ?? null,
      contactName: contact?.name ?? null,
      parts: mapParts(latest.conversation_parts?.conversation_parts),
      fields: mapFields(latest.custom_attributes, settings),
      tags: (latest.tags?.tags ?? []).map((t) => t.name),
      url: latest.url ?? null,
    };

    const admin = bridge.getCurrentAdmin ? await bridge.getCurrentAdmin() : null;
    const decision = decideOnSend({
      conversation: snapshot,
      draft,
      draftFields,
      send: {
        text: sentText ?? latest.composer_state?.text ?? "",
        type: sendType,
        fields: snapshot.fields,
      },
      reasonCode,
      reason: reason.value,
      actor: admin?.email ?? admin?.name ?? null,
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
      note.textContent = `Overturn could not save this correction (${outcome.status}).`;
    }
  };

  sendBtn.addEventListener("click", () => void handleSend());
  bridge.onReplySent?.((payload) => void handleSend(payload.text, payload.type ?? "publicReply"));
}

if (typeof document !== "undefined") {
  void initIntercomApp();
}
