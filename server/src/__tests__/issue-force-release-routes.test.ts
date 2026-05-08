import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  forceRelease: vi.fn(),
  addComment: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerModuleMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => ({ getById: vi.fn(async () => null) }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);

  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeLockedIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    assigneeUserId: null,
    checkoutRunId: "stale-run-id",
    executionLockedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    identifier: "PAP-1906",
    title: "Stale locked issue",
    ...overrides,
  };
}

function makeForceReleaseResult(issue: ReturnType<typeof makeLockedIssue>) {
  return {
    ...issue,
    status: "todo",
    assigneeAgentId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionLockedAt: null,
    forceReleased: true as const,
    clearedRunId: "stale-run-id",
    reasonCode: "stale_cross_actor" as const,
    actorAgentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    actorRunId: "actor-run-id",
    reason: null,
    stalenessMs: 2 * 60 * 60 * 1000,
  };
}

const AGENT_WITH_PERMISSION = {
  type: "agent",
  agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  companyId: "company-1",
  runId: "actor-run-id",
};

describe("POST /api/issues/:id/force-release", () => {
  beforeAll(async () => {
    // Pre-warm module loading so subsequent tests don't hit the cold-start timeout.
    registerModuleMocks();
    await vi.importActual("../routes/issues.js");
    await vi.importActual("../middleware/index.js");
  }, 20_000);

  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeLockedIssue());
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "Force-release applied" });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("returns 404 when the issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const app = await installActor(express().use(express.json()));

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/force-release")
      .send({});

    expect(res.status).toBe(404);
  });

  it("returns 403 for an anonymous non-admin board actor", async () => {
    const app = await installActor(express().use(express.json()), {
      type: "board",
      userId: "some-user",
      companyIds: ["company-1"],
      source: "authenticated",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/force-release")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "force_release_unauthorized" });
  });

  it("returns 403 for an agent without issues:force_release permission", async () => {
    const app = await installActor(express().use(express.json()), AGENT_WITH_PERMISSION);

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/force-release")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "force_release_unauthorized" });
    expect(mockIssueService.forceRelease).not.toHaveBeenCalled();
  });

  it("returns 409 same_actor_use_release when caller is the issue assignee", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    const app = await installActor(express().use(express.json()), {
      type: "agent",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      runId: "actor-run-id",
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/force-release")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "same_actor_use_release" });
    expect(mockIssueService.forceRelease).not.toHaveBeenCalled();
  });

  it("returns 409 lock_not_stale when the service rejects a fresh lock", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    const { HttpError } = await import("../errors.js");
    mockIssueService.forceRelease.mockRejectedValue(new HttpError(409, "lock_not_stale"));
    const app = await installActor(express().use(express.json()), AGENT_WITH_PERMISSION);

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/force-release")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "lock_not_stale" });
  });

  it("returns 409 active_run_present when the service detects a live run", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    const { HttpError } = await import("../errors.js");
    mockIssueService.forceRelease.mockRejectedValue(new HttpError(409, "active_run_present"));
    const app = await installActor(express().use(express.json()), AGENT_WITH_PERMISSION);

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/force-release")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "active_run_present" });
  });

  it("returns 200 and clears the lock for a stale cross-actor lock (in_progress → todo)", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    const issue = makeLockedIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.forceRelease.mockResolvedValue(makeForceReleaseResult(issue));
    const app = await installActor(express().use(express.json()), AGENT_WITH_PERMISSION);

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/force-release")
      .send({ reason: "stale lock from DR routine", runIdHeld: "stale-run-id" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      forceReleased: true,
      clearedRunId: "stale-run-id",
      reasonCode: "stale_cross_actor",
    });
  });

  it("posts a system comment on success", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    const issue = makeLockedIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.forceRelease.mockResolvedValue(makeForceReleaseResult(issue));
    const app = await installActor(express().use(express.json()), AGENT_WITH_PERMISSION);

    await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/force-release")
      .send({});

    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("Force-release applied"),
      expect.objectContaining({ agentId: undefined, userId: undefined, runId: null }),
    );
  });

  it("logs activity with issue.force_released action on success", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    const issue = makeLockedIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.forceRelease.mockResolvedValue(makeForceReleaseResult(issue));
    const app = await installActor(express().use(express.json()), AGENT_WITH_PERMISSION);

    await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/force-release")
      .send({});

    await vi.waitFor(() => {
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.force_released",
          entityType: "issue",
          entityId: "11111111-1111-4111-8111-111111111111",
          details: expect.objectContaining({
            clearedRunId: "stale-run-id",
            reasonCode: "stale_cross_actor",
          }),
        }),
      );
    });
  });

  it("allows board instance admin as emergency bypass without permission check", async () => {
    const issue = makeLockedIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.forceRelease.mockResolvedValue(makeForceReleaseResult(issue));
    const app = await installActor(express().use(express.json()), {
      type: "board",
      userId: "admin-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/force-release")
      .send({});

    expect(res.status).toBe(200);
    expect(mockAccessService.hasPermission).not.toHaveBeenCalled();
  });

  it("preserves in_review status after force-release", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    const issue = makeLockedIssue({ status: "in_review" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.forceRelease.mockResolvedValue({
      ...makeForceReleaseResult(issue),
      status: "in_review",
    });
    const app = await installActor(express().use(express.json()), AGENT_WITH_PERMISSION);

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/force-release")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ forceReleased: true, status: "in_review" });
  });

  it("preserves blocked status after force-release", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    const issue = makeLockedIssue({ status: "blocked" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.forceRelease.mockResolvedValue({
      ...makeForceReleaseResult(issue),
      status: "blocked",
    });
    const app = await installActor(express().use(express.json()), AGENT_WITH_PERMISSION);

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/force-release")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ forceReleased: true, status: "blocked" });
  });
});
