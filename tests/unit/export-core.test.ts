import { describe, expect, it } from 'vitest';

import { renderExportDocument, staticHtml } from '../../src/core/export.js';
import { parseNotebook } from '../../src/core/parse.js';
import { hasher } from '../../src/hash.js';
import { exportFixture, EXPORT_PNG } from '../fixtures/export.js';

describe('[EXPORT][U1][U26] static notebook export', () => {
  it('renders saved Markdown, tables, attachments, images, streams and errors without mutating the notebook', () => {
    const notebook = parseNotebook(Buffer.from(JSON.stringify(exportFixture())), hasher);
    const before = JSON.stringify(notebook);
    const document = renderExportDocument(notebook, '<Report & title>', true);
    expect(document.html).toContain('<title>&lt;Report &amp; title&gt;</title>');
    expect(document.html).toContain('<h1>分析报告</h1>');
    expect(document.html).toContain('<strong>Saved results</strong>');
    expect(document.html).toContain('<td>中文</td>');
    expect(document.html).toContain('<th>Column</th>');
    expect(document.html).toContain('中文与 emoji 😀');
    expect(document.html).toContain('ValueError: saved failure');
    expect(document.html).toContain('raw &lt;literal&gt;');
    expect(document.html).toContain('MUST NOT EXECUTE');
    expect(document.html.split(EXPORT_PNG).length - 1).toBe(2);
    expect(document.html).not.toContain('DO NOT DUPLICATE');
    expect(document.warnings).toEqual([]);
    expect(JSON.stringify(notebook)).toBe(before);
    expect(renderExportDocument(notebook, '<Report & title>', true)).toEqual(document);
  });

  it('hides code source while preserving Markdown and all saved output text without preview truncation', () => {
    const fixture = exportFixture();
    fixture.cells[1]!.outputs![0]!.text = ['x'.repeat(80_000)];
    const notebook = parseNotebook(Buffer.from(JSON.stringify(fixture)), hasher);
    const result = renderExportDocument(notebook, 'Report', false);
    expect(result.html).not.toContain('MUST NOT EXECUTE');
    expect(result.html).toContain('x'.repeat(80_000));
    expect(result.html).toContain('分析报告');
  });

  it('rebuilds hostile rich HTML without executable tags, attributes, styles or local resource URLs', () => {
    const html = staticHtml('<script>alert(1)</script><style>body{display:none}</style><meta http-equiv="refresh" content="0;url=file:///secret"><base href="file:///"><svg onload="alert(1)"></svg><img src="file:///secret" onerror="alert(1)"><a href="jav&#97;script:alert(1)" onclick="alert(1)">unsafe</a><td colspan="2" style="background:url(http://evil)">safe &amp; sound</td>');
    expect(html).toBe('<span class="omitted">[Image omitted]</span><a>unsafe</a><td colspan="2">safe &amp; sound</td>');
  });

  it('reports external images and widgets with static placeholders and a bounded warning', () => {
    const notebook = parseNotebook(Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
      { cell_type: 'markdown', metadata: {}, source: '![remote](https://example.invalid/a.png)' },
      { cell_type: 'code', metadata: {}, source: '', execution_count: null, outputs: [{ output_type: 'display_data', metadata: {}, data: { 'application/vnd.jupyter.widget-view+json': { model_id: 'secret' } } }] },
    ] })), hasher);
    const document = renderExportDocument(notebook, 'Report', true);
    expect(document.html).not.toContain('https://example.invalid');
    expect(document.html).not.toContain('secret');
    expect(document.warnings).toEqual([{ code: 'output_truncated', message: expect.stringContaining('2 unsupported') }]);
  });
});
