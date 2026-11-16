/**
 * 28-advanced-flag.ts — Is "Advanced" (the previous ācāryas' books) switched on?
 *
 * The redesign includes an Advanced screen and a "Search in" switch, but the
 * ācāryas' books are not in the database yet, so both stay hidden unless the
 * deployment sets NEXT_PUBLIC_ADVANCED_ENABLED="true". Default: off. While off,
 * the Ask page shows no switch, the answer shows no Advanced card, and
 * /advanced answers 404. This flag never touches the search itself.
 */
export const ADVANCED_ENABLED = process.env.NEXT_PUBLIC_ADVANCED_ENABLED === "true";
