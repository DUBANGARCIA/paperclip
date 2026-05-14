import { randomUUID } from "node:crypto";
import { eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Unused in reaper tests.",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-checkout reaper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeEmbeddedPostgres("reapStaleCheckouts", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-checkout-reaper-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRun(companyId: string, agentId: string, opts: {
    status: string;
    lastOutputAt?: Date | null;
    processStartedAt?: Date | null;
    startedAt?: Date | null;
  }) {
    const runId = randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: opts.status,
      invocationSource: "assignment",
      startedAt: opts.startedAt ?? now,
      finishedAt: ["succeeded", "failed", "cancelled", "timed_out"].includes(opts.status) ? now : null,
      lastOutputAt: opts.lastOutputAt !== undefined ? opts.lastOutputAt : now,
      processStartedAt: opts.processStartedAt !== undefined ? opts.processStartedAt : now,
    });
    return runId;
  }

  async function seedIssueWithCheckout(
    companyId: string,
    agentId: string,
    checkoutRunId: string,
    executionLockedAt: Date,
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId,
      executionRunId: checkoutRunId,
      executionLockedAt,
      executionAgentNameKey: "codexcoder",
    });
    return issueId;
  }

  it("reaps a checkout whose run is in a terminal state", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId, { status: "failed" });
    const issueId = await seedIssueWithCheckout(companyId, agentId, runId, new Date(Date.now() - 20 * 60 * 1000));

    const result = await heartbeat.reapStaleCheckouts();

    expect(result.reaped).toBe(1);
    expect(result.details[0]).toMatchObject({ issueId, reaperRunId: runId, reason: "run_terminal:failed" });

    const row = await db.select({
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
      executionLockedAt: issues.executionLockedAt,
    }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBeNull();
    expect(row?.executionRunId).toBeNull();
    expect(row?.executionLockedAt).toBeNull();
  });

  it("reaps a checkout whose run row is missing", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const missingRunId = randomUUID(); // never inserted
    const issueId = await seedIssueWithCheckout(companyId, agentId, missingRunId, new Date(Date.now() - 20 * 60 * 1000));

    const result = await heartbeat.reapStaleCheckouts();

    expect(result.reaped).toBe(1);
    expect(result.details[0]).toMatchObject({ issueId, reaperRunId: missingRunId, reason: "run_missing" });

    const row = await db.select({ checkoutRunId: issues.checkoutRunId })
      .from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBeNull();
  });

  it("does not reap a checkout whose run is live (recent output)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId, {
      status: "running",
      lastOutputAt: new Date(), // very recent
      processStartedAt: new Date(),
    });
    const issueId = await seedIssueWithCheckout(companyId, agentId, runId, new Date(Date.now() - 20 * 60 * 1000));

    const result = await heartbeat.reapStaleCheckouts({ staleThresholdMs: 15 * 60 * 1000 });

    expect(result.reaped).toBe(0);

    const row = await db.select({ checkoutRunId: issues.checkoutRunId })
      .from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBe(runId);
  });

  it("preserves a freshly-checked-out running checkout within the threshold window", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const runId = await seedRun(companyId, agentId, {
      status: "running",
      lastOutputAt: null,       // no output yet
      processStartedAt: null,   // process not started yet
      startedAt: twoMinutesAgo,
    });
    const issueId = await seedIssueWithCheckout(companyId, agentId, runId, twoMinutesAgo);

    // Use a 15-minute threshold — 2 minutes is well within it.
    const result = await heartbeat.reapStaleCheckouts({ staleThresholdMs: 15 * 60 * 1000 });

    expect(result.reaped).toBe(0);

    const row = await db.select({ checkoutRunId: issues.checkoutRunId })
      .from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBe(runId);
  });

  it("reaps a silent running checkout that is older than the threshold", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
    const runId = await seedRun(companyId, agentId, {
      status: "running",
      lastOutputAt: null,          // no output
      processStartedAt: null,      // no process signal
      startedAt: twentyMinutesAgo,
    });
    const issueId = await seedIssueWithCheckout(companyId, agentId, runId, twentyMinutesAgo);

    const result = await heartbeat.reapStaleCheckouts({ staleThresholdMs: 15 * 60 * 1000 });

    expect(result.reaped).toBe(1);
    expect(result.details[0]).toMatchObject({ issueId, reaperRunId: runId, reason: "run_stale" });
  });

  it("emits a stale_checkout_reaped audit log entry", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId, { status: "cancelled" });
    const issueId = await seedIssueWithCheckout(companyId, agentId, runId, new Date(Date.now() - 20 * 60 * 1000));

    await heartbeat.reapStaleCheckouts();

    const audit = await db
      .select({
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_checkout_reaped"))
      .then((rows) => rows[0] ?? null);

    expect(audit).not.toBeNull();
    expect(audit?.actorType).toBe("system");
    expect(audit?.actorId).toBe("system");
    expect(audit?.details).toMatchObject({
      issueId,
      reaperRunId: runId,
      reason: "run_terminal:cancelled",
    });
  });

  it("fires an assignee wakeup after reaping", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId, { status: "timed_out" });
    const issueId = await seedIssueWithCheckout(companyId, agentId, runId, new Date(Date.now() - 20 * 60 * 1000));

    await heartbeat.reapStaleCheckouts();

    const wakeup = await db
      .select({ agentId: agentWakeupRequests.agentId, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    expect(wakeup).not.toBeNull();
    expect(wakeup?.agentId).toBe(agentId);
    expect(wakeup?.reason).toBe("stale_checkout_reaped");
  });

  it("handles multiple issues in a single sweep", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const failedRunId = await seedRun(companyId, agentId, { status: "failed" });
    const succeededRunId = await seedRun(companyId, agentId, { status: "succeeded" });
    const liveRunId = await seedRun(companyId, agentId, {
      status: "running",
      lastOutputAt: new Date(),
      processStartedAt: new Date(),
    });

    const staleIssue1 = await seedIssueWithCheckout(companyId, agentId, failedRunId, new Date(Date.now() - 20 * 60 * 1000));
    const staleIssue2 = await seedIssueWithCheckout(companyId, agentId, succeededRunId, new Date(Date.now() - 20 * 60 * 1000));
    const liveIssue = await seedIssueWithCheckout(companyId, agentId, liveRunId, new Date(Date.now() - 20 * 60 * 1000));

    const result = await heartbeat.reapStaleCheckouts({ staleThresholdMs: 15 * 60 * 1000 });

    expect(result.reaped).toBe(2);
    const reapedIds = result.details.map((d) => d.issueId).sort();
    expect(reapedIds).toEqual([staleIssue1, staleIssue2].sort());

    const liveRow = await db
      .select({ checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, liveIssue))
      .then((rows) => rows[0]);
    expect(liveRow?.checkoutRunId).toBe(liveRunId);
  });

  it("is idempotent: re-running after a reap finds no stale checkouts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId, { status: "failed" });
    await seedIssueWithCheckout(companyId, agentId, runId, new Date(Date.now() - 20 * 60 * 1000));

    const first = await heartbeat.reapStaleCheckouts();
    const second = await heartbeat.reapStaleCheckouts();

    expect(first.reaped).toBe(1);
    expect(second.reaped).toBe(0);
  });
});
