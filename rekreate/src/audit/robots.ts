/**
 * Minimal robots.txt handling.
 *
 * The rules file says respect it, so we do. This reads the `User-agent: *`
 * group only — we identify as our own agent and no site will have a rule
 * naming us. A robots.txt we cannot fetch is treated as permissive, which
 * matches how every crawler behaves and how the standard is written.
 */

export type RobotsRules = { disallow: string[]; allow: string[] };

export function parseRobots(text: string): RobotsRules {
  const disallow: string[] = [];
  const allow: string[] = [];
  let inStar = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      // A new group starts here; we only care about the wildcard one.
      inStar = value === '*';
      continue;
    }
    if (!inStar) continue;
    if (field === 'disallow' && value) disallow.push(value);
    if (field === 'allow' && value) allow.push(value);
  }

  return { disallow, allow };
}

/**
 * Match one rule against a path, honouring the two wildcards RFC 9309 defines:
 * `*` stands for any run of characters, and a trailing `$` anchors the end.
 * Everything else is a literal prefix match.
 *
 * Truncating a pattern at its first `*` — the obvious shortcut — is wrong in
 * the direction that costs leads: the very common `Disallow: /*.pdf$` collapses
 * to `Disallow: /` and locks us out of the entire site over a rule about PDFs.
 *
 * Deliberately not a regex. A hostile robots.txt could hand us a pattern whose
 * compiled form backtracks exponentially; this two-pointer scan cannot.
 */
function pathMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  // A prefix rule is the same thing as an anchored rule ending in `*`, which
  // lets one matcher serve both cases.
  const glob = anchored ? pattern.slice(0, -1) : `${pattern}*`;

  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;

  while (t < path.length) {
    const pc = p < glob.length ? glob[p] : undefined;
    if (pc === '*') {
      star = p;
      p += 1;
      mark = t;
    } else if (pc !== undefined && pc === path[t]) {
      p += 1;
      t += 1;
    } else if (star >= 0) {
      // Give the last `*` one more character and try again.
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }

  while (p < glob.length && glob[p] === '*') p += 1;
  return p === glob.length;
}

/**
 * Longest match wins, and Allow beats Disallow at equal length — per the
 * standard, which measures length on the rule as written, wildcards included.
 */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  const match = (patterns: string[]): number => {
    let best = -1;
    for (const p of patterns) {
      if (p.length > best && pathMatches(p, path)) best = p.length;
    }
    return best;
  };

  const denied = match(rules.disallow);
  if (denied === -1) return true;
  return match(rules.allow) >= denied;
}

export const PERMISSIVE: RobotsRules = { disallow: [], allow: [] };
