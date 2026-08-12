/**
 * Deadline rules are local-time rules, so their tests need a known local time. Pinning the
 * zone here lets the fixed-clock cases assert real behavior — a local midnight that is not
 * UTC midnight, and a genuine DST transition — on a laptop in any zone and on a CI runner
 * in UTC. Node re-reads `TZ` when it changes, so this applies to every `Date` the tests make.
 */
process.env.TZ = 'America/New_York';
