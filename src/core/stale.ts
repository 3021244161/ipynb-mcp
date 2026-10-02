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

  // `hasTargetAfter` is queried once per cell and the dependency scan is
  // indexed. The previous shape rescanned `0..j` per cell with a nested
  // `.some(name => uses.includes(name))`, i.e. quadratic: an 8 000-cell
  // notebook spent ~180 ms here while parse+serialize+selfcheck together cost
  // ~15 ms (review v3 PERF-3). Results are unchanged.
  const lastTarget = maxOf(input.targetIndexes);
  const latestDefiner = new Map<string, number>();

  for (const cell of input.cells) {
    const index = cell.cell_index;
    const uses = input.uses[index] ?? [];

    if (cell.is_code && !executed.has(index) && cell.has_nonempty_outputs) {
      let latestDependency = -1;
      for (const name of uses) {
        const definer = latestDefiner.get(name);
        if (definer !== undefined && definer > latestDependency) {
          latestDependency = definer;
        }
      }
      if (latestDependency >= 0) {
        const confidence: 'high' | 'low' = input.targetIndexes.has(latestDependency) ? 'high' : 'low';
        const reason = input.targetIndexes.has(latestDependency)
          ? `uses-variable-defined-in-${latestDependency}`
          : `depends-on-replayed-cell-${latestDependency}`;
        stale.push({ cell_index: index, cell_id: cell.cell_id, reason, confidence });
      } else if (lastTarget > index) {
        // No dependency on an executed cell (or none referenced at all): only
        // the out-of-order rule can still apply.
        stale.push({
          cell_index: index,
          cell_id: cell.cell_id,
          reason: 'out-of-order-execution',
          confidence: 'low',
        });
      }
    }

    // Register this cell's definitions for every LATER cell (executed or not:
    // only executed indexes are ever read back, and a definer is only recorded
    // when it was executed).
    if (executed.has(index)) {
      for (const name of input.defs[index] ?? []) {
        const previous = latestDefiner.get(name);
        if (previous === undefined || index > previous) {
          latestDefiner.set(name, index);
        }
      }
    }
  }

  stale.sort((a, b) => a.cell_index - b.cell_index);
  return stale.slice(0, MAX_STALE_CELLS);
}

function maxOf(indexes: ReadonlySet<number>): number {
  let max = -1;
  for (const value of indexes) {
    if (value > max) {
      max = value;
    }
  }
  return max;
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
