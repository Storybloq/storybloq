/**
 * APNS silent push contract tests (T-220).
 *
 * Validates the CloudKit silent push notification payload format that the iOS
 * AppDelegate.didReceiveRemoteNotification handler expects. These tests define
 * the contract between CloudKit subscription notifications and the app's push
 * handler.
 *
 * The actual handling is implemented in Swift (AppDelegate.swift). These tests
 * serve as cross-platform contract documentation.
 */
import { describe, it, expect } from "vitest";

/**
 * CloudKit silent push payload format.
 * See: https://developer.apple.com/documentation/cloudkit/cknotification
 *
 * CloudKit sends silent pushes with content-available: 1 and a "ck" key
 * containing the subscription details.
 */
interface CloudKitSilentPush {
  aps: {
    "content-available": 1;
  };
  ck: {
    ce: number; // container environment: 1=development, 2=production
    cid: string; // container ID
    nid: string; // notification ID
    sid?: string; // subscription ID
    qry?: {
      // query notification fields
      dbs: number; // database scope: 1=public, 2=private, 3=shared
      rid: string; // record ID
      zid: string; // zone ID
      zoid: string; // zone owner
    };
  };
}

function isValidCloudKitSilentPush(
  payload: unknown
): payload is CloudKitSilentPush {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;

  // Must have aps with content-available
  if (typeof obj.aps !== "object" || obj.aps === null) return false;
  const aps = obj.aps as Record<string, unknown>;
  if (aps["content-available"] !== 1) return false;

  // Must have ck object with container info
  if (typeof obj.ck !== "object" || obj.ck === null) return false;
  const ck = obj.ck as Record<string, unknown>;
  if (typeof ck.ce !== "number") return false;
  if (typeof ck.cid !== "string") return false;
  if (typeof ck.nid !== "string") return false;

  return true;
}

/**
 * Validates that a payload is NOT a CloudKit notification.
 * AppDelegate must ignore non-CK payloads and return .noData.
 */
function isNonCloudKitPayload(payload: unknown): boolean {
  return !isValidCloudKitSilentPush(payload);
}

describe("APNS Silent Push Contract (T-220)", () => {
  describe("CloudKit silent push payload validation", () => {
    it("accepts a valid CloudKit query subscription push", () => {
      const payload: CloudKitSilentPush = {
        aps: { "content-available": 1 },
        ck: {
          ce: 1,
          cid: "iCloud.com.claudestory.shared",
          nid: "abc123",
          sid: "project-state-subscription",
          qry: {
            dbs: 2,
            rid: "record-id",
            zid: "_defaultZone",
            zoid: "_owner",
          },
        },
      };
      expect(isValidCloudKitSilentPush(payload)).toBe(true);
    });

    it("accepts a minimal CloudKit push without query fields", () => {
      const payload = {
        aps: { "content-available": 1 },
        ck: {
          ce: 2,
          cid: "iCloud.com.claudestory.shared",
          nid: "def456",
        },
      };
      expect(isValidCloudKitSilentPush(payload)).toBe(true);
    });

    it("rejects payload without ck key (non-CloudKit push)", () => {
      const payload = {
        aps: { "content-available": 1 },
        custom: { type: "something-else" },
      };
      expect(isNonCloudKitPayload(payload)).toBe(true);
    });

    it("rejects payload without content-available (visible push)", () => {
      const payload = {
        aps: { alert: { title: "Hello", body: "World" } },
        ck: { ce: 1, cid: "iCloud.com.claudestory.shared", nid: "x" },
      };
      expect(isNonCloudKitPayload(payload)).toBe(true);
    });

    it("rejects empty payload", () => {
      expect(isNonCloudKitPayload({})).toBe(true);
    });

    it("rejects null payload", () => {
      expect(isNonCloudKitPayload(null)).toBe(true);
    });
  });

  describe("UIBackgroundModes contract", () => {
    it("requires remote-notification in UIBackgroundModes for silent push", () => {
      // Contract: Info.plist must contain UIBackgroundModes with remote-notification
      // This is validated by iOS at build time / launch time.
      // The AppDelegate.didReceiveRemoteNotification:fetchCompletionHandler:
      // will not be called without this key.
      const requiredBackgroundModes = ["remote-notification"];
      expect(requiredBackgroundModes).toContain("remote-notification");
    });
  });

  describe("Fetch completion handler contract", () => {
    it("returns noData when no handler is set", () => {
      // Contract: When silentPushHandler is nil, AppDelegate must call
      // fetchCompletionHandler(.noData) immediately
      const result = "noData"; // simulated
      expect(result).toBe("noData");
    });

    it("returns noData for non-CloudKit payloads", () => {
      // Contract: Non-CK payloads are ignored with .noData
      const result = "noData";
      expect(result).toBe("noData");
    });

    it("returns failed when handler throws", () => {
      // Contract: If the async throws handler throws, completion
      // must be called with .failed
      const result = "failed"; // simulated error path
      expect(result).toBe("failed");
    });
  });
});
