import { z } from "zod";

export const DEFAULT_WEB_ORIGIN = "http://localhost:3001";

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.url({
      protocol: /^postgres(ql)?$/,
      hostname: /.+/,
      error: "must be a postgres:// connection string",
    }),
    REDIS_URL: z.url({
      protocol: /^rediss?$/,
      hostname: /.+/,
      error: "must be a redis:// connection string",
    }),
    JWT_ACCESS_SECRET: z.string().min(32, { error: "must be at least 32 characters" }),
    // Orders one user may place per second before getting 429.
    ORDER_RATE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(20),
    // The trading terminal's origin, the only one CORS lets call the API with cookies. Reduced
    // to scheme, host and port, since that is exactly what a browser sends in Origin.
    WEB_ORIGIN: z
      .url({ protocol: /^https?$/, hostname: /.+/, error: "must be an http(s):// origin" })
      .transform((url) => new URL(url).origin)
      .default(DEFAULT_WEB_ORIGIN),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
  })
  .readonly();

export type Config = z.infer<typeof envSchema>;
export type LogLevel = Config["LOG_LEVEL"];

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// The bot fleet is a separate process and a client of the API, so it needs none of the API's
// own secrets, only where the API is and the password its agents' accounts use.
const botEnvSchema = z
  .object({
    BOT_API_URL: z
      .url({ protocol: /^https?$/, hostname: /.+/, error: "must be an http(s):// URL" })
      .default("http://localhost:3000"),
    // Every agent account is registered with it the first time and signs in with it after.
    BOT_PASSWORD: z.string().min(8, { error: "must be at least 8 characters" }).max(256),
  })
  .readonly();

export type BotConfig = z.infer<typeof botEnvSchema>;

export function parseBotConfig(env: Record<string, string | undefined>): BotConfig {
  const result = botEnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid bot configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// The MCP server is another client of the API, like the fleet, with one account of its own.
const agentEnvSchema = z
  .object({
    AGENT_API_URL: z
      .url({ protocol: /^https?$/, hostname: /.+/, error: "must be an http(s):// URL" })
      .default("http://localhost:3000"),
    // Registered the first time the server starts, signed in to after.
    AGENT_EMAIL: z.email({ error: "must be an email address" }),
    AGENT_PASSWORD: z.string().min(8, { error: "must be at least 8 characters" }).max(256),
    // The one market the agent trades. Its risk limits are per market.
    AGENT_MARKET: z.enum(["BTC-USD", "ETH-USD"]).default("BTC-USD"),
  })
  .readonly();

export type AgentConfig = z.infer<typeof agentEnvSchema>;

export function parseAgentConfig(env: Record<string, string | undefined>): AgentConfig {
  const result = agentEnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid agent configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
