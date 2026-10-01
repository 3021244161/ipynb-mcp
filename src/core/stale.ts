// Stale-cell analysis (SPEC §5.6). The judgment itself is pure: given per-cell
// defs/uses (from the sidecar's symtable pass or the regex fallback), executed
// sets T (targeted) and R (replayed), and cell metadata, produce stale_cells.
//
// E = R ∪ T. For every code cell j ∉ E with non-empty outputs:
//   1. largest i ∈ E, i < j, with U(j) ∩ D(i) ≠ ∅:
//        i ∈ T -> uses-variable-defined-in-<i> (high)
//        i ∈ R -> depends-on-replayed-cell-<i> (low)
//   2. else any i ∈ T with i > j -> out-of-order-execution (low)
// Sorted by cell_index, capped at 50.

export interface StaleCellMeta {
  readonly cell_index: number;
  readonly cell_id: string | null;
  readonly is_code: boolean;
  readonly has_nonempty_outputs: boolean;
}

export interface StaleCell {
  readonly cell_index: number;
  readonly cell_id: string | null;
  readonly reason: string;
  readonly confidence: 'high' | 'low';
}

export interface StaleAnalysisResult {
  readonly stale_cells: StaleCell[];
  readonly stale_analysis: {
    approximate: true;
    analysis_version: 1;
    method: 'python-symtable' | 'regex' | 'skipped';
  };
  readonly degraded: boolean;
}

const MAX_STALE_CELLS = 50;

export function analyzeStale(input: {
  readonly defs: readonly string[][];
  readonly uses: readonly string[][];
  readonly targetIndexes: ReadonlySet<number>;
  readonly replayIndexes: ReadonlySet<number>;
  readonly cells: readonly StaleCellMeta[];
}): StaleCell[] {
  const executed = new Set<number>([...input.targetIndexes, ...input.replayIndexes]);
  const stale: StaleCell[] = [];

  for (const cell of input.cells) {
    if (!cell.is_code || executed.has(cell.cell_index) || !cell.has_nonempty_outputs) {
      continue;
    }
    const uses = input.uses[cell.cell_index] ?? [];
    if (uses.length === 0) {
      // Nothing referenced at module level: only out-of-order can apply.
      if (hasTargetAfter(cell.cell_index, input.targetIndexes)) {
        stale.push({
          cell_index: cell.cell_index,
          cell_id: cell.cell_id,
          reason: 'out-of-order-execution',
          confidence: 'low',
        });
      }
      continue;
    }
    let latestDependency: number | null = null;
    for (let i = 0; i < cell.cell_index; i += 1) {
      if (!executed.has(i)) {
        continue;
      }
      const defs = input.defs[i] ?? [];
      if (defs.some((name) => uses.includes(name))) {
        latestDependency = i;
      }
    }
    if (latestDependency !== null) {
      const confidence: 'high' | 'low' = input.targetIndexes.has(latestDependency) ? 'high' : 'low';
      const reason = input.targetIndexes.has(latestDependency)
        ? `uses-variable-defined-in-${latestDependency}`
        : `depends-on-replayed-cell-${latestDependency}`;
      stale.push({ cell_index: cell.cell_index, cell_id: cell.cell_id, reason, confidence });
      continue;
    }
    if (hasTargetAfter(cell.cell_index, input.targetIndexes)) {
      stale.push({
        cell_index: cell.cell_index,
        cell_id: cell.cell_id,
        reason: 'out-of-order-execution',
        confidence: 'low',
      });
    }
  }

  stale.sort((a, b) => a.cell_index - b.cell_index);
  return stale.slice(0, MAX_STALE_CELLS);
}

function hasTargetAfter(index: number, targets: ReadonlySet<number>): boolean {
  for (const target of targets) {
    if (target > index) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Regex fallback (SPEC §5.6.1) — only used when at least one cell failed to
// parse on the sidecar. Known blind spots must be documented in the README.
// ---------------------------------------------------------------------------

const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';

export function regexDefs(source: string): string[] {
  const defs = new Set<string>();
  for (const line of source.split('\n')) {
    let match = new RegExp(`^(${IDENTIFIER})\\s*=(?!=)`).exec(line);
    if (match !== null) {
      defs.add(match[1] ?? '');
    }
    match = new RegExp(`^(?:import|from)\\s+(${IDENTIFIER})`).exec(line);
    if (match !== null) {
      const root = match[1] ?? '';
      // `import a.b as c` binds c; `import a.b` binds a; `from x import a, b` binds a, b.
      const asMatch = new RegExp(`^import\\s+${IDENTIFIER}(?:\\.${IDENTIFIER})*\\s+as\\s+(${IDENTIFIER})`).exec(line);
      if (asMatch !== null) {
        defs.add(asMatch[1] ?? '');
      } else if (line.startsWith('from')) {
        const names = line
          .replace(/^from\s+[^\s]+\s+import\s+/, '')
          .split(',')
          .map((piece) => piece.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
          .filter((name) => new RegExp(`^${IDENTIFIER}$`).test(name));
        for (const name of names) {
          defs.add(name);
        }
      } else {
        defs.add(root);
      }
    }
    match = new RegExp(`^(?:def|class)\\s+(${IDENTIFIER})`).exec(line);
    if (match !== null) {
      defs.add(match[1] ?? '');
    }
    match = new RegExp(`^\\s*for\\s+(${IDENTIFIER})`).exec(line);
    if (match !== null) {
      defs.add(match[1] ?? '');
    }
  }
  defs.delete('');
  return [...defs];
}

export function regexUses(source: string): string[] {
  const defs = new Set(regexDefs(source));
  const uses = new Set<string>();
  for (const token of source.match(new RegExp(IDENTIFIER, 'g')) ?? []) {
    if (!defs.has(token)) {
      uses.add(token);
    }
  }
  return [...uses];
}

/** Downgrade path: regex results must never claim high confidence (SPEC §5.6.1). */
export function downgradeConfidence(cells: readonly StaleCell[]): StaleCell[] {
  return cells.map((cell) => ({ ...cell, confidence: 'low' as const }));
}
