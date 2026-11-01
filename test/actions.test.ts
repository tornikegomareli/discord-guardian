import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeId, encodeId, shouldAutoAct, type ActionConfig } from "../src/moderation/actions.js";

const base: ActionConfig = { mode: "auto", timeout_minutes: 60, ban_delete_message_seconds: 0, auto_categories: ["scam", "spam"],
  auto_min_confidence: 0.9, auto_actions: ["delete"], mod_log_channel_id: "", approver_role_ids: [] };
const v = (category: any, severity: any, confidence: number) => ({ category, severity, confidence, reason: "x" });

test("button ids round-trip and reject garbage", () => {
  const t = { channelId: "111111", messageId: "222222", userId: "333333" };
  assert.deepEqual(decodeId(encodeId("ban", t)), { action: "ban", t });
  assert.equal(decodeId("gmod:nuke:111111:222222:333333"), null);
  assert.equal(decodeId("other:ban:1:2:3"), null);
  assert.ok(encodeId("timeout", { channelId: "1".repeat(20), messageId: "2".repeat(20), userId: "3".repeat(20) }).length <= 100);
});

test("auto acts only on confident high scam/spam in auto mode", () => {
  assert.equal(shouldAutoAct(base, v("scam", "high", 0.95)), true);
  assert.equal(shouldAutoAct(base, v("scam", "high", 0.8)), false);
  assert.equal(shouldAutoAct(base, v("scam", "medium", 0.99)), false);
  assert.equal(shouldAutoAct(base, v("harassment", "high", 0.99)), false);
  assert.equal(shouldAutoAct({ ...base, mode: "approve" }, v("scam", "high", 0.99)), false);
  assert.equal(shouldAutoAct(base, null), false);
});
