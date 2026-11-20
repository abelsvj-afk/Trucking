// Auditor has NO write path — proved in code, not just in prose.
// The Auditor (docs/bots/auditor/CLAUDE.md) is read-only everywhere,
// flag only. This test pins that: every execute-class action and
// every draft-class action is denied for the Auditor on every tool
// group, its scope holds no write level anywhere, and the only thing
// it can do besides read is flag — on groups it can read, and never
// on calls or signature.
import { describe, expect, it } from "vitest";
import {
  BOT_REGISTRY,
  canDraft,
  canFlag,
  canRead,
  visibleToolGroups,
  type ToolGroup,
} from "@/services/bots/registry";
import {
  DRAFT_ACTION_KINDS,
  EXECUTE_ACTION_KINDS,
  checkBotAction,
  type BotActionKind,
} from "@/services/bots/guardrails";

const ALL_GROUPS: ToolGroup[] = [
  "loads",
  "hos",
  "money",
  "documents",
  "email",
  "maps",
  "app-actions",
  "calls",
  "signature",
];

const READ_GROUPS: ToolGroup[] = ["loads", "hos", "money", "documents", "email", "maps", "app-actions"];

describe("auditor: no write path", () => {
  it("holds no write scope on any tool group — read, flag, or never only", () => {
    const scope = BOT_REGISTRY.auditor.toolScope;
    for (const group of ALL_GROUPS) {
      expect(["read", "flag", "never"]).toContain(scope[group]);
    }
    expect(scope.loads).toBe("read");
    expect(scope.hos).toBe("read");
    expect(scope.money).toBe("read");
    expect(scope.documents).toBe("read");
    expect(scope.email).toBe("read");
    expect(scope.maps).toBe("read");
    expect(scope["app-actions"]).toBe("flag");
    expect(scope.calls).toBe("never");
    expect(scope.signature).toBe("never");
  });

  it("cannot draft on any group", () => {
    for (const group of ALL_GROUPS) {
      expect(canDraft("auditor", group)).toBe(false);
    }
  });

  it("can read exactly the six read groups plus app-actions (flag scope reads)", () => {
    for (const group of READ_GROUPS) {
      expect(canRead("auditor", group)).toBe(true);
    }
    expect(canRead("auditor", "calls")).toBe(false);
    expect(canRead("auditor", "signature")).toBe(false);
  });

  it("can flag on groups it can read, never on calls or signature", () => {
    for (const group of READ_GROUPS) {
      expect(canFlag("auditor", group)).toBe(true);
    }
    expect(canFlag("auditor", "calls")).toBe(false);
    expect(canFlag("auditor", "signature")).toBe(false);
  });

  it("sees no write tool group at all — calls and signature are hidden", () => {
    const visible = visibleToolGroups("auditor");
    expect(visible).not.toContain("calls");
    expect(visible).not.toContain("signature");
    expect([...visible].sort()).toEqual([...READ_GROUPS].sort());
  });

  it("is denied every execute-class action on every group, with or without an approved proposal", () => {
    for (const kind of EXECUTE_ACTION_KINDS) {
      for (const group of ALL_GROUPS) {
        expect(checkBotAction({ botSlug: "auditor", actionKind: kind, group }).allowed).toBe(false);
        expect(
          checkBotAction({ botSlug: "auditor", actionKind: kind, group, hasApprovedProposal: true }).allowed,
        ).toBe(false);
      }
    }
  });

  it("is denied every draft-class action on every group", () => {
    for (const kind of DRAFT_ACTION_KINDS) {
      for (const group of ALL_GROUPS) {
        const verdict = checkBotAction({ botSlug: "auditor", actionKind: kind, group });
        expect(verdict.allowed).toBe(false);
      }
    }
  });

  it("is denied the concrete never-actions by name: book, pay, move money, send, sign, file, change HOS, delete, call", () => {
    const neverActions: BotActionKind[] = [
      "book_load",
      "pay",
      "move_money",
      "send_to_broker",
      "send_to_shipper",
      "send_to_driver",
      "sign_document",
      "file_document",
      "change_hos_log",
      "delete_record",
      "change_permissions",
      "call_outbound",
    ];
    for (const actionKind of neverActions) {
      expect(checkBotAction({ botSlug: "auditor", actionKind, group: "loads" }).allowed).toBe(false);
    }
  });

  it("may flag — its one write — and only through the flag channel", () => {
    expect(checkBotAction({ botSlug: "auditor", actionKind: "flag", group: "loads" }).allowed).toBe(true);
    expect(checkBotAction({ botSlug: "auditor", actionKind: "flag", group: "app-actions" }).allowed).toBe(true);
    expect(checkBotAction({ botSlug: "auditor", actionKind: "flag", group: "calls" }).allowed).toBe(false);
    expect(checkBotAction({ botSlug: "auditor", actionKind: "flag", group: "signature" }).allowed).toBe(false);
  });
});
