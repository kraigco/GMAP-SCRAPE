import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

/**
 * The dashboard's inline script must actually parse.
 *
 * This exists because of a real outage that no other check could see. An
 * unescaped apostrophe in `'Google's daily cap'` closed a string mid-sentence,
 * and one syntax error takes the whole <script> with it: no sizing hint, no
 * saved searches, no filter chips, no empty-state copy. Nothing ran.
 *
 * And everything LOOKED fine. The page still served, every /api route still
 * answered, `curl` was happy, the type-checker had no opinion (it does not read
 * HTML), and all 300-odd tests passed. The failure was invisible from every
 * angle except opening the page — which is exactly the check a terminal session
 * is least likely to perform.
 *
 * `new Script()` compiles without executing, so browser globals like `document`
 * and `fetch` are irrelevant here. It answers one question only, and it is the
 * question that was missed: does this parse?
 */

const PAGE = 'src/server/public/index.html';

async function scriptBlocks(): Promise<string[]> {
  const html = await readFile(PAGE, 'utf8');
  const blocks: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const body = match[1] ?? '';
    if (body.trim()) blocks.push(body);
  }
  return blocks;
}

describe('the dashboard page', () => {
  it('has at least one inline script — otherwise this test guards nothing', async () => {
    expect((await scriptBlocks()).length).toBeGreaterThan(0);
  });

  it('parses as JavaScript', async () => {
    for (const [i, source] of (await scriptBlocks()).entries()) {
      // Compiles only. A throw here is a syntax error that would leave the
      // whole page inert in a browser while every server-side check passed.
      expect(() => new Script(source, { filename: `${PAGE}#script${i}` })).not.toThrow();
    }
  });

  it('leaves no apostrophe-in-a-single-quoted-string of the kind that broke it', async () => {
    // Belt and braces: the parse check above is the real guard, but this names
    // the specific mistake so a future reader knows what went wrong once.
    for (const source of await scriptBlocks()) {
      expect(source).not.toMatch(/'[^'\n]*[A-Za-z]'s [a-z]/);
    }
  });
});
