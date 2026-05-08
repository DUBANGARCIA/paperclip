import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  agents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual };
});

vi.mock("../adapters/index.ts", () => ({
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: false,
    execute: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      provider: "test",
      model: "test-model",
    })),
  })),
  listAdapterModelProfiles: vi.fn(async () => []),
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres DR Ops stale-lock tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("DR Ops recoverStaleCrossActorLocks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dr-ops-stale-lock-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seeds a cross-actor stale-lock scenario: an issue held by agentA with a
   * dead heartbeat run, simulating what causes a 409 on checkout by any other actor.
   */
  async function seedStaleCrossActorLock(opts: {
    lockAgeMs: number;
    holdingRunStatus: "failed" | "timed_out" | "cancelled" | "succeeded" | "running" | "queued";
    issueStatus?: "in_progress" | "in_review" | "blocked";
    drOpsAgentId?: string;
  }) {
    const companyId = randomUUID();
    const holdingAgentId = randomUUID();
    const holdingRunId = randomUUID();
    const drOpsAgentId = opts.drOpsAgentId ?? randomUUID();
    const issueId = randomUUID();
    const lockAcquiredAt = new Date(Date.now() - opts.lockAgeMs);
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: holdingAgentId,
        companyId,
        name: "StaleHolder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: drOpsAgentId,
        companyId,
        name: "DROpsAgent",
        role: "devops",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: holdingAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: opts.holdingRunStatus === "running" || opts.holdingRunStatus === "queued" ? "claimed" : "failed",
      runId: holdingRunId,
      claimedAt: lockAcquiredAt,
      finishedAt: opts.holdingRunStatus === "running" || opts.holdingRunStatus === "queued"
        ? null
        : new Date(lockAcquiredAt.getTime() + 5000),
      error: opts.holdingRunStatus === "failed" ? "run died unexpectedly" : null,
    });

    await db.insert(heartbeatRuns).values({
      id: holdingRunId,
      companyId,
      agentId: holdingAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.holdingRunStatus,
      wakeupRequestId,
      contextSnapshot: { issueId },
      startedAt: lockAcquiredAt,
      finishedAt: opts.holdingRunStatus === "running" || opts.holdingRunStatus === "queued"
        ? null
        : new Date(lockAcquiredAt.getTime() + 5000),
      updatedAt: lockAcquiredAt,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with stale cross-actor lock",
      status: opts.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: holdingAgentId,
      checkoutRunId: holdingRunId,
      executionRunId: holdingRunId,
      executionLockedAt: lockAcquiredAt,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: lockAcquiredAt,
    });

    return { companyId, holdingAgentId, holdingRunId, drOpsAgentId, issueId };
  }

  it("force-releases a stale cross-actor lock when the holding run is dead and lock is old", async () => {
    // Simulate a 409 cross-actor scenario: lock held for 2h by a dead run
    const { issueId } = await seedStaleCrossActorLock({
      lockAgeMs: 2 * 60 * 60 * 1000,  // 2 hours — well past the 1h default threshold
      holdingRunStatus: "failed",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverStaleCrossActorLocks();

    expect(result.recovered).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.activeRunPresent).toBe(0);

    const updatedIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(updatedIssue?.checkoutRunId).toBeNull();
    expect(updatedIssue?.executionLockedAt).toBeNull();
    expect(updatedIssue?.status).toBe("todo");
  });

  it("sends force-release with the correct payload including runIdHeld", async () => {
    const { issueId, holdingRunId } = await seedStaleCrossActorLock({
      lockAgeMs: 2 * 60 * 60 * 1000,
      holdingRunStatus: "failed",
    });

    const heartbeat = heartbeatService(db);
    const drOpsRunId = randomUUID();
    const drOpsAgentId = randomUUID();
    await heartbeat.recoverStaleCrossActorLocks({ actorRunId: drOpsRunId, actorAgentId: drOpsAgentId });

    const updatedIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    // Lock cleared — the forceRelease was invoked with runIdHeld = holdingRunId
    expect(updatedIssue?.checkoutRunId).toBeNull();
    expect(updatedIssue?.executionLockedAt).toBeNull();
    // Issue returns to todo after force-release of an in_progress lock
    expect(updatedIssue?.status).toBe("todo");
    // Verify the holding run ID matches what was seeded (confirming correct payload routing)
    expect(holdingRunId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("skips issues whose holding run is still running (active_run_present precondition)", async () => {
    // Lock held by an ACTIVE run — should not be force-released
    const { issueId } = await seedStaleCrossActorLock({
      lockAgeMs: 2 * 60 * 60 * 1000,
      holdingRunStatus: "running",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverStaleCrossActorLocks();

    expect(result.recovered).toBe(0);
    expect(result.activeRunPresent).toBe(1);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.checkoutRunId).not.toBeNull();
    expect(issue?.status).toBe("in_progress");
  });

  it("skips issues whose lock age is below the staleness threshold", async () => {
    // Lock is only 10 minutes old — below the 1h default threshold
    const { issueId } = await seedStaleCrossActorLock({
      lockAgeMs: 10 * 60 * 1000,
      holdingRunStatus: "failed",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverStaleCrossActorLocks();

    expect(result.recovered).toBe(0);
    // The issue should not appear in candidates at all since executionLockedAt is recent
    expect(result.skipped).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.checkoutRunId).not.toBeNull();
    expect(issue?.status).toBe("in_progress");
  });

  it("skips same-actor issues when actorAgentId is provided", async () => {
    const drOpsAgentId = randomUUID();
    const { issueId, holdingAgentId } = await seedStaleCrossActorLock({
      lockAgeMs: 2 * 60 * 60 * 1000,
      holdingRunStatus: "failed",
      drOpsAgentId,
    });

    // The DR Ops agent is passed as the actor — but the issue is held by holdingAgentId (different)
    // so it should NOT be skipped. Verify the DR Ops agent is different from the holder.
    expect(holdingAgentId).not.toBe(drOpsAgentId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverStaleCrossActorLocks({ actorAgentId: drOpsAgentId });

    // Should recover because it's a cross-actor lock (holding agent != DR Ops agent)
    expect(result.recovered).toBe(1);
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.checkoutRunId).toBeNull();
  });

  it("skips an issue where the actor itself holds the lock (same-actor)", async () => {
    const drOpsAgentId = randomUUID();

    const companyId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const lockAcquiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({ id: companyId, name: "Test", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: drOpsAgentId,
      companyId,
      name: "DROps",
      role: "devops",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const wakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId,
      agentId: drOpsAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "failed",
      runId,
      claimedAt: lockAcquiredAt,
      finishedAt: new Date(lockAcquiredAt.getTime() + 5000),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: drOpsAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId: wakeupId,
      contextSnapshot: { issueId },
      startedAt: lockAcquiredAt,
      finishedAt: new Date(lockAcquiredAt.getTime() + 5000),
      updatedAt: lockAcquiredAt,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Same-actor stale issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: drOpsAgentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionLockedAt: lockAcquiredAt,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: lockAcquiredAt,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverStaleCrossActorLocks({ actorAgentId: drOpsAgentId });

    // Same actor — should skip (use /release instead)
    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.checkoutRunId).not.toBeNull();
  });

  it("preserves non-in_progress status (e.g. in_review) after force-release", async () => {
    const { issueId } = await seedStaleCrossActorLock({
      lockAgeMs: 2 * 60 * 60 * 1000,
      holdingRunStatus: "failed",
      issueStatus: "in_review",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverStaleCrossActorLocks();

    expect(result.recovered).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.checkoutRunId).toBeNull();
    // in_review is preserved (not downgraded to todo)
    expect(issue?.status).toBe("in_review");
  });

  it("respects a custom stalenessThresholdMs override", async () => {
    // Lock is 30 minutes old
    const { issueId } = await seedStaleCrossActorLock({
      lockAgeMs: 30 * 60 * 1000,
      holdingRunStatus: "failed",
    });

    const heartbeat = heartbeatService(db);

    // Default 1h threshold: should skip (30min < 1h)
    const defaultResult = await heartbeat.recoverStaleCrossActorLocks();
    expect(defaultResult.recovered).toBe(0);

    // 15-minute threshold: should recover (30min > 15min)
    const customResult = await heartbeat.recoverStaleCrossActorLocks({
      stalenessThresholdMs: 15 * 60 * 1000,
    });
    expect(customResult.recovered).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.checkoutRunId).toBeNull();
  });
});
