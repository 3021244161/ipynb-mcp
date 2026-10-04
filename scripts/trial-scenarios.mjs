// Real-usage trial harness for ipynb-mcp — scenario scenarios.
// See trial-changejob.mjs for the driver.

const P = (name) => `E:\\tmp\\ipynb-trial\\nb\\${name}`;

const PROBE_MD = '## MCP 试跑\n\n由 ipynb-mcp 试跑脚本插入（可删除）。\n';

const PROBES = {
  plain: 'probe_value = 6 * 7\nprint("MCP_PROBE_OK", probe_value)\nprobe_value',
  env: 'import sys, platform\nprint("MCP_PROBE_PY", sys.version.split()[0])\nprint("exec", sys.executable)',
  image: [
    'import matplotlib',
    'matplotlib.use("Agg")',
    'import matplotlib.pyplot as plt',
    'fig, ax = plt.subplots(figsize=(3, 2), dpi=80)',
    'ax.plot([0, 1, 2], [0, 1, 0], marker="o")',
    'ax.set_title("ipynb-mcp probe")',
    'fig',
  ].join('\n'),
  light: 'probe_value = sum(range(1, 11))\nprint("MCP_PROBE_OK", probe_value)',
};

/** Compact one-line summary of a tool result. */
const brief = (r, pick) => {
  if (r.isError) return `ERROR ${JSON.stringify(r.json ?? r.text.slice(0, 300))}`;
  const j = r.json ?? {};
  const bits = [];
  for (const [label, fn] of Object.entries(pick ?? {})) {
    let v;
    try { v = fn(j); } catch (e) { v = `!${String(e)}`; }
    bits.push(`${label}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return bits.join(' ');
};

const isOk = (r) => !r.isError;

export default {
  /** One notebook, minimal path: read -> insert probe -> kernel start -> run -> read back. */
  async one({ call, note, opts }) {
    const nb = P(opts.notebook);
    const probe = PROBES[opts.probe] ?? PROBES.plain;
    note(`### one: ${opts.notebook} probe=${opts.probe}`);

    const before = await call('notebook_read', { path: nb, include_source: 'none', include_outputs: 'summary' });
    const cellCount = before.json?.cell_count;
    note(`read: cells=${cellCount} hash=${String(before.json?.content_hash).slice(0, 12)} ids=${before.json?.has_stable_cell_ids}`);

    const ins = await call('notebook_edit', {
      path: nb,
      ops: [
        { op: 'insert_cell', at_index: cellCount, cell_type: 'markdown', source: PROBE_MD },
        { op: 'insert_cell', at_index: cellCount + 1, cell_type: 'code', source: probe },
      ],
    });
    note(`insert: applied=${ins.json?.applied} err=${ins.isError ? ins.text.slice(0, 200) : ''}`);
    const probeIndex = cellCount + 1;

    if (opts.kernelStart === 'false') {
      note('kernel start: SKIPPED (auto mode must decide by itself)');
    } else {
      const k = await call('notebook_kernel', { action: 'start', path: nb });
      note(`kernel start: alive=${k.json?.kernels?.[0]?.alive} pid=${k.json?.kernels?.[0]?.pid}`);
    }

    const run = await call('notebook_run', {
      path: nb,
      cell_selector: String(probeIndex),
      mode: opts.mode ?? 'resume',
      ...(opts.write === 'false' ? { write_outputs: false } : {}),
    });
    note(`run(mode=${opts.mode ?? 'resume'} write_outputs=${opts.write !== 'false'}): isError=${run.isError} ${run.isError ? run.text.slice(0, 400) : JSON.stringify({
      kind: run.json?.kind,
      mode: run.json?.mode_used,
      replayed: (run.json?.replayed_cell_indexes ?? []).length,
      executed: (run.json?.executed ?? []).map((e) => `${e.cell_index}:${e.status}:outs=${(e.outputs ?? []).length}`),
      writeBack: run.json?.write_back?.performed,
      stale: (run.json?.stale_cells ?? []).length,
      staleAnalysis: run.json?.stale_analysis,
      warn: (run.json?.warnings ?? []).map((w) => w.code),
    })} images=${run.images.length}`);

    const back = await call('notebook_read', { path: nb, cell_indexes: [probeIndex], include_source: 'none', include_outputs: 'full' });
    const cell = back.json?.cells?.[0] ?? {};
    note(`read back: exec=${cell.execution_count} outputs=${(cell.outputs ?? []).length} kinds=${(cell.outputs ?? []).map((o) => o.kind).join('|')} imageBlocks=${back.images.length}`);

    await call('notebook_kernel', { action: 'shutdown', path: nb });
    note('kernel shutdown');
  },


  /** Global contract checks that need no notebook. */
  async contract({ call, note }) {
    note('--- fence: a path outside the root must be refused');
    const outside = await call('notebook_read', { path: 'E:\\ChangeJob\\天竺街py（30+20）\\20py.ipynb' });
    note(brief(outside, { code: (j) => j.error?.code ?? j.code, msg: (j) => String(j.error?.message ?? j.message ?? '').slice(0, 120) })
      || outside.text.slice(0, 200));

    note('--- unknown argument must be an error, not a silent default');
    const badArg = await call('notebook_read', { path: P('20py.ipynb'), cell_selector: '0' });
    note(brief(badArg, { code: (j) => j.error?.code ?? j.code, msg: (j) => String(j.error?.message ?? j.message ?? '').slice(0, 160) })
      || badArg.text.slice(0, 200));

    note('--- bogus run_id');
    const bogus = await call('notebook_run_status', { run_id: 'nope' });
    note(brief(bogus, { code: (j) => j.error?.code ?? j.code }) || bogus.text.slice(0, 200));

    note('--- kernel status with no kernels');
    const st = await call('notebook_kernel', { action: 'status' });
    note(brief(st, { kernels: (j) => j.kernels?.length, warnings: (j) => j.warnings?.length }));
  },

  /** The full per-notebook flow on all five ChangeJob notebooks. */
  async suite({ call, note }) {
    const plans = [
      { name: '20py.ipynb', probe: PROBES.plain, realCells: ['0'], background: true, markdown: true },
      { name: 'simple-baseline-aai3100.ipynb', probe: PROBES.env, realCells: [] },
      { name: '便捷性.ipynb', probe: PROBES.image, realCells: [], imageReads: true },
      { name: 'hw2_solved.ipynb', probe: PROBES.light, realCells: [] },
      { name: 'coursework_base.ipynb', probe: PROBES.light, realCells: ['1'] },
    ];

    for (const plan of plans) {
      const nb = P(plan.name);
      note(`\n================ ${plan.name}`);

      // 1. read ------------------------------------------------------------------
      const before = await call('notebook_read', { path: nb, include_source: 'preview', include_outputs: 'summary' });
      const b = before.json ?? {};
      note(`read: ${brief(before, {
        cells: (j) => j.cell_count,
        hash: (j) => String(j.content_hash).slice(0, 12),
        kernel: (j) => j.kernel_name,
        lang: (j) => `${j.language_name}${j.language_version ?? ''}`,
        ids: (j) => j.has_stable_cell_ids,
        warn: (j) => (j.warnings ?? []).map((w) => w.code).join('|'),
      })}`);
      note(`  cell keys: ${Object.keys(b.cells?.[0] ?? {}).join(',')}`);
      const cellCount = b.cell_count;
      const contentHash = b.content_hash;

      // 2. CAS negative: a stale hash must not write -----------------------------
      const casBad = await call('notebook_edit', {
        path: nb,
        ops: [{ op: 'replace_source', cell_index: 0, new_text: '# WRONG', expected_source_hash: 'deadbeef' }],
      });
      const afterBad = await call('notebook_read', { path: nb, include_source: 'none', include_outputs: 'none' });
      note(`CAS-negative: ${brief(casBad, { code: (j) => j.error?.code ?? j.code })} | unchanged=${afterBad.json?.content_hash === contentHash}`);

      // 3. dry run must not write -------------------------------------------------
      const dry = await call('notebook_edit', {
        path: nb,
        dry_run: true,
        ops: [{ op: 'insert_cell', at_index: cellCount, cell_type: 'markdown', source: PROBE_MD }],
      });
      const afterDry = await call('notebook_read', { path: nb, include_source: 'none', include_outputs: 'none' });
      note(`dry-run: ${brief(dry, { applied: (j) => j.applied })} | unchanged=${afterDry.json?.content_hash === contentHash}`);

      // 4. insert the probe cells --------------------------------------------------
      const ins = await call('notebook_edit', {
        path: nb,
        ops: [
          { op: 'insert_cell', at_index: cellCount, cell_type: 'markdown', source: PROBE_MD },
          { op: 'insert_cell', at_index: cellCount + 1, cell_type: 'code', source: plan.probe },
        ],
      });
      note(`insert: ${brief(ins, {
        applied: (j) => j.applied,
        changed: (j) => (j.changed_cells ?? []).map((c) => `${c.cell_index}:${c.change ?? c.op ?? '?'}`).join(','),
        warn: (j) => (j.warnings ?? []).map((w) => w.code).join('|'),
        mdIssues: (j) => (j.markdown_issues ?? []).length,
      })}`);
      const probeIndex = cellCount + 1;

      // 5. kernel start (the ONLY way to run one cell without replaying the prefix)
      const k = await call('notebook_kernel', { action: 'start', path: nb });
      note(`kernel start: ${brief(k, {
        alive: (j) => j.kernels?.[0]?.alive,
        pid: (j) => j.kernels?.[0]?.pid,
        interp: (j) => String(j.kernels?.[0]?.interpreter_path ?? '').slice(-28),
        warn: (j) => (j.warnings ?? []).map((w) => w.code).join('|'),
      })}`);

      // 6. run ONLY the probe cell (resume = no replay of the real cells) ---------
      const run = await call('notebook_run', {
        path: nb,
        cell_selector: String(probeIndex),
        mode: 'resume',
      });
      note(`run probe: ${brief(run, {
        kind: (j) => j.kind,
        mode: (j) => `${j.mode_requested}->${j.mode_used}`,
        executed: (j) => j.executed,
        replayed: (j) => (j.replayed_cell_indexes ?? []).length,
        writeBack: (j) => j.write_back?.performed,
        backup: (j) => String(j.write_back?.backup_path ?? '').split('\\').pop(),
        stale: (j) => (j.stale_cells ?? []).length,
        alive: (j) => j.kernel_alive,
        warn: (j) => (j.warnings ?? []).map((w) => w.code).join('|'),
      })}`);
      if (!isOk(run)) note(run.text.slice(0, 800));

      // 7. read the probe back — the write-back is only real if READ sees it ------
      const back = await call('notebook_read', {
        path: nb,
        cell_indexes: [probeIndex],
        include_source: 'full',
        include_outputs: 'full',
      });
      const cell = back.json?.cells?.[0] ?? {};
      note(`read back: ${brief(back, {
        cells: (j) => j.cell_count,
        execCount: () => cell.execution_count,
        outputs: () => (cell.outputs ?? []).length,
        kinds: () => (cell.outputs ?? []).map((o) => o.kind ?? o.output_type).join('|'),
        text: () => JSON.stringify((cell.outputs ?? []).map((o) => String(o.text ?? '').trim()).join(' / ').slice(0, 120)),
      })} | imageBlocks=${back.images.length}`);

      // 8. a real existing cell, run in the same live kernel ----------------------
      for (const idx of plan.realCells ?? []) {
        const real = await call('notebook_run', { path: nb, cell_selector: idx, mode: 'resume' });
        note(`real cell ${idx}: ${brief(real, {
          mode: (j) => j.mode_used,
          executed: (j) => j.executed,
          status: (j) => (j.executed ?? []).map((e) => `${e.cell_index}:${e.status}`).join(','),
          stale: (j) => (j.stale_cells ?? []).length,
          writeBack: (j) => j.write_back?.performed,
          warn: (j) => (j.warnings ?? []).map((w) => w.code).join('|'),
        })}`);
        if (!isOk(real)) note(`   run error: ${real.text.slice(0, 500)}`);
      }

      // 9. read a real cell's stored outputs, images included --------------------
      if (plan.imageReads) {
        const img = await call('notebook_read', { path: nb, cell_indexes: [11], include_source: 'none', include_outputs: 'full' });
        const c = img.json?.cells?.[0] ?? {};
        note(`real image read (cell 11): ${brief(img, {
          outputs: () => (c.outputs ?? []).length,
          kinds: () => (c.outputs ?? []).map((o) => o.kind).join('|'),
          artifacts: () => (c.outputs ?? []).filter((o) => o.artifact_path).length,
        })} | imageBlocks=${img.images.length} | warn=${(img.json?.warnings ?? []).map((w) => w.code).join('|')}`);
      }

      // 10. background run on two cells (proves the polling path) -----------------
      if (plan.background) {
        const more = await call('notebook_edit', {
          path: nb,
          ops: [{ op: 'insert_cell', at_index: probeIndex + 1, cell_type: 'code', source: 'print("MCP_BG", 1)\n' }],
        });
        note(`insert bg cell: applied=${more.json?.applied}`);
        const bg = await call('notebook_run', { path: nb, cell_selector: `${probeIndex},${probeIndex + 1}`, mode: 'resume' });
        const j = bg.json ?? {};
        note(`bg submit: kind=${j.kind} run_id=${j.run_id ? String(j.run_id).slice(0, 8) : null} state=${j.state ?? ''} warn=${(j.warnings ?? []).map((w) => w.code).join('|')}`);
        if (j.run_id) {
          let st = null;
          for (let i = 0; i < 40; i += 1) {
            const s = await call('notebook_run_status', { run_id: j.run_id });
            st = s.json ?? {};
            if (['completed', 'failed', 'cancelled'].includes(st.state)) break;
            await new Promise((r) => setTimeout(r, 500));
          }
          note(`bg poll: state=${st?.state} executed=${JSON.stringify(st?.executed)} stale=${(st?.stale_cells ?? []).length}`);
        }
      }

      // 11. markdown structure check ---------------------------------------------
      if (plan.markdown) {
        const np = await call('notebook_read', { path: nb, cell_indexes: [cellCount], include_source: 'full', include_outputs: 'none' });
        const md = np.json?.cells?.[0] ?? {};
        const anchor = md.source_hash ?? md.hash ?? null;
        const broken = await call('notebook_edit', {
          path: nb,
          ops: [{
            op: 'replace_source',
            cell_index: cellCount,
            new_text: '## MCP 试跑\n\n```python\nprint("unclosed fence")\n',
            ...(anchor ? { expected_source_hash: anchor } : { expected_text: md.source }),
          }],
        });
        note(`markdown check: ${brief(broken, {
          applied: (j) => j.applied,
          mdIssues: (j) => JSON.stringify(j.markdown_issues ?? []).slice(0, 200),
          warn: (j) => (j.warnings ?? []).map((w) => w.code).join('|'),
        })}`);
      }

      // 12. kernel lifecycle ------------------------------------------------------
      const st = await call('notebook_kernel', { action: 'status' });
      note(`kernel status: kernels=${(st.json?.kernels ?? []).length} alive=${JSON.stringify((st.json?.kernels ?? []).map((x) => x.alive))}`);
      const down = await call('notebook_kernel', { action: 'shutdown', path: nb });
      const st2 = await call('notebook_kernel', { action: 'status' });
      note(`after shutdown: shutdown_kernels=${(down.json?.kernels ?? []).length} status_kernels=${(st2.json?.kernels ?? []).length}`);

      // 13. did the file survive? compare with the source copy -------------------
      const fin = await call('notebook_read', { path: nb, include_source: 'none', include_outputs: 'none' });
      note(`final: cells=${fin.json?.cell_count} (was ${cellCount}) hash=${String(fin.json?.content_hash).slice(0, 12)} (was ${String(contentHash).slice(0, 12)}) warn=${(fin.json?.warnings ?? []).map((w) => w.code).join('|')}`);
    }
  },
};
