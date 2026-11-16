import { describe, expect, it, vi } from "vitest";
import {
  buildCanvasComponents,
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  draftOriginTag,
  type FetchLike,
  type IntercomConversationSnapshot,
  inScope,
  postCapture,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Your refund has been processed and will arrive within 3 business days.</p>";

const conversation: IntercomConversationSnapshot = {
  id: "90012345",
  subject: "Refund status",
  contactEmail: "dana@example.com",
  contactName: "Dana",
  parts: [
    {
      id: "p1",
      body: "<div>Where is my refund?<br>Order #1024</div>",
      partType: "comment",
      authorType: "user",
      authorEmail: "dana@example.com",
      createdAt: "2026-11-16T10:00:00Z",
    },
    {
      id: "p2",
      body: "Verified order #1024 in Stripe.",
      partType: "note",
      authorType: "admin",
      authorName: "Ray",
    },
  ],
  fields: {},
  tags: ["fin_draft"],
  url: "https://app.intercom.com/a/inbox/ws/inbox/conversation/90012345",
};

describe("settings & reason packs", () => {
  it("defaults reason_pack to support and parses decision_fields", () => {
    expect(DEFAULT_SETTINGS.reasonPack).toBe("support");
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");

    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      reason_pack: "claims",
      decision_fields: "refund_status:status, tier",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.reasonPack).toBe("claims");
    expect(s.decisionFields).toEqual([
      { id: "refund_status", label: "status" },
      { id: "tier", label: "tier" },
    ]);
  });

  it("scopes by tag when scope_tag is set", () => {
    expect(inScope(["vip"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "fin_draft" });
    expect(inScope(["vip"], scoped)).toBe(false);
    expect(inScope(["vip", "fin_draft"], scoped)).toBe(true);
  });
});

describe("Fin vs human draft origin distinction", () => {
  const long = "Hello Dana, your refund has been processed and will arrive shortly. ".repeat(3);

  it("tags draft:ai only when isAiAssist=true, draft:manual when false, draft:unknown when omitted", () => {
    const dAi = createDraftDetector({ minDraftChars: 80 });
    dAi.onComposer("", { now: 0 });
    const aiState = dAi.onComposer(long, { now: 500, isAiAssist: true });
    expect(aiState?.origin).toBe("ai");
    expect(draftOriginTag(aiState!.origin)).toBe("draft:ai");
    expect(statusLine(aiState, null)).toMatch(/^Draft inserted · \d+ words$/);

    const dHuman = createDraftDetector({ minDraftChars: 80 });
    dHuman.onComposer("", { now: 0 });
    const humanState = dHuman.onComposer(long, { now: 500, isAiAssist: false });
    expect(humanState?.origin).toBe("manual");
    expect(draftOriginTag(humanState!.origin)).toBe("draft:manual");

    const dUnknown = createDraftDetector({ minDraftChars: 80 });
    const unknownState = dUnknown.onComposer(long, { now: 10 });
    expect(unknownState?.origin).toBe("unknown");
    expect(draftOriginTag(unknownState!.origin)).toBe("draft:unknown");
  });

  it("ignores incremental human typing", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", { now: 0 });
    let text = "";
    for (let i = 1; i <= 60; i++) {
      text += "ab";
      expect(d.onComposer(text, { now: i * 100, isAiAssist: false })).toBeNull();
    }
    expect(d.current()).toBeNull();
  });
});

describe("context & html", () => {
  it("strips html and maps customer/note/agent roles", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Where is my refund?\nOrder #1024",
        at: "2026-11-16T10:00:00Z",
      },
      {
        role: "note",
        author: "Ray",
        content: "Verified order #1024 in Stripe.",
        at: null,
      },
    ]);
  });
});

describe("decideOnSend & Canvas Kit", () => {
  const aiDraft = { text: draftText, origin: "ai" as const, at: 1 };
  const base = {
    conversation,
    draft: aiDraft,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@company.com",
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("builds source=intercom and externalId=ic:<id> with draft:ai tag", () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "publicReply", fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.body.source).toBe("intercom");
    expect(d.body.externalId).toBe("ic:90012345");
    expect(d.body.tags).toEqual(["draft:ai", "public-reply"]);
    expect(d.body.context).toHaveLength(2);
  });

  it("honours require_reason on edited sends", () => {
    const sent = draftText.replace("3 business days", "5 business days");
    const blocked = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });

    const ok = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      reasonCode: "wrong_answer",
      reason: "Bank wire takes 5 days",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") {
      expect(ok.body.reasonCode).toBe("wrong_answer");
      expect(ok.body.reason).toBe("Bank wire takes 5 days");
    }
  });

  it("builds Canvas Kit components when a draft is active", () => {
    expect(buildCanvasComponents(null, DEFAULT_SETTINGS, null)).toHaveLength(1);
    const active = buildCanvasComponents(aiDraft, DEFAULT_SETTINGS, null);
    expect(active.map((c) => c.type)).toEqual(["text", "single-select", "input", "button"]);
  });

  it("never throws when capture fails", async () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "publicReply", fields: {} } });
    if (d.action !== "capture") throw new Error("expected capture");
    const log = vi.fn();
    const failNet: FetchLike = async () => {
      throw new Error("timeout");
    };
    const res = await postCapture(failNet, DEFAULT_SETTINGS, d.body, log);
    expect(res).toEqual({ ok: false, status: "network" });
    expect(log).toHaveBeenCalledTimes(1);
  });
});
