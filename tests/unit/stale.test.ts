import { describe, expect, it } from 'vitest';

import {
  analyzeStale,
  downgradeConfidence,
  regexDefs,
  regexUses,
  type StaleCellMeta,
} from '../../src/core/stale.js';

interface CellSpec {
  defs: string[];
  uses: string[];
  meta: Partial<StaleCellMeta> & { cell_index: number };
}

function run(specs: readonly CellSpec[], targets: readonly number[], replays: readonly number[] = []) {
  const defs: string[][] = [];
  const uses: string[][] = [];
  const cells: StaleCellMeta[] = [];
  for (const spec of specs) {
    defs[spec.meta.cell_index] = spec.defs;
    uses[spec.meta.cell_index] = spec.uses;
    cells.push({
      cell_index: spec.meta.cell_index,
      cell_id: spec.meta.cell_id ?? `c${spec.meta.cell_index}`,
      is_code: spec.meta.is_code ?? true,
      has_nonempty_outputs: spec.meta.has_nonempty_outputs ?? true,
    });
  }
  return analyzeStale({
    defs,
    uses,
    targetIndexes: new Set(targets),
    replayIndexes: new Set(replays),
    cells,
  });
}

describe('[step8][U18] high-confidence dependency detection', () => {
  it('flags a cell using a variable defined by an executed cell (tuple unpacking)', () => {
    // symtable input for `a, b = f()` + `print(a)`: exactly what the regex
    // fallback CANNOT detect (documented SPEC §5.6.1 blind spot).
    const stale = run(
      [
        { defs: ['a', 'b'], uses: ['f'], meta: { cell_index: 0, has_nonempty_outputs: false } },
        { defs: [], uses: ['a'], meta: { cell_index: 1 } },
      ],
      [0],
    );
    expect(stale).toEqual([
      { cell_index: 1, cell_id: 'c1', reason: 'uses-variable-defined-in-0', confidence: 'high' },
    ]);
  });

  it('picks the LATEST executing definer when several define the same name', () => {
    const stale = run(
      [
        { defs: ['x'], uses: [], meta: { cell_index: 0, has_nonempty_outputs: false } },
        { defs: ['x'], uses: [], meta: { cell_index: 2, has_nonempty_outputs: false } },
        { defs: [], uses: ['x'], meta: { cell_index: 3 } },
      ],
      [2],
    );
    expect(stale[0]).toMatchObject({ cell_index: 3, reason: 'uses-variable-defined-in-2', confidence: 'high' });
  });
});

describe('[step8][U19] replayed dependencies stay low confidence', () => {
  it('R={0}, T={5}: a cell 7 using a name defined in cell 0 depends on replay', () => {
    const stale = run(
      [
        { defs: ['df'], uses: [], meta: { cell_index: 0, has_nonempty_outputs: false } },
        { defs: [], uses: [], meta: { cell_index: 1, has_nonempty_outputs: false } },
        { defs: [], uses: [], meta: { cell_index: 2, has_nonempty_outputs: false } },
        { defs: [], uses: [], meta: { cell_index: 3, has_nonempty_outputs: false } },
        { defs: [], uses: [], meta: { cell_index: 4, has_nonempty_outputs: false } },
        { defs: ['model'], uses: ['df'], meta: { cell_index: 5, has_nonempty_outputs: false } },
        { defs: [], uses: [], meta: { cell_index: 6, has_nonempty_outputs: false } },
        { defs: [], uses: ['df'], meta: { cell_index: 7 } },
      ],
      [5],
      [0, 1, 2, 3, 4],
    );
    expect(stale).toEqual([
      { cell_index: 7, cell_id: 'c7', reason: 'depends-on-replayed-cell-0', confidence: 'low' },
    ]);
  });
});

describe('[step8][U19b] function-local variables never count as module uses', () => {
  it('cell 4 with a local tmp is not stale even though cell 3 defines module tmp', () => {
    // symtable for cell4 `def g():\n    tmp = 2\n    return tmp`: local tmp is
    // NOT a module-level use — a naive AST walk would report it (SPEC §5.6).
    const stale = run(
      [
        { defs: ['tmp'], uses: [], meta: { cell_index: 3, has_nonempty_outputs: false } },
        { defs: ['g'], uses: [], meta: { cell_index: 4 } },
      ],
      [3],
    );
    expect(stale).toEqual([]);
  });
});

describe('[step8] judgment boundaries', () => {
  it('reports out-of-order execution when a target runs after a dependent', () => {
    const stale = run(
      [
        { defs: ['a'], uses: [], meta: { cell_index: 0 } },
        { defs: [], uses: [], meta: { cell_index: 5, has_nonempty_outputs: false } },
      ],
      [5],
    );
    expect(stale).toEqual([
      { cell_index: 0, cell_id: 'c0', reason: 'out-of-order-execution', confidence: 'low' },
    ]);
  });

  it('ignores executed cells, empty-output cells and markdown cells', () => {
    const stale = run(
      [
        { defs: ['a'], uses: [], meta: { cell_index: 0 } },
        { defs: [], uses: ['a'], meta: { cell_index: 1, has_nonempty_outputs: false } },
        { defs: [], uses: ['a'], meta: { cell_index: 2, is_code: false } },
      ],
      [0, 1],
    );
    expect(stale).toEqual([]);
  });

  it('caps results at 50 cells sorted by index', () => {
    const specs: CellSpec[] = [
      { defs: ['x'], uses: [], meta: { cell_index: 0, has_nonempty_outputs: false } },
    ];
    for (let i = 1; i <= 80; i += 1) {
      specs.push({ defs: [], uses: ['x'], meta: { cell_index: i } });
    }
    const stale = run(specs, [0]);
    expect(stale).toHaveLength(50);
    expect(stale[0]!.cell_index).toBe(1);
    expect(stale[49]!.cell_index).toBe(50);
  });
});

describe('[step8][U25] regex fallback (SPEC §5.6.1)', () => {
  it('extracts definitions from assignments, imports, defs, classes, for-loops', () => {
    const source = [
      'a = 1',
      'b == 2', // comparison, NOT an assignment
      'import os',
      'import a.b',
      'import a.b as c',
      'from x import a, b',
      'def helper():',
      '    pass',
      'class Thing:',
      '    pass',
      'for i in range(3):',
      '    print(i)',
    ].join('\n');
    expect(new Set(regexDefs(source))).toEqual(new Set(['a', 'os', 'a', 'c', 'a', 'b', 'helper', 'Thing', 'i']));
  });

  it('known blind spots stay blind (documented, not bugs)', () => {
    expect(regexDefs('a, b = f()')).toEqual([]); // U18: only symtable catches this
    expect(regexDefs('x: int = 1')).toEqual([]);
    expect(regexDefs('    indented = 1')).toEqual([]);
    expect(regexDefs('with open(p) as f:')).toEqual([]);
  });

  it('uses are all identifier tokens minus definitions (keywords included, per SPEC rule 5)', () => {
    // tokens: import pandas as pd df pd DataFrame
    // defs:   pd (import as), df (assignment); `import pandas as pd` does NOT bind 'pandas'
    expect(new Set(regexUses('import pandas as pd\ndf = pd.DataFrame()'))).toEqual(
      new Set(['import', 'pandas', 'as', 'DataFrame']),
    );
  });

  it('downgradeConfidence forces every entry to low', () => {
    const downgraded = downgradeConfidence([
      { cell_index: 1, cell_id: null, reason: 'uses-variable-defined-in-0', confidence: 'high' },
    ]);
    expect(downgraded[0]!.confidence).toBe('low');
  });
});
