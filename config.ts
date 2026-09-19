import { z } from "zod";

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
  })
  .readonly();

export type Config = z.infer<typeof envSchema>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
