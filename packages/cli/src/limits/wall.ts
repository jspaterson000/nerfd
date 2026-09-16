import { emptyLimitTokens, type LimitScope, type LimitWindow } from '@nerfd/core';

/**
 * A window for a tool that reports the wall but not the window.
 *
 * Kimi is the case: the quota is fetched with a bearer token and never
 * cached, so nothing on disk says how full the window is - but `wire.jsonl`
 * does say when a request was refused for rate limit or exhausted quota.
 * That is worth recording on its own: `wall_hit_share` and the successes-per-
 * dollar figure both need it, and neither needs a percentage.
 *
 * Everything unmeasured is null rather than zero, so the estimator discards
 * the entry instead of averaging a fiction into a capacity band.
 */
export function wallOnlyWindow(scope: LimitScope = 'primary'): LimitWindow {
  return {
    scope,
    window_min: null,
    used_pct_start: null,
    used_pct_end: null,
    samples: 0,
    resets_in_min_end: null,
    reset_bucket: null,
    wall_hit: true,
    tokens: emptyLimitTokens(),
  };
}
