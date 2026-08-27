import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Validated once at boot, so a missing key fails immediately with a clear
 * message rather than as a 401 halfway through a paid sweep.
 */

const numeric = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().nonnegative());

const envSchema = z.object({
  GOOGLE_MAPS_API_KEY: z.string().min(1, 'GOOGLE_MAPS_API_KEY is empty — run `npm run verify`'),
  // 45, and the reasoning is a monthly budget rather than a daily one.
  //
  // Two separate limits apply. The console quota caps SearchText at 100/day
  // on this project. The one that decides whether a BILL arrives is Google's
  // per-SKU free tier: our field mask is Enterprise, which grants only 1,000
  // calls a month, and those allowances stopped pooling when the universal
  // $200 credit was retired in March 2025.
  //
  // 1,000/month over ~22 working days is ~45 a day, so a run capped here is
  // one free sweep per working day. At 90 a single run spends a tenth of the
  // month. Raise it only against a month with room left in it, not against
  // the daily cap - the daily cap is not what gets charged.
  MAX_CALLS: numeric(45),
  /** Businesses per sweep. The user-facing limit; MAX_CALLS is the backstop. */
  MAX_RESULTS: numeric(100),
  MAX_TILE_DEPTH: numeric(4),
  // Read through the schema rather than straight off process.env: the server
  // used to read this before loadEnv() had loaded the file, so setting it in
  // .env did nothing at all.
  DASHBOARD_PORT: numeric(5173),
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: z.string().optional(),
  // Apps Script ingest. Both must be set for a scrape to reach the sheet; the
  // pipeline runs perfectly well without them and simply says it did not push.
  SHEETS_WEBAPP_URL: z.string().optional(),
  SHEETS_INGEST_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  if (existsSync('.env')) process.loadEnvFile('.env');

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}\n\nRun \`npm run verify\` to diagnose.`);
  }
  return result.data;
}
