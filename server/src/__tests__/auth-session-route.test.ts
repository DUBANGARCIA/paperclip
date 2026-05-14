import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb() {
  return {
    select: vi
      .fn()
      .mockImplementationOnce(() => createSelectChain([]))
      .mockImplementationOnce(() => createSelectChain([])),
  } as any;
}

describe("actorMiddleware authenticated session profile", () => {
  const originalCloudTenantToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;

  afterEach(() => {
    if (originalCloudTenantToken === undefined) delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    else process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = originalCloudTenantToken;
  });

  it("preserves the signed-in user name and email on the board actor", async () => {
    const app = express();
    app.use(
      actorMiddleware(createDb(), {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: {
            id: "user-1",
            name: "User One",
            email: "user@example.com",
          },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "user-1",
      userName: "User One",
      userEmail: "user@example.com",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });
  });

  it("trusts Cloud tenant identity headers and seeds board access", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-token";
    const inserts: Array<{ values: Record<string, unknown> }> = [];
    const db = {
      insert: vi.fn(() => {
        const chain = {
          values(values: Record<string, unknown>) {
            inserts.push({ values });
            return chain;
          },
          onConflictDoUpdate() {
            return chain;
          },
          onConflictDoNothing() {
            return chain;
          },
          returning() {
            return Promise.resolve([{
              companyId: inserts.at(-1)?.values.companyId,
              membershipRole: inserts.at(-1)?.values.membershipRole,
              status: inserts.at(-1)?.values.status,
            }]);
          },
        };
        return chain;
      }),
      select: vi.fn(),
    } as any;
    const app = express();
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-cloud-tenant-token", "tenant-token")
      .set("x-paperclip-cloud-user-id", "global-user-1")
      .set("x-paperclip-cloud-user-email", "owner@example.com")
      .set("x-paperclip-cloud-user-name", "Stack Owner")
      .set("x-paperclip-cloud-stack-id", "stack-alpha")
      .set("x-paperclip-cloud-paperclip-company-id", "paperclip-stack-alpha")
      .set("x-paperclip-cloud-stack-role", "owner");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "global-user-1",
      userName: "Stack Owner",
      userEmail: "owner@example.com",
      source: "cloud_tenant",
      isInstanceAdmin: true,
      memberships: [expect.objectContaining({ membershipRole: "owner", status: "active" })],
    });
    expect(res.body.companyIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserts).toHaveLength(4);
    expect(inserts[0]?.values).toMatchObject({
      id: "global-user-1",
      email: "owner@example.com",
      emailVerified: true,
    });
  });
});

describe("actorMiddleware agent JWT run_id precedence", () => {
  const agentId = "33333333-3333-4333-8333-333333333333";
  const companyId = "44444444-4444-4444-8444-444444444444";
  const claimRunId = "11111111-1111-4111-8111-111111111111";
  const headerRunId = "22222222-2222-4222-8222-222222222222";
  const originalJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret-jwt-runid";
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalJwtSecret;
  });

  // BRA-2204: the harness's X-Paperclip-Run-Id header was a workaround for a
  // different bug (BRA-2187) and must not override the JWT's authoritative
  // run_id claim. Otherwise any caller authenticated as agent A can replay a
  // stale checkoutRunId from a previous run of agent A and mutate that
  // checkout — same-agent cross-run spoofing.
  function createAgentJwtDb(opts: { boardKeys?: unknown[]; agentKeys?: unknown[]; agentRow?: unknown }) {
    const queue: Array<{ rows: unknown[] }> = [
      { rows: opts.boardKeys ?? [] }, // findBoardApiKeyByToken
      { rows: opts.agentKeys ?? [] }, // agentApiKeys lookup
      { rows: opts.agentRow ? [opts.agentRow] : [] }, // agents lookup
    ];

    return {
      select: vi.fn(() => {
        const batch = queue.shift() ?? { rows: [] };
        return {
          from() {
            return {
              where() {
                return Promise.resolve(batch.rows);
              },
            };
          },
        };
      }),
      update: vi.fn(() => ({
        set() {
          return {
            where() {
              return Promise.resolve(undefined);
            },
          };
        },
      })),
    } as any;
  }

  it("uses the JWT run_id claim and ignores a divergent X-Paperclip-Run-Id header", async () => {
    const db = createAgentJwtDb({
      agentRow: { id: agentId, companyId, status: "active" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "claude_local", claimRunId);
    expect(token).toBeTruthy();

    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.get("/actor", (req, res) => res.json(req.actor));

    const res = await request(app)
      .get("/actor")
      .set("authorization", `Bearer ${token}`)
      .set("x-paperclip-run-id", headerRunId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      source: "agent_jwt",
      runId: claimRunId,
    });
    expect(res.body.runId).not.toBe(headerRunId);
  });

  it("falls back to the header runId when the JWT claim is absent (legacy/non-JWT path)", async () => {
    // Simulate an agent_key bearer (no JWT claim): the header is the only signal,
    // and we keep it for backwards compatibility with the BRA-2187 workaround.
    const db = createAgentJwtDb({
      agentKeys: [{ id: "key-1", agentId, companyId }],
      agentRow: { id: agentId, companyId, status: "active" },
    });

    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.get("/actor", (req, res) => res.json(req.actor));

    const res = await request(app)
      .get("/actor")
      .set("authorization", "Bearer ak_test_token")
      .set("x-paperclip-run-id", headerRunId);

    // agent_key path: header survives as the only available runId signal.
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("agent_key");
    expect(res.body.runId).toBe(headerRunId);
  });
});
