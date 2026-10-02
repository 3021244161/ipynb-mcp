// Markdown structural checker (SPEC §5.7). Pure function; the only external
// capability is an injected existsSync — importing node:fs here is forbidden.
//
// Known imprecision (documented per SPEC): links inside fenced code blocks are
// checked as real links, pipe counts include escaped pipes, and inline `$` in
// inline code spans counts toward math balance. These follow the SPEC's
// literal rule wording.

export interface MarkdownIssue {
  readonly severity: 'error' | 'warning';
  readonly rule: string;
  readonly line: number;
  readonly message: string;
}

interface OutsideLine {
  readonly text: string;
  readonly line: number;
}

export function checkMarkdown(
  source: string,
  notebookDirForRelativePaths: string,
  existsSync: (absolutePath: string) => boolean,
): MarkdownIssue[] {
  const issues: MarkdownIssue[] = [];
  const lines = source.split('\n');

  // --- pass 1: fences (unclosed-fence, error) ---------------------------------
  // Fence detection is line-leading only: a ``` that appears mid-sentence as
  // inline code never starts a fence because it is not at the start of the
  // (trimmed) line. Recorded in DEVIATIONS (D-002).
  const outside: OutsideLine[] = [];
  let inFence = false;
  let fenceOpenLine = 1;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (!inFence) {
        inFence = true;
        fenceOpenLine = i + 1;
      } else {
        inFence = false;
      }
      continue;
    }
    if (!inFence) {
      outside.push({ text: raw, line: i + 1 });
    }
  }
  if (inFence) {
    issues.push({
      severity: 'error',
      rule: 'unclosed-fence',
      line: fenceOpenLine,
      message: `code fence opened at line ${fenceOpenLine} is never closed`,
    });
  }

  // --- pass 2: math delimiters (unbalanced-math, error) -----------------------
  const mathText = outside.map((l) => l.text.replace(/\\\$/g, '')).join('\n');
  const blockMathCount = (mathText.match(/\$\$/g) ?? []).length;
  const singleDollars = countChar(mathText, '$') - 2 * blockMathCount;
  if (blockMathCount % 2 === 1) {
    issues.push({
      severity: 'error',
      rule: 'unbalanced-math',
      line: firstLineContaining(outside, '$$') ?? 1,
      message: `unbalanced block math: ${blockMathCount} '$$' delimiters`,
    });
  } else if (singleDollars % 2 === 1) {
    issues.push({
      severity: 'error',
      rule: 'unbalanced-math',
      line: firstLineContaining(outside, '$') ?? 1,
      message: `unbalanced inline math: odd number of '$' delimiters`,
    });
  }

  // --- pass 3: relative link targets (missing-relative-target, error) --------
  for (const { text, line } of outside) {
    for (const target of extractLinkTargets(text)) {
      if (isExemptTarget(target)) {
        continue;
      }
      const pathPart = target.split('#')[0] ?? target;
      if (pathPart === '') {
        continue;
      }
      const absolute = resolveRelative(notebookDirForRelativePaths, pathPart);
      if (!existsSync(absolute)) {
        issues.push({
          severity: 'error',
          rule: 'missing-relative-target',
          line,
          message: `link target does not exist: ${target} (resolved: ${absolute})`,
        });
      }
    }
  }

  // --- pass 4: headings (jump + duplicate slug, warning) ----------------------
  let previousLevel: number | null = null;
  const seenSlugs = new Set<string>();
  for (const { text, line } of outside) {
    const heading = parseHeading(text);
    if (heading === null) {
      continue;
    }
    if (previousLevel !== null && heading.level > previousLevel + 1) {
      issues.push({
        severity: 'warning',
        rule: 'heading-level-jump',
        line,
        message: `heading jumps from level ${previousLevel} to ${heading.level}`,
      });
    }
    previousLevel = heading.level;
    const slug = slugify(heading.text);
    if (seenSlugs.has(slug)) {
      issues.push({
        severity: 'warning',
        rule: 'duplicate-heading-anchor',
        line,
        message: `duplicate heading anchor '${slug}'`,
      });
    } else {
      seenSlugs.add(slug);
    }
  }

  // --- pass 5: tables (column mismatch, warning) ------------------------------
  // A markdown table requires a delimiter row (| --- |) right after the
  // header: pipe-carrying PROSE lines are not tables, and column counts are
  // only checked once a delimiter row confirms the block (review C6e).
  let tableStart: number | null = null;
  let tablePipes = -1;
  let awaitingDelimiter = false;
  const isDelimiterRow = (text: string): boolean => /^[|:\s-]+$/.test(text) && text.includes('-');
  for (const { text, line } of outside) {
    if (text.includes('|')) {
      const pipes = countChar(text, '|');
      if (awaitingDelimiter) {
        if (isDelimiterRow(text)) {
          awaitingDelimiter = false; // confirmed table block; check from here on
        } else {
          // Not a table after all: reset and treat this line as a fresh candidate.
          tableStart = null;
          tablePipes = -1;
          awaitingDelimiter = false;
        }
        continue;
      }
      if (tableStart === null) {
        tableStart = line;
        tablePipes = pipes;
        awaitingDelimiter = true;
      } else if (pipes !== tablePipes) {
        issues.push({
          severity: 'warning',
          rule: 'table-column-mismatch',
          line,
          message: `table row starting at line ${line} has ${pipes} pipes, expected ${tablePipes} (table starts at line ${tableStart})`,
        });
      }
    } else {
      tableStart = null;
      tablePipes = -1;
      awaitingDelimiter = false;
    }
  }

  issues.sort((a, b) => a.line - b.line);
  return issues;
}

// ---------------------------------------------------------------------------

function countChar(text: string, ch: string): number {
  let count = 0;
  for (const c of text) {
    if (c === ch) {
      count += 1;
    }
  }
  return count;
}

function firstLineContaining(lines: readonly OutsideLine[], needle: string): number | null {
  for (const { text, line } of lines) {
    if (text.includes(needle)) {
      return line;
    }
  }
  return null;
}

function extractLinkTargets(text: string): string[] {
  const targets: string[] = [];
  const linkPattern = /(!?)\[(?:[^[\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(text)) !== null) {
    const raw = match[2] ?? '';
    // Drop an optional trailing title: [x](path "title")
    const target = raw.trim().split(/\s+/)[0] ?? '';
    if (target !== '') {
      targets.push(target);
    }
  }
  return targets;
}

function isExemptTarget(target: string): boolean {
  const lower = target.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://') || target.startsWith('#') || lower.startsWith('data:');
}

function resolveRelative(dir: string, rel: string): string {
  const clean = rel.replace(/\\/g, '/');
  const dirParts = dir.replace(/\\/g, '/').split('/');
  const drivePrefix = /^[A-Za-z]:$/.test(dirParts[0] ?? '') ? (dirParts.shift() ?? '') : null;
  const parts: string[] = clean.startsWith('/') ? [] : [...dirParts];
  for (const segment of clean.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join('/');
  return drivePrefix !== null ? `${drivePrefix}/${joined}` : `/${joined}`;
}

function parseHeading(text: string): { level: number; text: string } | null {
  const match = /^(#{1,6})(?:\s+(.*))?$/.exec(text.trim());
  if (match === null) {
    return null;
  }
  return { level: (match[1] ?? '').length, text: match[2] ?? '' };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}
