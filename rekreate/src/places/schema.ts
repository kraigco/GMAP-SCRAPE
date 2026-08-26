import { z } from 'zod';

/**
 * Every field except `id` is optional. Places omits absent fields entirely
 * rather than returning null, so a prospect with no website simply has no
 * `websiteUri` key. Modelling that wrongly crashes the sweep on the first such
 * business — which is most of them.
 */
export const rawPlaceSchema = z.object({
  id: z.string().min(1),
  displayName: z
    .object({ text: z.string(), languageCode: z.string().optional() })
    .optional(),
  formattedAddress: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  websiteUri: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().int().nonnegative().optional(),
  businessStatus: z
    .enum(['OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY'])
    .optional(),
  primaryType: z.string().optional(),
  types: z.array(z.string()).optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
});

export type RawPlace = z.infer<typeof rawPlaceSchema>;

export const searchTextResponseSchema = z.object({
  places: z.array(z.unknown()).optional(),
  nextPageToken: z.string().optional(),
});

export type RejectedPlace = { raw: unknown; error: string };

/**
 * Validate each place independently.
 *
 * One malformed entry — an unrecognised `businessStatus`, say — must not
 * discard the other 19 in the page, but it must not vanish silently either.
 * Rejects are returned and counted in the run summary.
 */
export function parsePlaces(raw: unknown[]): { places: RawPlace[]; rejected: RejectedPlace[] } {
  const places: RawPlace[] = [];
  const rejected: RejectedPlace[] = [];

  for (const entry of raw) {
    const result = rawPlaceSchema.safeParse(entry);
    if (result.success) places.push(result.data);
    else rejected.push({ raw: entry, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  }

  return { places, rejected };
}
