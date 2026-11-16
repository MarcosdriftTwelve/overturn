import { describe, expect, it, vi } from "vitest";
import {
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  type FetchLike,
  type FrontConversationSnapshot,
  inScope,
  postCapture,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const conversation: FrontConversationSnapshot = {
  id: "cnv_98765",
  subject: "Roof leak after storm",
  recipientHandle: "dana@example.com",
  recipientName: "Dana",
  messages: [
    {
      id: "msg_1",
      body: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      isInbound: true,
      authorEmail: "dana@example.com",
      createdAt: "2026-11-16T10:00:00Z",
    },
    {
      id: "msg_2",
      body: "HO-3, no prior claims.",
      isInbound: false,
      isComment: true,
      authorName: "Ray",
    },
  ],
  fields: {},
  tags: ["ai_drafted"],
  url: "https://api2.frontapp.com/conversations/cnv_98765",
};

describe("settings", () => {
  it("parses plugin parameters and decision fields", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      overturn_api_key: "ov_test_key",
      agent: "claims-reply",
      require_reason: "true",
      decision_fields: "cf_status:status, cf_reserve:reserve,cf_tier",
      min_draft_chars: "120",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.apiKey).toBe("ov_test_key");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "cf_status", label: "status" },
      { id: "cf_reserve", label: "reserve" },
      { id: "cf_tier", label: "cf_tier" },
    ]);
    expect(s.minDraftChars).toBe(120);
  });

  it("supports both support (default) and claims reason packs", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    const claims = quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code);
    expect(claims).toHaveLength(8);
    expect(claims).toContain("wrong_coverage_decision");
    expect(claims).toContain("tone_wording");
    expect(settingsFrom({ reason_pack: "invalid" }).reasonPack).toBe("support");
  });

  it("scopes conversations by tag when scope_tag is set", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });
});

describe("draft detection and statusLine", () => {
  const long = "x".repeat(200);

  it("detects an inserted AI draft and shows Draft inserted · N words", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    const detected = d.onComposer(
      "Hello Dana, your claim is approved and will be processed shortly. ".repeat(3),
      500,
    );
    expect(detected?.origin).toBe("inserted");
    expect(statusLine(detected, null)).toMatch(/^Draft inserted · \d+ words$/);
  });

  it("ignores normal typing into the composer", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", 0)).toBeNull();
    let text = "";
    for (let i = 1; i <= 60; i++) {
      text += "ab";
      expect(d.onComposer(text, i * 100)).toBeNull();
    }
    expect(d.current()).toBeNull();
  });

  it("treats an already-populated composer on load as preloaded", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer(long, 10)?.origin).toBe("preloaded");
  });
});

describe("context and html", () => {
  it("strips html and maps inbound/outbound/comment roles", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the ceiling.\nPhotos attached.",
        at: "2026-11-16T10:00:00Z",
      },
      {
        role: "note",
        author: "Ray",
        content: "HO-3, no prior claims.",
        at: null,
      },
    ]);
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "inserted" as const, at: 1 };
  const base = {
    conversation,
    draft,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@carrier.com",
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("skips when no draft, on internal note, or on empty send", () => {
    expect(
      decideOnSend({ ...base, draft: null, send: { text: "x", type: "publicReply", fields: {} } }),
    ).toEqual({ action: "skip", why: "no-draft" });
    expect(decideOnSend({ ...base, send: { text: "x", type: "internalNote", fields: {} } })).toEqual({
      action: "skip",
      why: "internal-note",
    });
    expect(decideOnSend({ ...base, send: { text: "<p></p>", type: "publicReply", fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("builds a Front capture payload with source=front and externalId=fr:<id>", () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "publicReply", fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("front");
    expect(d.body.externalId).toBe("fr:cnv_98765");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.context).toHaveLength(2);
    expect(d.body.metadata).toEqual({ recipient: "dana@example.com" });
  });

  it("honours require_reason by blocking changed sends until a reasonCode is picked", () => {
    const sent = draftText.replace("covered", "not covered");
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
      reason: "Policy exclusion applies",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") {
      expect(ok.body.reasonCode).toBe("wrong_answer");
      expect(ok.body.reason).toBe("Policy exclusion applies");
    }
  });

  it("tracks changed decision fields", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      decisionFields: [{ id: "cf_status", label: "status" }],
    };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_coverage_decision",
      draftFields: { status: "covered" },
      send: { text: draftText, type: "publicReply", fields: { status: "denied" } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.draft.fields).toEqual({ status: "covered" });
    expect(d.body.sent.fields).toEqual({ status: "denied" });
  });
});

describe("postCapture", () => {
  it("never throws when capture fails (HTTP error or network error)", async () => {
    const d = decideOnSend({
      conversation,
      draft: { text: draftText, origin: "inserted", at: 1 },
      draftFields: {},
      reasonCode: null,
      reason: "",
      actor: "ray@carrier.com",
      settings: { ...DEFAULT_SETTINGS, requireReason: false },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error("expected capture");

    const log = vi.fn();
    const failHttp: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const res1 = await postCapture(failHttp, DEFAULT_SETTINGS, d.body, log);
    expect(res1).toEqual({ ok: false, status: 503 });
    expect(log).toHaveBeenCalledTimes(1);

    const failNet: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const res2 = await postCapture(failNet, DEFAULT_SETTINGS, d.body, log);
    expect(res2).toEqual({ ok: false, status: "network" });
    expect(log).toHaveBeenCalledTimes(2);
  });
});
