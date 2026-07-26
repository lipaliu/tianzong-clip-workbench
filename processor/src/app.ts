import Fastify, { type FastifyInstance } from "fastify";
import type { ProcessorConfig } from "./config.js";
import { sha256Hex } from "./canonical.js";
import { checkDatabase, type Database } from "./db.js";
import { publicError } from "./errors.js";
import { verifyInternalRequest } from "./auth.js";
import { ProcessorRepository } from "./repository.js";
import { registerRoutes } from "./routes.js";
import { PrivateObjectStorage } from "./storage.js";

export type AppDependencies = {
  config: ProcessorConfig;
  database: Database;
  repository?: ProcessorRepository;
  storage?: PrivateObjectStorage;
};

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, database } = dependencies;
  const repository = dependencies.repository ?? new ProcessorRepository(database, config);
  const storage = dependencies.storage ?? new PrivateObjectStorage(config);
  const coreVerificationTtlMs = 5 * 60 * 1_000;
  let coreVerifiedAt = 0;
  let coreVerificationInFlight: Promise<void> | null = null;

  const verifyPinnedPrivateCore = async () => {
    if (Date.now() - coreVerifiedAt < coreVerificationTtlMs) return;
    if (coreVerificationInFlight) return coreVerificationInFlight;

    coreVerificationInFlight = (async () => {
      const coreObject = await storage.head(config.core.objectKey);
      if (!coreObject.ContentLength || coreObject.ContentLength <= 0) {
        throw new Error("private core object is empty");
      }
      const coreBytes = await storage.getBuffer(config.core.objectKey);
      if (
        coreBytes.byteLength !== coreObject.ContentLength
        || sha256Hex(coreBytes) !== config.core.sha256
      ) {
        throw new Error("private core object does not match the pinned SHA-256");
      }
      coreVerifiedAt = Date.now();
    })();

    try {
      await coreVerificationInFlight;
    } finally {
      coreVerificationInFlight = null;
    }
  };

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  app.get("/healthz", async () => ({
    ok: true,
    service: "tianclip-processor",
    version: "0.1.0",
  }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await checkDatabase(database);
      await verifyPinnedPrivateCore();
      if (!await repository.hasRecentWorkerHeartbeat()) {
        throw new Error("no recent background worker heartbeat");
      }
      return {
        ready: true,
        service: "tianclip-processor",
        dependencies: {
          database: true,
          privateStorage: true,
          privateCoreObject: true,
          privateCorePinnedSha256: true,
          backgroundWorker: true,
        },
      };
    } catch (error) {
      app.log.error({ err: error }, "readiness check failed");
      return reply.code(503).send({
        ready: false,
        error: { code: "not_ready", message: "处理服务尚未就绪。" },
      });
    }
  });

  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/v1/")) return;
    const verified = await verifyInternalRequest(request, config, database);
    request.internalKeyId = verified.keyId;
    request.internalActor = verified.actor;
  });

  await registerRoutes(app, { config, repository, storage });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({
      error: { code: "not_found", message: "接口不存在。" },
    }));

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const response = publicError(error);
    return reply.code(response.statusCode).send(response.body);
  });

  return app;
}
