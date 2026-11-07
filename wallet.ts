import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticatedUserId, bearerAuth, invalidRequest } from "./auth.ts";
import { type FeedChannels, publishDeposit } from "./feed.ts";
import { balancesOf, deposit } from "./ledger.ts";
import { AMOUNT_MESSAGES, formatAmount, parseAmount } from "./money.ts";
import { assets } from "./schema.ts";
import type { RedisClient } from "./redis.ts";
import type { AccessTokens } from "./tokens.ts";

export type WalletDependencies = {
  db: NodePgDatabase;
  tokens: AccessTokens;
  redis: RedisClient;
  channels: FeedChannels;
};

// Amounts travel as strings: a JSON number is parsed into a float before we ever see it.
const depositBody = z.object({
  asset: z.string().min(1).max(16),
  amount: z.string().max(64),
});

export function fieldError(field: string, message: string) {
  return { error: "invalid_request", issues: [{ field, message }] };
}

export function registerWalletRoutes(
  app: FastifyInstance,
  { db, tokens, redis, channels }: WalletDependencies,
) {
  const authenticate = bearerAuth(tokens);

  app.post("/deposits", { onRequest: authenticate }, async (request, reply) => {
    const userId = authenticatedUserId(request);

    const parsed = depositBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest(parsed.error));
    }

    const [asset] = await db
      .select({ code: assets.code, scale: assets.scale })
      .from(assets)
      .where(eq(assets.code, parsed.data.asset))
      .limit(1);
    if (asset === undefined) {
      return reply.code(400).send(fieldError("asset", "is not a listed asset"));
    }

    const amount = parseAmount(parsed.data.amount, asset.scale);
    if (!amount.ok) {
      return reply.code(400).send(fieldError("amount", AMOUNT_MESSAGES[amount.reason]));
    }
    if (amount.units === 0n) {
      return reply.code(400).send(fieldError("amount", AMOUNT_MESSAGES.not_positive));
    }

    const transactionId = await deposit(db, userId, asset.code, amount.units);
    // After the commit, so the balances the gateway re-reads include it.
    publishDeposit(redis, channels, userId, request.log);

    return reply.code(201).send({
      transactionId,
      asset: asset.code,
      amount: formatAmount(amount.units, asset.scale),
    });
  });

  app.get("/balances", { onRequest: authenticate }, async (request, reply) => {
    const userId = authenticatedUserId(request);
    const balances = await balancesOf(db, userId);

    return reply.code(200).send({
      balances: balances.map((balance) => ({
        asset: balance.asset,
        available: formatAmount(balance.available, balance.scale),
        reserved: formatAmount(balance.reserved, balance.scale),
      })),
    });
  });
}
