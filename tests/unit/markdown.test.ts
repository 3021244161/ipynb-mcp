import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkMarkdown } from '../../src/core/markdown.ts';
import { applyEditOps } from '../../src/core/edit.ts';
import { parseNotebook } from '../../src/core/parse.ts';
import { hasher } from '../../src/hash.ts';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ipynb-mcp-md-'));
  await writeFile(path.join(dir, 'exists.txt'), 'x');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function check(source: string): ReturnType<typeof checkMarkdown> {
  return checkMarkdown(source, dir.replace(/\\/g, '/'), (p) => existsSync(p));
}

function rules(issues: ReturnType<typeof check>): string[] {
  return issues.map((issue) => issue.rule);
}

describe('[step5] unclosed-fence (error)', () => {
  it('reports an unterminated ``` fence at its opening line', () => {
    const issues = check('# Title\n\n```python\nprint(1)\n');
    expect(rules(issues)).toContain('unclosed-fence');
    const fence = issues.find((issue) => issue.rule === 'unclosed-fence')!;
    expect(fence.severity).toBe('error');
    expect(fence.line).toBe(3);
  });

  it('handles ~~~ fences and closed fences cleanly', () => {
    expect(rules(check('~~~\ncode\n~~~\n'))).toEqual([]);
    expect(rules(check('```\ncode\n```\ntext\n'))).toEqual([]);
  });

  it('ignores fence markers inside inline code', () => {
    expect(rules(check('Use ``` inline to mark code blocks\n'))).toEqual([]);
  });
});

describe('[step5] unbalanced-math (error)', () => {
  it('reports odd $$ counts and odd $ counts', () => {
    expect(rules(check('$$\nx = 1\n'))).toContain('unbalanced-math');
    expect(rules(check('Price is $5 today\n'))).toContain('unbalanced-math');
  });

  it('accepts balanced math and escaped dollars', () => {
    expect(rules(check('$$\nx = 1\n$$\n'))).toEqual([]);
    expect(rules(check('$x$ and $y$\n'))).toEqual([]);
    expect(rules(check('I paid \\$5 (\\$6) literally\n'))).toEqual([]);
  });

  it('ignores math inside code fences', () => {
    expect(rules(check('```\n$$ unclosed in code\n```\n'))).toEqual([]);
  });
});

describe('[step5] missing-relative-target (error)', () => {
  it('reports relative links that do not resolve', () => {
    const issues = check('See [docs](./missing.md) and ![img](img/nope.png)');
    const missing = issues.filter((issue) => issue.rule === 'missing-relative-target');
    expect(missing).toHaveLength(2);
    expect(missing.every((issue) => issue.severity === 'error')).toBe(true);
  });

  it('accepts existing targets, absolute urls, anchors and data uris', () => {
    expect(rules(check('See [ok](exists.txt), [web](https://example.com/a), [local](#sec), [inline](data:image/png;base64,xx)'))).toEqual([]);
  });

  it('resolves relative to the notebook dir, supporting ..', () => {
    const issues = checkMarkdown('[x](../missing-up.md)', dir.replace(/\\/g, '/'), () => false);
    expect(rules(issues)).toContain('missing-relative-target');
    const issue = issues[0]!;
    expect(issue.message).toContain('/missing-up.md');
  });
});

describe('[step5] heading-level-jump (warning)', () => {
  it('warns when the level rises by more than one', () => {
    const issues = check('# H1\n\n### H3 skipped H2');
    const jump = issues.find((issue) => issue.rule === 'heading-level-jump');
    expect(jump?.severity).toBe('warning');
    expect(jump?.line).toBe(3);
  });

  it('accepts first heading at any level, +1 steps and arbitrary descents', () => {
    expect(rules(check('### first\n#### second\n# reset\n'))).toEqual([]);
    expect(rules(check('# a\n## b\n# c\n## d\n'))).toEqual([]);
    // +1 then descend then +1 again: never a jump of more than one.
    expect(rules(check('## x\n### y\n# z\n## w\n'))).toEqual([]);
  });
});

describe('[step5] duplicate-heading-anchor (warning)', () => {
  it('warns on a second heading with the same slug', () => {
    const issues = check('## Setup\n\n## Setup');
    const dup = issues.find((issue) => issue.rule === 'duplicate-heading-anchor');
    expect(dup?.severity).toBe('warning');
    expect(dup?.line).toBe(3);
  });

  it('slugs fold case, punctuation and spaces into the same anchor', () => {
    // 'Hello World', 'hello-world' and 'Hello, World!' all slug to hello-world.
    const issues = check('## Hello World\n## hello-world\n## Hello, World!\n## Different');
    const dups = issues.filter((issue) => issue.rule === 'duplicate-heading-anchor');
    expect(dups).toHaveLength(2);
    expect(dups.map((issue) => issue.line)).toEqual([2, 3]);
  });
});

describe('[step5] table-column-mismatch (warning)', () => {
  it('warns when pipe counts differ inside one table block', () => {
    const issues = check('| a | b |\n| --- | --- |\n| 1 |');
    expect(rules(issues)).toContain('table-column-mismatch');
    expect(issues[0]!.line).toBe(3);
  });

  it('consistent tables and non-table text pass', () => {
    expect(rules(check('| a | b |\n| 1 | 2 |\n\nplain text\n'))).toEqual([]);
  });
});

describe('[step5][U4] markdown gate via edit ops', () => {
  it('an unclosed fence fails the edit with markdown_invalid and no file write', async () => {
    const target = path.join(dir, 'u4.ipynb');
    const json = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'markdown', id: 'md-0', metadata: {}, source: '# Good' }],
    });
    await writeFile(target, json);
    const bytes = await readFile(target);
    const notebook = parseNotebook(bytes, hasher);

    // Tool-layer wiring: adapt (source, dir, existsSync) to (source).
    const checkMd = (source: string) =>
      checkMarkdown(source, dir.replace(/\\/g, '/'), (p) => existsSync(p));

    let caught: unknown;
    try {
      applyEditOps(notebook, [
        { op: 'replace_source', cell_index: 0, expected_text: '# Good', new_text: '# Title\n\n```python\nprint(1)' },
      ], { hasher, nbformatMinor: 5, checkMarkdown: checkMd });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toMatchObject({ code: 'markdown_invalid' });
    const detail = (caught as { detail?: { issues?: unknown[] } }).detail;
    expect(Array.isArray(detail?.issues)).toBe(true);
    // Caller never writes on failure: bytes unchanged.
    expect(await readFile(target)).toEqual(bytes);
  });

  it('warning-level markdown issues do not block the write', () => {
    const notebook = parseNotebook(
      new TextEncoder().encode(JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [{ cell_type: 'markdown', id: 'md-0', metadata: {}, source: '# Good' }],
      })),
      hasher,
    );
    const checkMd = (source: string) => checkMarkdown(source, dir, () => true);
    const result = applyEditOps(notebook, [
      { op: 'replace_source', cell_index: 0, expected_text: '# Good', new_text: '# a\n### jumped' },
    ], { hasher, nbformatMinor: 5, checkMarkdown: checkMd });
    expect(result.markdownIssues.map((issue) => issue.rule)).toContain('heading-level-jump');
    expect(result.applied).toBe(1);
  });
});
