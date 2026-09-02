import { describe, it, expect, vi } from "vitest";
import {
  encodePermissionId,
  decodePermissionId,
  encodeChoiceId,
  decodeChoiceId,
  encodePlanId,
  decodePlanId,
} from "../src/platforms/discord/custom-id.js";
import { isAuthorized, isOwner, type AuthContext, type AuthPolicy } from "../src/platforms/discord/auth.js";
import {
  resolveButtonAck,
  decisionBindsToChannel,
  applyYoloToggle,
  approvalScopeKeys,
  buildCommandRegistrationPayload,
  restrictCommandDefaults,
  yoloOnWarning,
} from "../src/app.js";

describe("custom-id", () => {
  it("round-trips each action + nonce", () => {
    const id = encodePermissionId("abc-123", "once");
    expect(id).toBe("dp:perm:once:abc-123");
    for (const action of ["once", "session", "always", "deny"] as const) {
      expect(decodePermissionId(encodePermissionId("n", action))).toEqual({ nonce: "n", action });
    }
  });

  describe("command registration defaults", () => {
    it("hides every command from non-admins unless Discord has an explicit override", () => {
      expect(restrictCommandDefaults([{ name: "new" }, { name: "channel" }])).toEqual([
        { name: "new", default_member_permissions: "0" },
        { name: "channel", default_member_permissions: "0" },
      ]);
    });

    it("keeps the complete registered payload stable before command extraction", () => {
      const modelIds = Array.from({ length: 27 }, (_, index) =>
        `model-${String(index + 1).padStart(2, "0")}`
      );

      expect(buildCommandRegistrationPayload(modelIds)).toMatchInlineSnapshot(`
        [
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Start a new Copilot session in a thread",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "new",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "autocomplete": undefined,
                "choices": undefined,
                "description": "Optional first prompt",
                "description_localizations": undefined,
                "max_length": undefined,
                "min_length": undefined,
                "name": "prompt",
                "name_localizations": undefined,
                "required": false,
                "type": 3,
              },
              {
                "autocomplete": true,
                "choices": undefined,
                "description": "Repo under REPOS_ROOT (defaults to DEFAULT_REPO)",
                "description_localizations": undefined,
                "max_length": undefined,
                "min_length": undefined,
                "name": "repo",
                "name_localizations": undefined,
                "required": false,
                "type": 3,
              },
            ],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Which repo this thread works in, and how",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "repo",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "description": "What this thread is bound to",
                "description_localizations": undefined,
                "name": "show",
                "name_localizations": undefined,
                "options": [],
                "type": 1,
              },
              {
                "description": "Repos available under REPOS_ROOT",
                "description_localizations": undefined,
                "name": "list",
                "name_localizations": undefined,
                "options": [],
                "type": 1,
              },
              {
                "description": "Bind this thread to a different repo (starts a fresh conversation)",
                "description_localizations": undefined,
                "name": "set",
                "name_localizations": undefined,
                "options": [
                  {
                    "autocomplete": true,
                    "choices": undefined,
                    "description": "Repo name",
                    "description_localizations": undefined,
                    "max_length": undefined,
                    "min_length": undefined,
                    "name": "name",
                    "name_localizations": undefined,
                    "required": true,
                    "type": 3,
                  },
                ],
                "type": 1,
              },
              {
                "description": "Work in this session's own worktree, or directly in the repo",
                "description_localizations": undefined,
                "name": "dev",
                "name_localizations": undefined,
                "options": [
                  {
                    "autocomplete": undefined,
                    "choices": [
                      {
                        "name": "worktree — isolated copy for this session",
                        "name_localizations": undefined,
                        "value": "worktree",
                      },
                      {
                        "name": "local — work directly in the repo",
                        "name_localizations": undefined,
                        "value": "local",
                      },
                    ],
                    "description": "worktree (isolated, default) or local (edits the repo itself)",
                    "description_localizations": undefined,
                    "max_length": undefined,
                    "min_length": undefined,
                    "name": "mode",
                    "name_localizations": undefined,
                    "required": true,
                    "type": 3,
                  },
                ],
                "type": 1,
              },
              {
                "description": "Clone a remote repo into REPOS_ROOT and bind this thread to it",
                "description_localizations": undefined,
                "name": "clone",
                "name_localizations": undefined,
                "options": [
                  {
                    "autocomplete": undefined,
                    "choices": undefined,
                    "description": "owner/repo, https://…, ssh://…, or git@host:owner/repo",
                    "description_localizations": undefined,
                    "max_length": undefined,
                    "min_length": undefined,
                    "name": "source",
                    "name_localizations": undefined,
                    "required": true,
                    "type": 3,
                  },
                  {
                    "autocomplete": undefined,
                    "choices": undefined,
                    "description": "Folder name (defaults to the repo name)",
                    "description_localizations": undefined,
                    "max_length": undefined,
                    "min_length": undefined,
                    "name": "name",
                    "name_localizations": undefined,
                    "required": false,
                    "type": 3,
                  },
                ],
                "type": 1,
              },
              {
                "description": "Create a new empty git repo in REPOS_ROOT and bind this thread to it",
                "description_localizations": undefined,
                "name": "new",
                "name_localizations": undefined,
                "options": [
                  {
                    "autocomplete": undefined,
                    "choices": undefined,
                    "description": "New project name",
                    "description_localizations": undefined,
                    "max_length": undefined,
                    "min_length": undefined,
                    "name": "name",
                    "name_localizations": undefined,
                    "required": true,
                    "type": 3,
                  },
                ],
                "type": 1,
              },
            ],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Abort the current turn in this session thread",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "stop",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Switch this session's model (history preserved)",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "model",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "autocomplete": undefined,
                "choices": [
                  {
                    "name": "model-01",
                    "name_localizations": undefined,
                    "value": "model-01",
                  },
                  {
                    "name": "model-02",
                    "name_localizations": undefined,
                    "value": "model-02",
                  },
                  {
                    "name": "model-03",
                    "name_localizations": undefined,
                    "value": "model-03",
                  },
                  {
                    "name": "model-04",
                    "name_localizations": undefined,
                    "value": "model-04",
                  },
                  {
                    "name": "model-05",
                    "name_localizations": undefined,
                    "value": "model-05",
                  },
                  {
                    "name": "model-06",
                    "name_localizations": undefined,
                    "value": "model-06",
                  },
                  {
                    "name": "model-07",
                    "name_localizations": undefined,
                    "value": "model-07",
                  },
                  {
                    "name": "model-08",
                    "name_localizations": undefined,
                    "value": "model-08",
                  },
                  {
                    "name": "model-09",
                    "name_localizations": undefined,
                    "value": "model-09",
                  },
                  {
                    "name": "model-10",
                    "name_localizations": undefined,
                    "value": "model-10",
                  },
                  {
                    "name": "model-11",
                    "name_localizations": undefined,
                    "value": "model-11",
                  },
                  {
                    "name": "model-12",
                    "name_localizations": undefined,
                    "value": "model-12",
                  },
                  {
                    "name": "model-13",
                    "name_localizations": undefined,
                    "value": "model-13",
                  },
                  {
                    "name": "model-14",
                    "name_localizations": undefined,
                    "value": "model-14",
                  },
                  {
                    "name": "model-15",
                    "name_localizations": undefined,
                    "value": "model-15",
                  },
                  {
                    "name": "model-16",
                    "name_localizations": undefined,
                    "value": "model-16",
                  },
                  {
                    "name": "model-17",
                    "name_localizations": undefined,
                    "value": "model-17",
                  },
                  {
                    "name": "model-18",
                    "name_localizations": undefined,
                    "value": "model-18",
                  },
                  {
                    "name": "model-19",
                    "name_localizations": undefined,
                    "value": "model-19",
                  },
                  {
                    "name": "model-20",
                    "name_localizations": undefined,
                    "value": "model-20",
                  },
                  {
                    "name": "model-21",
                    "name_localizations": undefined,
                    "value": "model-21",
                  },
                  {
                    "name": "model-22",
                    "name_localizations": undefined,
                    "value": "model-22",
                  },
                  {
                    "name": "model-23",
                    "name_localizations": undefined,
                    "value": "model-23",
                  },
                  {
                    "name": "model-24",
                    "name_localizations": undefined,
                    "value": "model-24",
                  },
                  {
                    "name": "model-25",
                    "name_localizations": undefined,
                    "value": "model-25",
                  },
                ],
                "description": "Model id",
                "description_localizations": undefined,
                "max_length": undefined,
                "min_length": undefined,
                "name": "id",
                "name_localizations": undefined,
                "required": true,
                "type": 3,
              },
            ],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Set this session's reasoning effort",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "effort",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "autocomplete": undefined,
                "choices": [
                  {
                    "name": "none",
                    "name_localizations": undefined,
                    "value": "none",
                  },
                  {
                    "name": "minimal",
                    "name_localizations": undefined,
                    "value": "minimal",
                  },
                  {
                    "name": "low",
                    "name_localizations": undefined,
                    "value": "low",
                  },
                  {
                    "name": "medium",
                    "name_localizations": undefined,
                    "value": "medium",
                  },
                  {
                    "name": "high",
                    "name_localizations": undefined,
                    "value": "high",
                  },
                  {
                    "name": "xhigh",
                    "name_localizations": undefined,
                    "value": "xhigh",
                  },
                  {
                    "name": "max",
                    "name_localizations": undefined,
                    "value": "max",
                  },
                ],
                "description": "Reasoning effort (validated against the current model)",
                "description_localizations": undefined,
                "max_length": undefined,
                "min_length": undefined,
                "name": "level",
                "name_localizations": undefined,
                "required": true,
                "type": 3,
              },
            ],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Set this session's context window tier",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "context",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "autocomplete": undefined,
                "choices": [
                  {
                    "name": "default",
                    "name_localizations": undefined,
                    "value": "default",
                  },
                  {
                    "name": "long_context",
                    "name_localizations": undefined,
                    "value": "long_context",
                  },
                ],
                "description": "Context tier",
                "description_localizations": undefined,
                "max_length": undefined,
                "min_length": undefined,
                "name": "tier",
                "name_localizations": undefined,
                "required": true,
                "type": 3,
              },
            ],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Show this session's token usage",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "usage",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "List (or clear) remembered command approvals",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "approvals",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "description": "Clear this session + repo approvals",
                "description_localizations": undefined,
                "name": "clear",
                "name_localizations": undefined,
                "required": false,
                "type": 5,
              },
            ],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Show a git diff summary of the controlled repo",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "diff",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "description": "Show staged (--cached) changes instead",
                "description_localizations": undefined,
                "name": "staged",
                "name_localizations": undefined,
                "required": false,
                "type": 5,
              },
            ],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Send one file from this session's workdir",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "file",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "autocomplete": undefined,
                "choices": undefined,
                "description": "Path inside this session workdir",
                "description_localizations": undefined,
                "max_length": undefined,
                "min_length": undefined,
                "name": "path",
                "name_localizations": undefined,
                "required": true,
                "type": 3,
              },
            ],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Show the agent's current todo checklist",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "todos",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "⚠️ Auto-approve EVERY permission in this session (no prompts)",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "yolo",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "autocomplete": undefined,
                "choices": [
                  {
                    "name": "on",
                    "name_localizations": undefined,
                    "value": "on",
                  },
                  {
                    "name": "off",
                    "name_localizations": undefined,
                    "value": "off",
                  },
                ],
                "description": "Turn blanket auto-approval on or off",
                "description_localizations": undefined,
                "max_length": undefined,
                "min_length": undefined,
                "name": "mode",
                "name_localizations": undefined,
                "required": true,
                "type": 3,
              },
            ],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Rename this session thread",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "rename",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "autocomplete": undefined,
                "choices": undefined,
                "description": "New title for this thread",
                "description_localizations": undefined,
                "max_length": undefined,
                "min_length": undefined,
                "name": "title",
                "name_localizations": undefined,
                "required": true,
                "type": 3,
              },
            ],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Queue a prompt to run after the current turn (a plain message steers instead)",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "queue",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "autocomplete": undefined,
                "choices": undefined,
                "description": "Prompt to run next",
                "description_localizations": undefined,
                "max_length": undefined,
                "min_length": undefined,
                "name": "message",
                "name_localizations": undefined,
                "required": false,
                "type": 3,
              },
              {
                "description": "Discard everything currently queued",
                "description_localizations": undefined,
                "name": "clear",
                "name_localizations": undefined,
                "required": false,
                "type": 5,
              },
            ],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "End THIS thread's session (other sessions keep running)",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "end",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "autocomplete": undefined,
                "choices": undefined,
                "description": "Thread id of a leftover record whose thread is gone (see /sessions)",
                "description_localizations": undefined,
                "max_length": undefined,
                "min_length": undefined,
                "name": "thread",
                "name_localizations": undefined,
                "required": false,
                "type": 3,
              },
            ],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "List the sessions running right now",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "sessions",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [],
            "type": 1,
          },
          {
            "contexts": undefined,
            "default_member_permissions": "0",
            "default_permission": undefined,
            "description": "Manage which channels this bot answers in",
            "description_localizations": undefined,
            "dm_permission": undefined,
            "integration_types": undefined,
            "name": "channel",
            "name_localizations": undefined,
            "nsfw": undefined,
            "options": [
              {
                "description": "Let sessions be started in a channel",
                "description_localizations": undefined,
                "name": "enable",
                "name_localizations": undefined,
                "options": [
                  {
                    "autocomplete": undefined,
                    "choices": undefined,
                    "description": "Channel id or #mention (default: this channel)",
                    "description_localizations": undefined,
                    "max_length": undefined,
                    "min_length": undefined,
                    "name": "channel",
                    "name_localizations": undefined,
                    "required": false,
                    "type": 3,
                  },
                ],
                "type": 1,
              },
              {
                "description": "Stop answering in a channel (end its sessions first)",
                "description_localizations": undefined,
                "name": "disable",
                "name_localizations": undefined,
                "options": [
                  {
                    "autocomplete": undefined,
                    "choices": undefined,
                    "description": "Channel id or #mention (default: this channel)",
                    "description_localizations": undefined,
                    "max_length": undefined,
                    "min_length": undefined,
                    "name": "channel",
                    "name_localizations": undefined,
                    "required": false,
                    "type": 3,
                  },
                ],
                "type": 1,
              },
              {
                "description": "Show which channels this bot answers in",
                "description_localizations": undefined,
                "name": "list",
                "name_localizations": undefined,
                "options": [],
                "type": 1,
              },
            ],
            "type": 1,
          },
        ]
      `);
    });

    it("keeps the degraded /model payload choice-free when model listing fails", () => {
      const model = buildCommandRegistrationPayload([]).find(
        (command) => command.name === "model"
      );

      expect(model).toBeDefined();
      expect(model?.options).toHaveLength(1);
      expect(model?.options?.[0]).toMatchObject({
        name: "id",
        required: true,
        choices: undefined,
      });
    });
  });

  it("rejects malformed / foreign ids", () => {
    expect(decodePermissionId("other:perm:once:n")).toBeUndefined();
    expect(decodePermissionId("dp:x:once:n")).toBeUndefined();
    expect(decodePermissionId("dp:perm:maybe:n")).toBeUndefined();
    expect(decodePermissionId("dp:perm:allow:n")).toBeUndefined(); // old action name gone
    expect(decodePermissionId("dp:perm:once:")).toBeUndefined();
    expect(decodePermissionId("dp:perm:once")).toBeUndefined();
  });

  it("stays within Discord's 100-char custom id limit for a uuid nonce", () => {
    expect(encodePermissionId("123e4567-e89b-12d3-a456-426614174000", "always").length).toBeLessThanOrEqual(100);
  });
});

describe("choice + plan custom ids", () => {
  it("round-trips a choice index", () => {
    expect(encodeChoiceId("n", 3)).toBe("dp:ask:3:n");
    expect(decodeChoiceId(encodeChoiceId("nonce-1", 0))).toEqual({ nonce: "nonce-1", index: 0 });
    expect(decodeChoiceId("dp:ask:-1:n")).toBeUndefined();
    expect(decodeChoiceId("dp:ask:x:n")).toBeUndefined();
    expect(decodeChoiceId("dp:ask:1junk:n")).toBeUndefined(); // non-all-digit rejected
    expect(decodeChoiceId("dp:perm:once:n")).toBeUndefined();
  });

  it("round-trips a plan action (index or reject)", () => {
    expect(decodePlanId(encodePlanId("n", 2))).toEqual({ nonce: "n", action: 2 });
    expect(decodePlanId(encodePlanId("n", "reject"))).toEqual({ nonce: "n", action: "reject" });
    expect(decodePlanId("dp:plan:x:n")).toBeUndefined();
    expect(decodePlanId("dp:plan:2junk:n")).toBeUndefined(); // non-all-digit rejected
    expect(decodePlanId("dp:ask:0:n")).toBeUndefined();
  });
});

describe("Discord authorization", () => {
  const policy: AuthPolicy = {
    allowedUserIds: new Set(["u1"]),
    guildId: "g1",
    parentChannelIds: new Set(["c1", "c2"]),
  };

  const context = (overrides: Partial<AuthContext> = {}): AuthContext => ({
    userId: "u1",
    guildId: "g1",
    channelId: "c1",
    parentId: null,
    ...overrides,
  });

  it("allows an allow-listed user in either enabled parent channel", () => {
    for (const channelId of ["c1", "c2"]) {
      expect(isAuthorized(context({ channelId }), policy)).toBe(true);
    }
  });

  it("allows a thread under either enabled parent channel", () => {
    for (const parentId of ["c1", "c2"]) {
      expect(isAuthorized(context({ channelId: `thread-${parentId}`, parentId }), policy)).toBe(true);
    }
  });

  it("keeps an owner outside enabled channels authorized only for bootstrap", () => {
    const outsideEnabledChannels = context({ channelId: "cX" });
    expect(isOwner(outsideEnabledChannels, policy)).toBe(true);
    expect(isAuthorized(outsideEnabledChannels, policy)).toBe(false);

    expect(isOwner(context({ guildId: "gX" }), policy)).toBe(false);
    expect(isOwner(context({ userId: "u2" }), policy)).toBe(false);
  });

  it("denies a wrong guild, user, or foreign channel", () => {
    const denied: AuthContext[] = [
      context({ guildId: "gX" }),
      context({ guildId: null }),
      context({ userId: "u2" }),
      context({ channelId: "cX", parentId: "cY" }),
    ];

    for (const unauthorized of denied) {
      expect(isAuthorized(unauthorized, policy)).toBe(false);
    }
  });
});

describe("decisionBindsToChannel (cross-thread guard, §9)", () => {
  it("allows a decision from the nonce's OWNING thread", () => {
    expect(decisionBindsToChannel({ sessionKey: "tA" }, "tA")).toBe(true);
  });

  it("REJECTS a decision arriving from a different thread (cross-thread click can't resolve)", () => {
    expect(decisionBindsToChannel({ sessionKey: "tA" }, "tB")).toBe(false);
  });

  it("rejects when there is no pending request (expired / unknown nonce)", () => {
    expect(decisionBindsToChannel(undefined, "tA")).toBe(false);
  });
});

describe("applyYoloToggle (ack-before-allow for blanket approval)", () => {
  const ctl = (): { epoch: () => number; disable: () => void; enableIfCurrent: (e: number) => boolean; state: { on: boolean; epoch: number }; log: string[] } => {
    const state = { on: false, epoch: 0 };
    const log: string[] = [];
    return {
      state,
      log,
      epoch: () => state.epoch,
      disable: () => {
        state.epoch++;
        state.on = false;
        log.push("disable");
      },
      enableIfCurrent: (e: number) => {
        if (e !== state.epoch) {
          log.push("enable:superseded");
          return false;
        }
        state.on = true;
        log.push("enable");
        return true;
      },
    };
  };

  it("enables YOLO only AFTER Discord acknowledges the warning", async () => {
    const c = ctl();
    const applied = await applyYoloToggle(
      true,
      async () => {
        c.log.push("ack");
      },
      c
    );
    expect(c.log).toEqual(["ack", "enable"]); // ack strictly first
    expect(applied).toBe(true);
    expect(c.state.on).toBe(true);
  });

  it("does NOT enable YOLO when the warning fails to post (fail-safe)", async () => {
    const c = ctl();
    await expect(
      applyYoloToggle(
        true,
        async () => {
          throw new Error("interaction failed");
        },
        c
      )
    ).rejects.toThrow("interaction failed");
    expect(c.state.on).toBe(false); // stays OFF
    expect(c.log).toEqual([]);
  });

  it("disables YOLO FIRST, even if the confirmation cannot be posted", async () => {
    const c = ctl();
    const applied = await applyYoloToggle(
      false,
      async () => {
        c.log.push("ack");
        throw new Error("interaction failed");
      },
      c
    );
    expect(c.log).toEqual(["disable", "ack"]); // applied before (and despite) the ack
    expect(applied).toBe(false);
    expect(c.state.on).toBe(false);
  });

  it("RACE: a slow /yolo on cannot re-enable after a later /yolo off confirmed OFF", async () => {
    const c = ctl();
    let releaseAck: (() => void) | undefined;
    const slowAck = (): Promise<void> =>
      new Promise<void>((r) => {
        releaseAck = r;
      });
    const enabling = applyYoloToggle(true, slowAck, c); // ack still in flight
    // meanwhile the operator turns it OFF and sees the confirmation
    const disabling = await applyYoloToggle(false, async () => {}, c);
    expect(disabling).toBe(false);
    expect(c.state.on).toBe(false);
    releaseAck!(); // the older ON ack finally resolves
    expect(await enabling).toBe(false); // superseded — must NOT re-enable
    expect(c.state.on).toBe(false);
    expect(c.log).toContain("enable:superseded");
  });
});

describe("yoloOnWarning", () => {
  it("states Windows YOLO auto-approves other permissions but fast-denies discord_send_file", () => {
    const warning = yoloOnWarning(false, true);
    expect(warning).toMatch(/other permission requests are auto-approved/i);
    expect(warning).toMatch(/discord_send_file/i);
    expect(warning).toMatch(/fast-denied/i);
    expect(warning).toMatch(/\/file path:</i);
    expect(warning).not.toMatch(/already waiting still needs your decision/i);
    expect(warning).not.toMatch(/including file writes and other kinds that are normally refused/i);
  });

  it("preserves the repository-skill warning while staying truthful about Windows file delivery", () => {
    const warning = yoloOnWarning(true, true);
    expect(warning).toMatch(/repository skills/i);
    expect(warning).toMatch(/YOLO/i);
    expect(warning).toMatch(/Discord approval gate/i);
    expect(warning).toMatch(/discord_send_file/i);
    expect(warning).toMatch(/\/file path:</i);
  });

  it("states non-Windows outbound delivery is unavailable instead of claiming file fallback", () => {
    const warning = yoloOnWarning(false, false);
    expect(warning).toMatch(/outbound Discord file delivery is unavailable on this platform/i);
    expect(warning).not.toMatch(/discord_send_file/i);
    expect(warning).not.toMatch(/fast-denied/i);
    expect(warning).not.toMatch(/\/file path:</i);
  });

  it("does not claim repository skills when none were loaded", () => {
    expect(yoloOnWarning(false, true)).not.toMatch(/repository skills/i);
  });
});

describe("approvalScopeKeys (/approvals must not lie about revocation)", () => {
  it("covers the live session even when the command is run from the parent channel", () => {
    // The bug: scoping to interaction.channelId meant /approvals clear:true from
    // the parent channel cleared only the on-disk repo rules, left the live
    // session's in-memory rules intact, and still replied "Cleared approvals …
    // Future commands will prompt again."
    expect(approvalScopeKeys(["thread-1"])).toEqual(["thread-1"]);
  });

  it("covers the session when run INSIDE its own thread (same answer)", () => {
    expect(approvalScopeKeys(["thread-1"])).toContain("thread-1");
  });

  it("is empty when nothing is live — there is genuinely nothing in memory to clear", () => {
    expect(approvalScopeKeys([])).toEqual([]);
  });

  it("de-duplicates", () => {
    expect(approvalScopeKeys(["a", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("resolveButtonAck (ack-before-settle)", () => {
  it("delivers the user's decision only after a successful Discord ack", async () => {
    const order: string[] = [];
    const deliver = (d: string) => order.push(`deliver:${d}`);
    await resolveButtonAck(
      async () => {
        order.push("ack");
      },
      deliver,
      "once"
    );
    expect(order).toEqual(["ack", "deliver:once"]); // ack strictly first
  });

  it("delivers DENY (never an approval) if the ack fails", async () => {
    const deliver = vi.fn();
    await resolveButtonAck(
      async () => {
        throw new Error("interaction failed");
      },
      deliver,
      "always"
    );
    expect(deliver).toHaveBeenCalledWith("deny");
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
