import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
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
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres checkout recover route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("POST /api/issues/:id/checkout/recover", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-recover-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  async function seedCompanyAndAgents() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Owner",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, ownerAgentId, otherAgentId };
  }

  async function insertRun(
    companyId: string,
    agentId: string,
    overrides: Partial<typeof heartbeatRuns.$inferInsert> = {},
  ) {
    const id = overrides.id ?? randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "manual",
      ...overrides,
    });
    return id;
  }

  async function insertIssue(
    companyId: string,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ) {
    const id = overrides.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Recovery test",
      status: overrides.status ?? "in_progress",
      priority: overrides.priority ?? "high",
      executionAgentNameKey: "owner",
      executionLockedAt: new Date(),
      ...overrides,
    });
    return id;
  }

  it("adopts a checkout whose prior run is terminal and writes the audit row", async () => {
    const { companyId, ownerAgentId } = await seedCompanyAndAgents();
    const priorRunId = await insertRun(companyId, ownerAgentId, { status: "failed", finishedAt: new Date() });
    const currentRunId = await insertRun(companyId, ownerAgentId, { status: "running", startedAt: new Date() });

    const issueId = await insertIssue(companyId, {
      assigneeAgentId: ownerAgentId,
      checkoutRunId: priorRunId,
      executionRunId: priorRunId,
    });

    const res = await request(createApp(agentActor(companyId, ownerAgentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout/recover`)
      .send({ agentId: ownerAgentId, reason: "stale_run_checkout" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: issueId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      assigneeAgentId: ownerAgentId,
    });

    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_checkout_recovered"))
      .then((rows) => rows[0]);
    expect(audit).toMatchObject({
      action: "issue.stale_checkout_recovered",
      entityType: "issue",
      entityId: issueId,
      details: {
        issueId,
        actorAgentId: ownerAgentId,
        actorRunId: currentRunId,
        prevCheckoutRunId: priorRunId,
        prevExecutionRunId: priorRunId,
        priorRunStatus: "terminal",
        reason: "stale_run_checkout",
      },
    });
  });

  it("adopts a checkout whose prior run is non-terminal but past the staleness window", async () => {
    const { companyId, ownerAgentId } = await seedCompanyAndAgents();
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const zombieRunId = await insertRun(companyId, ownerAgentId, {
      status: "running",
      startedAt: tenMinAgo,
      processStartedAt: tenMinAgo,
      lastOutputAt: tenMinAgo,
    });
    const currentRunId = await insertRun(companyId, ownerAgentId, { status: "running", startedAt: new Date() });

    const issueId = await insertIssue(companyId, {
      assigneeAgentId: ownerAgentId,
      checkoutRunId: zombieRunId,
      executionRunId: zombieRunId,
    });

    const res = await request(createApp(agentActor(companyId, ownerAgentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout/recover`)
      .send({ agentId: ownerAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: issueId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_checkout_recovered"))
      .then((rows) => rows[0]);
    expect(audit?.details).toMatchObject({
      prevCheckoutRunId: zombieRunId,
      priorRunStatus: "stale_running",
    });
  });

  it("rejects 422 when the prior run is still live", async () => {
    const { companyId, ownerAgentId } = await seedCompanyAndAgents();
    const liveRunId = await insertRun(companyId, ownerAgentId, {
      status: "running",
      startedAt: new Date(),
      processStartedAt: new Date(),
      lastOutputAt: new Date(),
    });
    const currentRunId = await insertRun(companyId, ownerAgentId, { status: "running", startedAt: new Date() });

    const issueId = await insertIssue(companyId, {
      assigneeAgentId: ownerAgentId,
      checkoutRunId: liveRunId,
      executionRunId: liveRunId,
    });

    const res = await request(createApp(agentActor(companyId, ownerAgentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout/recover`)
      .send({ agentId: ownerAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe("Prior checkout run is still live");
    expect(res.body.details).toMatchObject({
      issueId,
      priorRunId: liveRunId,
      priorRunStatus: "running",
    });

    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBe(liveRunId);
  });

  it("rejects 422 cross-agent recovery and does not mutate the issue", async () => {
    const { companyId, ownerAgentId, otherAgentId } = await seedCompanyAndAgents();
    const priorRunId = await insertRun(companyId, ownerAgentId, { status: "failed", finishedAt: new Date() });
    const intruderRunId = await insertRun(companyId, otherAgentId, { status: "running", startedAt: new Date() });

    const issueId = await insertIssue(companyId, {
      assigneeAgentId: ownerAgentId,
      checkoutRunId: priorRunId,
      executionRunId: priorRunId,
    });

    const res = await request(createApp(agentActor(companyId, otherAgentId, intruderRunId)))
      .post(`/api/issues/${issueId}/checkout/recover`)
      .send({ agentId: otherAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toMatch(/assignee agent/i);

    const row = await db
      .select({ assigneeAgentId: issues.assigneeAgentId, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ assigneeAgentId: ownerAgentId, checkoutRunId: priorRunId });
  });

  it("rejects 403 when the body agentId does not match the actor", async () => {
    const { companyId, ownerAgentId, otherAgentId } = await seedCompanyAndAgents();
    const priorRunId = await insertRun(companyId, ownerAgentId, { status: "failed" });
    const actorRunId = await insertRun(companyId, ownerAgentId, { status: "running", startedAt: new Date() });

    const issueId = await insertIssue(companyId, {
      assigneeAgentId: ownerAgentId,
      checkoutRunId: priorRunId,
      executionRunId: priorRunId,
    });

    const res = await request(createApp(agentActor(companyId, ownerAgentId, actorRunId)))
      .post(`/api/issues/${issueId}/checkout/recover`)
      .send({ agentId: otherAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it("rejects 403 when called by a board actor", async () => {
    const { companyId, ownerAgentId } = await seedCompanyAndAgents();
    const priorRunId = await insertRun(companyId, ownerAgentId, { status: "failed" });

    const issueId = await insertIssue(companyId, {
      assigneeAgentId: ownerAgentId,
      checkoutRunId: priorRunId,
      executionRunId: priorRunId,
    });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/checkout/recover`)
      .send({ agentId: ownerAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toMatch(/admin\/force-release/i);
  });

  it("acts as a clean (re)acquire when no existing checkout is held", async () => {
    const { companyId, ownerAgentId } = await seedCompanyAndAgents();
    const currentRunId = await insertRun(companyId, ownerAgentId, { status: "running", startedAt: new Date() });

    const issueId = await insertIssue(companyId, {
      assigneeAgentId: ownerAgentId,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });

    const res = await request(createApp(agentActor(companyId, ownerAgentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout/recover`)
      .send({ agentId: ownerAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: issueId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_checkout_recovered"))
      .then((rows) => rows[0]);
    expect(audit?.details).toMatchObject({ priorRunStatus: "missing" });
  });

  it("is idempotent when the current run already owns the checkout", async () => {
    const { companyId, ownerAgentId } = await seedCompanyAndAgents();
    const currentRunId = await insertRun(companyId, ownerAgentId, { status: "running", startedAt: new Date() });

    const issueId = await insertIssue(companyId, {
      assigneeAgentId: ownerAgentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });

    const res = await request(createApp(agentActor(companyId, ownerAgentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout/recover`)
      .send({ agentId: ownerAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: issueId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });
});
