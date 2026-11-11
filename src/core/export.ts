import { createWarning, type Warning } from './errors.js';
import { stringifyJsonExact } from './json-exact.js';
import { imageBlockBase64, rawOutputsOfCell, type RawOutput } from './outputs.js';
import { cellSource, executionCountForDisplay, type NotebookCell, type NotebookFile } from './parse.js';

export type ExportFormat = 'html' | 'pdf' | 'png';

export interface ExportDocument {
  readonly html: string;
  readonly warnings: readonly Warning[];
}

const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'";
const STYLE = `
*{box-sizing:border-box}body{margin:0;background:white;color:#20242a;font:15px/1.6 Georgia,'Times New Roman',serif}
main{max-width:1120px;margin:auto;padding:36px 40px}h1,h2,h3,h4,h5,h6{line-height:1.3;break-after:avoid}
header{border-bottom:1px solid #ddd;margin-bottom:28px}header h1{overflow-wrap:anywhere;font-size:26px}
.cell{margin:0 0 24px}.prompt{font:12px/1.4 monospace;color:#68717b;margin-bottom:5px}
pre,code{font-family:Consolas,'DejaVu Sans Mono',monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:12px 16px;font-size:13px;line-height:1.5}
.input{background:#f5f6f7;border:1px solid #ddd;border-radius:4px}.output{margin-top:10px;overflow-wrap:anywhere}
.output pre{padding:6px 0}.stderr,.error{color:#a11}.omitted{color:#68717b;font-style:italic}
img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%;font-size:13px}th,td{border:1px solid #ccc;padding:5px 10px;text-align:left}
th{font-weight:bold}blockquote{margin-left:0;border-left:3px solid #ccc;padding-left:16px}a{color:#185b9d}
@page{size:A4;margin:15mm}@media print{main{padding:0;max-width:none}.input,figure,tr{break-inside:avoid}a{color:inherit}}
`;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value.join('') : null;
}

function imageBundle(bundle: Record<string, unknown>): string | null {
  for (const mime of ['image/png', 'image/jpeg'] as const) {
    const value = textValue(bundle[mime]);
    const data = value === null ? null : imageBlockBase64(value, mime);
    if (data !== null) {
      return `data:${mime};base64,${data}`;
    }
  }
  const svg = textValue(bundle['image/svg+xml']);
  // SVG loaded as an image cannot execute scripts or load external documents.
  return svg === null ? null : `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function safeLink(value: string): string | null {
  return /^(?:https?:\/\/|mailto:|#)/i.test(value) && !Array.from(value).some((char) => char.charCodeAt(0) <= 32 || '"<>'.includes(char)) ? value : null;
}

type ImageResolver = (url: string) => string | null;

const HTML_TAGS = new Set('p br hr div span pre code table thead tbody tfoot tr th td caption strong b em i u s sub sup ul ol li blockquote h1 h2 h3 h4 h5 h6 details summary a img'.split(' '));

/** Rebuild a static subset; no original attribute or executable element survives. */
export function staticHtml(source: string, resolveImage: ImageResolver = () => null): string {
  const input = source.replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const tags = /<!--[\s\S]*?(?:-->|$)|<\/?([a-z][a-z0-9:-]*)\b([^<>]*?)>/gi;
  let cursor = 0;
  let result = '';
  for (const match of input.matchAll(tags)) {
    // Entities in text stay entities; angle brackets outside recognized tags stay text.
    result += input.slice(cursor, match.index).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    cursor = match.index + match[0].length;
    const tag = match[1]?.toLowerCase();
    if (tag === undefined || !HTML_TAGS.has(tag)) {
      continue;
    }
    if (match[0].startsWith('</')) {
      result += `</${tag}>`;
      continue;
    }
    const attrs = new Map<string, string>();
    for (const attr of (match[2] ?? '').matchAll(/([^\s=/'"]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"=<>`]+))/g)) {
      attrs.set((attr[1] ?? '').toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    if (tag === 'img') {
      const url = resolveImage(attrs.get('src') ?? '');
      result += url === null ? '<span class="omitted">[Image omitted]</span>' : `<img src="${escapeHtml(url)}" alt="${escapeHtml(attrs.get('alt') ?? 'Notebook image')}">`;
      continue;
    }
    let attributes = '';
    const href = tag === 'a' ? safeLink(attrs.get('href') ?? '') : null;
    if (href !== null) {
      attributes += ` href="${escapeHtml(href)}" rel="noreferrer noopener"`;
    }
    if (tag === 'td' || tag === 'th') {
      for (const key of ['colspan', 'rowspan']) {
        const value = attrs.get(key);
        if (value !== undefined && /^[1-9]\d{0,2}$/.test(value)) {
          attributes += ` ${key}="${value}"`;
        }
      }
    }
    result += `<${tag}${attributes}>`;
  }
  return result + input.slice(cursor).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMarkdown(source: string, image: ImageResolver): string {
  const tokens = /`([^`]+)`|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let result = '';
  let cursor = 0;
  for (const match of source.matchAll(tokens)) {
    result += escapeHtml(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (match[1] !== undefined) {
      result += `<code>${escapeHtml(match[1])}</code>`;
    } else if (match[2] !== undefined) {
      const src = image(match[3] ?? '');
      result += src === null ? '<span class="omitted">[Image omitted]</span>' : `<img src="${escapeHtml(src)}" alt="${escapeHtml(match[2])}">`;
    } else if (match[4] !== undefined) {
      const href = safeLink(match[5] ?? '');
      result += href === null ? escapeHtml(match[4]) : `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${escapeHtml(match[4])}</a>`;
    } else {
      const tag = match[6] !== undefined ? 'strong' : 'em';
      result += `<${tag}>${escapeHtml(match[6] ?? match[7] ?? '')}</${tag}>`;
    }
  }
  return result + escapeHtml(source.slice(cursor));
}

function markdown(source: string, image: ImageResolver): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const result: string[] = [];
  const tableRow = (line: string, tag: string) => `<tr>${line.trim().replace(/^\||\|$/g, '').split('|').map((part) => `<${tag}>${inlineMarkdown(part.trim(), image)}</${tag}>`).join('')}</tr>`;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      const code: string[] = [];
      const marker = fence[1] ?? '```';
      while (++index < lines.length && !(lines[index] ?? '').trim().startsWith(marker)) {
        code.push(lines[index] ?? '');
      }
      result.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    } else if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? '')) {
      let table = `<table><thead>${tableRow(line, 'th')}</thead><tbody>`;
      index += 1;
      while ((lines[index + 1] ?? '').includes('|')) {
        table += tableRow(lines[++index] ?? '', 'td');
      }
      result.push(`${table}</tbody></table>`);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = /^#+/.exec(line)?.[0].length ?? 1;
      result.push(`<h${level}>${inlineMarkdown(line.slice(level).trim(), image)}</h${level}>`);
    } else if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      result.push('<hr>');
    } else if (/^\s*(?:[-+*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const kind = ordered ? 'ol' : 'ul';
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-+*]\s+/;
      const items = [`<li>${inlineMarkdown(line.replace(pattern, ''), image)}</li>`];
      while (pattern.test(lines[index + 1] ?? '')) {
        items.push(`<li>${inlineMarkdown((lines[++index] ?? '').replace(pattern, ''), image)}</li>`);
      }
      result.push(`<${kind}>${items.join('')}</${kind}>`);
    } else if (/^>\s?/.test(line)) {
      result.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''), image)}</blockquote>`);
    } else if (line.trim().startsWith('<')) {
      const block = [line];
      while ((lines[index + 1] ?? '').trim() !== '') {
        block.push(lines[++index] ?? '');
      }
      result.push(staticHtml(block.join('\n'), image));
    } else if (line.trim() !== '') {
      result.push(`<p>${inlineMarkdown(line, image)}</p>`);
    }
  }
  return result.join('\n');
}

function outputHtml(output: RawOutput, image: ImageResolver): string | null {
  if (output.outputType === 'stream') {
    return `<pre class="${output.name === 'stderr' ? 'stderr' : 'stdout'}">${escapeHtml(stripAnsi(output.text ?? ''))}</pre>`;
  }
  if (output.outputType === 'error') {
    return `<pre class="error">${escapeHtml(stripAnsi(output.traceback?.join('\n') || `${output.ename ?? 'Error'}: ${output.evalue ?? ''}`))}</pre>`;
  }
  const bundle = output.data ?? {};
  const html = textValue(bundle['text/html']);
  if (html !== null) {
    return staticHtml(html, image);
  }
  const src = imageBundle(bundle);
  if (src !== null) {
    return `<img src="${escapeHtml(src)}" alt="Notebook output">`;
  }
  const md = textValue(bundle['text/markdown']);
  if (md !== null) {
    return markdown(md, image);
  }
  const plain = textValue(bundle['text/plain']);
  if (plain !== null) {
    return `<pre>${escapeHtml(stripAnsi(plain))}</pre>`;
  }
  if ('application/json' in bundle) {
    return `<pre>${escapeHtml(stringifyJsonExact(bundle['application/json'], 2))}</pre>`;
  }
  return null;
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

export function renderExportDocument(notebook: NotebookFile, title: string, includeSource: boolean): ExportDocument {
  let omitted = 0;
  const renderCell = (cell: NotebookCell, index: number): string => {
    const image: ImageResolver = (url) => {
      if (url.startsWith('attachment:')) {
        const attachments = cell['attachments'];
        if (typeof attachments === 'object' && attachments !== null) {
          const bundle: unknown = (attachments as Record<string, unknown>)[url.slice(11)];
          if (typeof bundle === 'object' && bundle !== null && !Array.isArray(bundle)) {
            const data = imageBundle(bundle as Record<string, unknown>);
            if (data !== null) {
              return data;
            }
          }
        }
      }
      const data = /^data:(image\/(?:png|jpeg));base64,(.*)$/is.exec(url);
      if (data !== null) {
        const canonical = imageBlockBase64(data[2] ?? '', data[1]!.toLowerCase() as 'image/png' | 'image/jpeg');
        if (canonical !== null) {
          return `data:${data[1]!.toLowerCase()};base64,${canonical}`;
        }
      }
      omitted += 1;
      return null;
    };
    const source = cellSource(cell);
    if (cell.cell_type === 'markdown') {
      return `<section class="cell markdown" data-cell-index="${index}">${markdown(source, image)}</section>`;
    }
    if (cell.cell_type === 'raw') {
      return `<section class="cell raw" data-cell-index="${index}"><pre>${escapeHtml(source)}</pre></section>`;
    }
    const count = executionCountForDisplay(cell);
    const input = includeSource ? `<div class="prompt">In [${count ?? ' '}]:</div><pre class="input"><code>${escapeHtml(source)}</code></pre>` : '';
    const outputs = rawOutputsOfCell(cell).map((output) => {
      const rendered = outputHtml(output, image);
      if (rendered === null) {
        omitted += 1;
      }
      return `<div class="output">${rendered ?? '<p class="omitted">[Unsupported output omitted]</p>'}</div>`;
    }).join('\n');
    return `<section class="cell code" data-cell-index="${index}">${input}${outputs}</section>`;
  };
  const body = notebook.cells.map(renderCell).join('\n');
  return {
    html: `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><header><h1>${escapeHtml(title)}</h1></header>${body}</main></body></html>`,
    warnings: omitted === 0 ? [] : [createWarning('output_truncated', `${omitted} unsupported output(s) or external/missing image(s) were omitted from the static export; scripts, widgets and external resources are not rendered`)],
  };
}
