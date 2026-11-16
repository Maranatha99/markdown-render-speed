// A fast, dependency-free CommonMark 0.31.2 + GFM renderer that matches
// marked 18.1.3 (default options) byte for byte. Written from scratch.
//
// Architecture: line-based block parser (open-blocks stack) + inline
// parser (delimiter stack for emphasis/links) + direct HTML rendering.

// ---------------- utilities ----------------

const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_NOENC_RE = /[<>"']|&(?!(#\d{1,7};|#[Xx][0-9a-fA-F]{1,6};|\w+;))/g;
const ESC_TEST = /[&<>"']/;
const ESC_NOENC_TEST = /[<>"']|&(?!(#\d{1,7};|#[Xx][0-9a-fA-F]{1,6};|\w+;))/;

function esc(s, encode) {
  if (encode) return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC_MAP[c]) : s;
  return ESC_NOENC_TEST.test(s) ? s.replace(ESC_NOENC_RE, (c) => ESC_MAP[c]) : s;
}

// Decode numeric character references only (marked leaves named entities
// literal). Invalid code points become U+FFFD.
function decodeNumericEntities(s) {
  if (s.indexOf('&#') < 0) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf('&#', i);
    if (amp < 0) { out += s.slice(i); break; }
    out += s.slice(i, amp);
    let j = amp + 2;
    let code = -1;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      const start = j;
      while (j < s.length && /[0-9a-fA-F]/.test(s[j])) j++;
      if (j > start && s[j] === ';') code = parseInt(s.slice(start, j), 16);
    } else {
      const start = j;
      while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
      if (j > start && s[j] === ';') code = parseInt(s.slice(start, j), 10);
    }
    if (code >= 0) {
      if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) code = 0xFFFD;
      out += String.fromCodePoint(code);
      i = j + 1;
    } else {
      out += '&#';
      i = amp + 2;
    }
  }
  return out;
}

// marked's cleanUrl: encode the destination (spaces -> %20 etc.).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (_) {
    return null;
  }
}

// Normalize a link label: unescape backslash escapes, collapse whitespace
// runs to one space, trim, lowercase.
// Link label normalization (marked's F): trim, collapse whitespace,
// then Unicode case-fold via lower->upper->lower (so ẞ folds to ss,
// matching SS). Backslash escapes are NOT processed here.
function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase();
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/u;
function isPunct(c) { return c !== undefined && PUNCT_RE.test(c); }
function isWS(c) { return c !== undefined && WS_RE.test(c); }

// Expand the leading whitespace (spaces/tabs) of `s` into spaces, starting
// at column `baseCol`. Returns {text, cols}: text is the expanded string,
// cols the number of columns of leading whitespace.
function expandLead(s, baseCol) {
  let i = 0, col = baseCol, out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { out += ' '; col++; i++; }
    else if (ch === '\t') { const w = 4 - (col & 3); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  return { text: out + s.slice(i), cols: col - baseCol, chars: i };
}
// Columns of leading whitespace in `s` starting at column baseCol.
function indentCols(s, baseCol) {
  let col = baseCol, i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col & 3); i++; }
    else break;
  }
  return { cols: col - baseCol, chars: i };
}

// ---------------- link reference definitions ----------------

// Parse a link label for a definition, starting at text[pos] === '['.
// Returns {label, end} (end just past ']') or null. No unescaped brackets;
// newlines allowed unless followed by a blank line.
function parseDefLabel(text, pos) {
  let i = pos + 1;
  let label = '';
  if (text[i] === ']' || text[i] === undefined) return null;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) { label += text[i] + text[i + 1]; i += 2; }
    else if (c === '[' || c === ']') {
      if (c === ']') return { label, end: i + 1 };
      return null;
    }
    else if (c === '\n') {
      // newline allowed unless followed by a blank line
      let j = i + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
      if (text[j] === '\n' || j >= text.length) return null;
      label += c; i++;
    }
    else { label += c; i++; }
  }
  return null;
}

// Parse one link reference definition at the start of `text` (a line-start
// position; `text` holds the remaining input, lines joined by '\n').
// Mirrors marked's def regex. Returns {end} (index just past the def, at a
// line start) or null. Registers the definition in `refs` (first wins).
function parseLinkDef(text, refs) {
  let i = 0;
  let sp = 0;
  while (sp < 3 && text[i] === ' ') { i++; sp++; }
  if (text[i] !== '[') return null;
  const lab = parseDefLabel(text, i);
  if (!lab) return null;
  const key = normalizeLabel(lab.label);
  if (key.length === 0 || key.length > 999) return null;
  i = lab.end;
  if (text[i] !== ':') return null;
  i++;
  while (text[i] === ' ') i++;
  if (text[i] === '\n') {
    i++;
    while (text[i] === ' ' || text[i] === '\t') i++;
  }
  // destination
  let dest = null;
  if (text[i] === '<') {
    let j = i + 1;
    let d = '';
    while (j < text.length && text[j] !== '\n' && text[j] !== '>') {
      if (text[j] === '\\' && j + 1 < text.length && PUNCT.has(text[j + 1])) { d += text[j + 1]; j += 2; }
      else if (text[j] === '<') return null;
      else { d += text[j]; j++; }
    }
    if (text[j] !== '>') return null;
    dest = d;
    i = j + 1;
  } else {
    // marked's def regex takes any run of non-space chars as the
    // destination (no parenthesis balancing, unlike inline links)
    let j = i;
    let d = '';
    while (j < text.length) {
      const c = text[j];
      if (c === '\\' && j + 1 < text.length && PUNCT.has(text[j + 1])) { d += text[j + 1]; j += 2; }
      else if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
      else { d += c; j++; }
    }
    if (d.length === 0) return null;
    dest = d;
    i = j;
  }
  // optional title
  let title = null;
  let k = i;
  // title prefix: spaces (optionally + newline + spaces) or spaces + newline + spaces
  let saveK = k;
  while (text[k] === ' ') k++;
  if (text[k] === '\n') {
    k++;
    while (text[k] === ' ' || text[k] === '\t') k++;
  } else if (k === saveK) {
    k = saveK; // no whitespace at all -> no title
  }
  if (k > saveK && k < text.length && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    const open = text[k];
    const close = open === '(' ? ')' : open;
    let m = k + 1;
    let t = '';
    let ok = false;
    while (m < text.length) {
      const c = text[m];
      if (c === '\\' && m + 1 < text.length && PUNCT.has(text[m + 1])) { t += text[m + 1]; m += 2; }
      else if (c === close) { ok = true; m++; break; }
      else if (c === '\n') {
        // newline in a title: for '...' not followed by a blank line
        if (open === "'") {
          let q = m + 1;
          while (q < text.length && (text[q] === ' ' || text[q] === '\t')) q++;
          if (text[q] === '\n' || q >= text.length) break;
        }
        t += c; m++;
      }
      else if (open === '(' && c === '(') break;
      else { t += c; m++; }
    }
    if (ok) { title = t; i = m; }
    else i = saveK;
  } else {
    i = saveK;
  }
  // end: spaces, then newlines or end of input; if a title was parsed
  // but junk follows it, the title is dropped (marked's title group is
  // optional and backtracks) and the def stands without a title.
  let j = i;
  while (text[j] === ' ') j++;
  if (j < text.length && text[j] !== '\n') {
    if (title !== null) {
      title = null;
      i = saveK;
      j = i;
      while (text[j] === ' ') j++;
      if (j < text.length && text[j] !== '\n') return null;
    } else return null;
  }
  i = j;
  let end = i;
  while (text[end] === '\n') end++;
  if (!refs.has(key)) refs.set(key, { dest, title });
  return { end: i, endWithNewlines: end };
}

// ---------------- block helpers ----------------

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Open-tag regex (CommonMark): <name (attr="v" ...)* />
const OPEN_TAG_RE = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/;

// HTML block start conditions (CommonMark types 1-7) on a line `s` whose
// leading whitespace is already expanded to spaces. Returns type or 0.
// - type 1: opening <script|<pre|<style|<textarea (closing tags do not
//   start one); type 6: a block tag (open or close) followed by space,
//   tab, '>', '/' or end of line — the tag need not close on this line;
//   type 7: a complete tag alone on the line (any tag name).
function htmlBlockType(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i > 3) return 0;
  const t = s.slice(i);
  if (t[0] !== '<') return 0;
  if (t.startsWith('<!--')) return 2;
  if (t.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(t)) return 4;
  if (t.startsWith('<![CDATA[')) return 5;
  if (/^<(script|pre|style|textarea)(?:[\s/>]|$)/i.test(t)) return 1;
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(t);
  if (m6) {
    const name = m6[1].toLowerCase();
    const after = t.slice(m6[0].length);
    if (BLOCK_TAGS.has(name) && (after === '' || /^[\s/>]/.test(after))) return 6;
    // type 7: a complete tag alone on the line. A closing tag carries
    // no attributes; an opening tag may.
    let m7 = null;
    if (t.startsWith('</')) m7 = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(t);
    else m7 = OPEN_TAG_RE.exec(t);
    if (m7 && /^[ \t]*$/.test(t.slice(m7[0].length))) return 7;
  }
  return 0;
}

// Tag name of a type-1 HTML block start (script|pre|style|textarea).
function htmlBlockTag(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  const m = /^<(script|pre|style|textarea)(?:[\s/>]|$)/i.exec(s.slice(i));
  return m ? m[1].toLowerCase() : null;
}

// Does `line` end an HTML block of the given type? Types 1-5 end at
// their terminator; type 6 runs to a blank line; type 7 is one line.
function htmlEndsHere(b, line) {
  switch (b.htmlType) {
    case 1: return b.endRe ? b.endRe.test(line) : false;
    case 2: return line.indexOf('-->') >= 0;
    case 3: return line.indexOf('?>') >= 0;
    case 4: return line.indexOf('>') >= 0;
    case 5: return line.indexOf(']]>') >= 0;
    default: return false;
  }
}

// Info needed to open an HTML block from line `s` (already stripped).
// Returns {htmlType, tag, endRe} or null.
function htmlOpenInfo(s) {
  const type = htmlBlockType(s);
  if (type === 0) return null;
  const tag = type === 1 ? htmlBlockTag(s) : null;
  const endRe = tag ? new RegExp('</' + tag + '\\s*>', 'i') : null;
  return { htmlType: type, tag, endRe };
}
// expanded to spaces). Returns {type, marker, start, contentIndent, rest}
// or null. `s` is the line content in the current container's coordinates.
function parseListMarker(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i >= 3 && s[i] !== ' ' && false) return null;
  const ind = i;
  if (ind > 3) return null;
  const rest = s.slice(ind);
  let type, marker, start = null, j = 0;
  const c0 = rest[0];
  if (c0 === '-' || c0 === '+' || c0 === '*') {
    type = 'bullet'; marker = c0; j = 1;
  } else if (c0 >= '0' && c0 <= '9') {
    let k = 0;
    while (k < rest.length && rest[k] >= '0' && rest[k] <= '9' && k < 9) k++;
    if (k === 0 || k >= 10) return null;
    if (rest[k] !== '.' && rest[k] !== ')') return null;
    type = 'ordered'; marker = rest.slice(0, k + 1); start = parseInt(rest.slice(0, k), 10);
    j = k + 1;
  } else return null;
  const after = rest.slice(j);
  // Expand the whitespace after the marker (spaces/tabs) with base =
  // marker length (ind + j), as marked does.
  const base = ind + j;
  let w = 0, col = base, afterExp = '';
  while (w < after.length && (after[w] === ' ' || after[w] === '\t')) {
    if (after[w] === ' ') { afterExp += ' '; col++; w++; }
    else { const t = 4 - (col & 3); afterExp += ' '.repeat(t); col += t; w++; }
  }
  afterExp += after.slice(w);
  const wcols = afterExp.length - afterExp.replace(/^ +/, '').length;
  if (wcols === 0 && afterExp.length > 0) return null; // no space after marker
  let contentIndent, restStr;
  if (afterExp.length === 0) {
    contentIndent = ind + j + 1;
    restStr = '';
  } else if (wcols >= 1 && wcols <= 4) {
    contentIndent = ind + j + wcols;
    restStr = afterExp.slice(wcols);
  } else {
    contentIndent = ind + j + 1;
    restStr = afterExp.slice(1);
  }
  // When the list item starts with a blank line, the spaces after the
  // marker do not change the required indentation (R = marker + 1).
  if (restStr === '') contentIndent = ind + j + 1;
  return { type, marker, start, contentIndent, rest: restStr };
}

function isThematicBreak(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i > 3) return false;
  return /^([*_-])(?:[ \t]*\1){2,}[ \t]*$/.test(s.slice(i));
}

function parseAtxHeading(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i > 3) return null;
  const rest = s.slice(i);
  const m = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(rest);
  if (!m) return null;
  let text = m[2] !== undefined ? m[2] : '';
  text = text.replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) text = '';
  return { level: m[1].length, text };
}

function parseSetext(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i > 3) return 0;
  const rest = s.slice(i);
  if (/^=+[ \t]*$/.test(rest)) return 1;
  if (/^-+[ \t]*$/.test(rest)) return 2;
  return 0;
}

function parseFence(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i > 3) return null;
  const rest = s.slice(i);
  const m = /^(`{3,}|~{3,})(.*)$/.exec(rest);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  // marked unescapes backslash+punctuation in the info string
  const info = m[2].trim().replace(/\\([\p{P}\p{S}])/gu, '$1');
  return { char: m[1][0], len: m[1].length, info, indentStr: s.slice(0, i) };
}

// Split a table line into cells (marked's `de`). `max` pads/truncates.
function splitTableCells(line, max) {
  // replace unescaped | with ' |'
  let t = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '|') {
      let n = 0;
      for (let p = i - 1; p >= 0 && line[p] === '\\'; p--) n++;
      t += (n % 2 === 1) ? '|' : ' |';
    } else t += c;
  }
  let cells = t.split(' |');
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  if (max !== undefined) {
    if (cells.length > max) cells.length = max;
    else while (cells.length < max) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Parse a table delimiter row. Returns aligns array or null.
function parseTableDelimiter(line) {
  if (!/[:|]/.test(line)) return null;
  const cells = splitTableCells(line.replace(/^ *\||\| *$/g, ''));
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    if (/^:-+:$/.test(cell)) aligns.push('center');
    else if (/^-+:$/.test(cell)) aligns.push('right');
    else if (/^:-+$/.test(cell)) aligns.push('left');
    else if (/^-+$/.test(cell)) aligns.push(null);
    else return null;
  }
  return aligns;
}

// Try to start a table: `header` line + `delim` line (both already
// container-stripped). Returns {aligns, headerCells} or null.
function tryTableStart(header, delim) {
  const headerCells = splitTableCells(header);
  if (!headerCells.length) return null;
  const aligns = parseTableDelimiter(delim);
  if (!aligns) return null;
  if (aligns.length !== headerCells.length) return null;
  return { aligns, headerCells };
}

function newBlock(type, extra) {
  const b = { type, children: [], lastLineBlank: false };
  if (extra) Object.assign(b, extra);
  return b;
}

// Strip trailing blank lines from an array of lines (marked's `ge`).
function stripTrailingBlanks(lines) {
  let end = lines.length;
  while (end > 0 && /^[ \t]*$/.test(lines[end - 1])) end--;
  return lines.slice(0, end);
}

// Remove up to `cols` columns of leading whitespace from `s` (tabs
// advance to 4-column stops, base 0). Only call when the indent is
// >= cols. A tab that starts at or beyond the stripped region is kept
// literally (marked only expands a tab at the very start of a line);
// a tab inside the region is consumed whole, since tab stops are
// multiples of 4.
function stripCols(s, cols) {
  let col = 0, i = 0;
  while (i < s.length && col < cols) {
    const ch = s[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const w = 4 - (col & 3);
      if (col + w > cols) return ' '.repeat(cols - col) + s.slice(i + 1);
      col += w; i++;
    } else break;
  }
  return s.slice(i);
}

// Columns of leading whitespace of `s` (spaces/tabs), base 0.

// marked's list tokenizer keeps the item's last line as Z.slice(R)
// (the tab-expanded line with the first R characters removed, eating
// into the text when the line is under-indented). That value — not the
// raw line — is what the lazy-line check tests.
function sliceR(s, R) {
  return expandLead(s, 0).text.slice(R);
}
function colsOf(s) {
  let col = 0, i = 0;
  while (i < s.length) {
    if (s[i] === ' ') { col++; i++; }
    else if (s[i] === '\t') { col += 4 - (col & 3); i++; }
    else break;
  }
  return col;
}

// Match a blockquote marker at the start of `s`. Returns the content after
// the marker (whitespace expanded with base = marker length, then exactly
// one space stripped), or null.
function matchBlockquote(s) {
  let i = 0;
  while (i < 3 && s[i] === ' ') i++;
  if (s[i] !== '>') return null;
  const markerLen = i + 1;
  let j = markerLen, col = markerLen, out = '';
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) {
    if (s[j] === ' ') { out += ' '; col++; j++; }
    else { const w = 4 - (col & 3); out += ' '.repeat(w); col += w; j++; }
  }
  let rest = out + s.slice(j);
  if (rest.startsWith(' ')) rest = rest.slice(1);
  return rest;
}

// Match a list item's continuation line: `s` is the line after outer
// containers were stripped, `R` the item's contentIndent. Returns the
// content, or null if the line does not belong to this item. Blank lines
// always match.
function matchItem(s, R) {
  if (/^[ \t]*$/.test(s)) return s;
  const ex = expandLead(s, 0);
  if (ex.cols >= R) return ex.text.slice(R);
  return null;
}

// Is `s` a line that can start a table delimiter row (after trimming)?
function isTableDelimLine(s) {
  return parseTableDelimiter(s) !== null;
}

// Can `s` (a line, already container-stripped) be a paragraph continuation
// line in the sense of marked's blockquote rule (Ke)? I.e. it does NOT
// start an hr, ATX heading, blockquote, fence, list marker (any number,
// even empty) or HTML block (types 1-6).
// Does an under-indented line end the list item instead of becoming
// lazy content of it? Marked's list tokenizer breaks the item's text
// when the previous line was blank (`prevBlank`), when the item's last
// line is indented code (its first non-space character, tabs counted
// as four spaces, is at column >= 4), or when that last line begins a
// fence, ATX heading, HTML block (types 1-6) or hr. The begin-patterns
// allow at most R-1 leading spaces, clamped to 0..3 (marked's `D`
// wrapper builds those regexes with `Math.max(0, Math.min(3, R-1))`).
// `m` is the item's last line in item coordinates (content indent
// already stripped).
function itemEndsOnLazyLine(prevBlank, m, R) {
  if (prevBlank) return true;
  const expanded = m.replace(/\t/g, '    ');
  if (expanded.search(/[^ ]/) >= 4) return true;
  const n = Math.max(0, Math.min(3, R - 1));
  const sp = ` {0,${n}}`;
  if (new RegExp(`^${sp}(?:\`\`\`|~~~)`).test(m)) return true;
  if (new RegExp(`^${sp}#{1,6}(?:\\s|$)`).test(m)) return true;
  if (new RegExp(`^${sp}(?:-[ \\t]*){3,}$`).test(m) ||
      new RegExp(`^${sp}(?:_[ \\t]*){3,}$`).test(m) ||
      new RegExp(`^${sp}(?:\\*[ \\t]*){3,}$`).test(m)) return true;
  const ht = htmlBlockType(m);
  if (ht > 0 && ht !== 7) {
    let j = 0;
    while (j < m.length && m[j] === ' ') j++;
    if (j <= n) return true;
  }
  return false;
}

// The item's last line in item coordinates, for the lazy-line check:
// the last line of the item's last block (saved as `lastLine` at
// finalization/creation). Tables, blockquotes and nested lists never
// trigger the check, so they report ''.
function itemLastLine(item) {
  const b = item.children[item.children.length - 1];
  if (!b) return '';
  return b.lastLine !== undefined ? b.lastLine : '';
}

function isLazyLine(s) {
  if (isThematicBreak(s)) return false;
  if (parseAtxHeading(s)) return false;
  if (matchBlockquote(s) !== null) return false;
  if (parseFence(s)) return false;
  // only html types 1-6 interrupt a paragraph; type 7 does not
  const ht = htmlBlockType(s);
  if (ht > 0 && ht !== 7) return false;
  // list marker, any number, even an empty item
  let i = 0;
  while (i < 3 && s[i] === ' ') i++;
  if (i <= 3) {
    const r = s.slice(i);
    if (/^[-+*](?:[ \t]|$)/.test(r)) return false;
    if (/^\d{1,9}[.)](?:[ \t]|$)/.test(r)) return false;
  }
  return true;
}

// Can the paragraph text `text` be a setext heading text (marked's
// lheading pattern)? First line must not start with a list marker, fence,
// blockquote, ATX heading, HTML block, table header or 4-space indent;
// continuation lines must not start with a list marker, fence, blockquote,
// ATX heading, hr, HTML block or table header, and must not be blank.
function canBeSetextText(text) {
  const lines = text.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const ln = lines[k];
    if (k === 0) {
      if (colsOf(ln) >= 4) return false;
      if (matchBlockquote(ln) !== null) return false;
      if (parseAtxHeading(ln)) return false;
      if (parseFence(ln)) return false;
      { const ht = htmlBlockType(ln); if (ht > 0 && ht !== 7) return false; }
      let i = 0;
      while (i < 3 && ln[i] === ' ') i++;
      if (i <= 3) {
        const r = ln.slice(i);
        if (/^[-+*](?:[ \t]|$)/.test(r)) return false;
        if (/^\d{1,9}[.)](?:[ \t]|$)/.test(r)) return false;
      }
    } else {
      if (/^[ \t]*$/.test(ln)) return false;
      if (isThematicBreak(ln)) return false;
      if (parseAtxHeading(ln)) return false;
      if (matchBlockquote(ln) !== null) return false;
      if (parseFence(ln)) return false;
      { const ht = htmlBlockType(ln); if (ht > 0 && ht !== 7) return false; }
      let i = 0;
      while (i < 3 && ln[i] === ' ') i++;
      if (i <= 3) {
        const r = ln.slice(i);
        if (/^[-+*](?:[ \t]|$)/.test(r)) return false;
        if (/^\d{1,9}[.)](?:[ \t]|$)/.test(r)) return false;
      }
    }
  }
  return true;
}

// ---------------- block parser ----------------

// The block parser works line by line over an open-blocks stack.
// Containers: blockquote, list, item. Leaves: paragraph, fenced code,
// indented code, html, table. Headings and hrs are finalized immediately.
function parseBlocks(src, refs) {
  const lines = src.split('\n');
  const root = { type: 'root', children: [] };
  const stack = [];
  let leaf = null;
  // Was the previous line a lazy continuation added to `leaf`?
  let prevLazy = false;
  // Did the previous line match all containers?
  let prevMatched = true;

  const holder = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const c = stack[k];
      if (c.type === 'list') continue;
      return c;
    }
    return root;
  };
  const addChild = (b) => { holder().children.push(b); };
  const lastChild = () => {
    const h = holder();
    return h.children.length ? h.children[h.children.length - 1] : null;
  };

  // Finalize and close the current leaf.
  const closeLeaf = () => {
    if (!leaf) return;
    if (leaf.type === 'paragraph') {
      leaf.lastLine = leaf.lines.length ? (leaf.lines[leaf.lines.length - 1].orig ?? leaf.lines[leaf.lines.length - 1].t) : '';
      leaf.text = leaf.lines.map((x) => x.t).join('\n');
      delete leaf.lines;
    } else if (leaf.type === 'code' && !leaf.fenced) {
      // indented code: keep at most one trailing blank line (ge)
      leaf.text = geStr(leaf.text);
      // the raw last line was indented >= 4 in item coordinates
      // (reproduced here so the lazy-line check sees it as code)
      leaf.lastLine = '    ' + (leaf.text.replace(/\n+$/, '').split('\n').pop() || '');
    } else if (leaf.type === 'code' && leaf.fenced) {
      leaf.lastLine = leaf.closed ? leaf.fenceChar.repeat(leaf.fenceLen) : (leaf.lastItemLine || '');
      if (!leaf.closed) {
        // an unclosed fence keeps exactly one trailing newline less
        // than its raw content (marked's fence text is the content with
        // one trailing '\n' stripped); a fence inside a list item has
        // already been trimEnd'd by trimLeafForItemEnd when the item
        // ended, so this is a no-op there.
        if (leaf.text.endsWith('\n')) leaf.text = leaf.text.slice(0, -1);
      }
    } else if (leaf.type === 'html') {
      leaf.lastLine = leaf.lines[leaf.lines.length - 1];
      leaf.text = leaf.lines.join('\n');
      if (htmlTrailingNL(leaf.lastLineIdx, leaf.htmlType)) leaf.text += '\n';
      delete leaf.lines;
    }
    leaf = null;
  };

  // Trim the current leaf as marked's list tokenizer trims an item's
  // text (trimEnd) when the item ends: trailing spaces on a
  // paragraph's last line, and all trailing whitespace of an
  // unclosed fence or indented code block that ends the item.
  const trimLeafForItemEnd = () => {
    if (!leaf) return;
    if (leaf.type === 'paragraph' && leaf.lines.length) {
      const last = leaf.lines[leaf.lines.length - 1];
      last.t = last.t.replace(/[ \t]+$/, '');
    } else if (leaf.type === 'code' && ((leaf.fenced && !leaf.closed) || !leaf.fenced)) {
      leaf.text = leaf.text.replace(/[ \t\n]+$/, '');
    }
  };

  // Close containers down to (and including) index `idx` in the stack.
  const closeTo = (idx) => {
    if (stack.slice(idx + 1).some((c) => c.type === 'item')) trimLeafForItemEnd();
    closeLeaf();
    while (stack.length > idx) stack.pop();
  };

  // marked's ge() on a string: keep the input as-is when there is at most
  // one trailing blank line, else strip all trailing blank lines.
  function geStr(a) {
    const e = a.split('\n');
    let t = e.length - 1;
    for (; t >= 0 && /^[ \t]*$/.test(e[t]);) t--;
    return e.length - t <= 2 ? a : e.slice(0, t + 1).join('\n');
  }

  // Walk the open containers against `line`. Returns {content, failedAt,
  // consumedAt}: content is the line after the containers that matched;
  // failedAt is the index in `stack` of the first container that did
  // not match (-1 if all matched); consumedAt is the index of the
  // innermost container that consumed characters from the line.
  const walkContainers = (line) => {
    let content = line;
    let consumedAt = -1;
    for (let k = 0; k < stack.length; k++) {
      const c = stack[k];
      if (c.type === 'blockquote') {
        const m = matchBlockquote(content);
        if (m === null) return { content, failedAt: k, consumedAt };
        if (m.length < content.length) consumedAt = k;
        content = m;
      } else if (c.type === 'list') {
        // a list consumes nothing
      } else if (c.type === 'item') {
        const m = matchItem(content, c.contentIndent);
        if (m === null) return { content, failedAt: k, consumedAt };
        if (m.length < content.length) consumedAt = k;
        content = m;
      }
    }
    return { content, failedAt: -1, consumedAt };
  };

  // An item whose first line is blank ends when a blank line follows
  // (marked's list tokenizer breaks the item there).
  const endEmptyItem = () => {
    const top = stack[stack.length - 1];
    if (top && top.type === 'item' && top.blankFirst && top.children.length === 0) {
      closeLeaf();
      stack.pop();
    }
  };

  // Content of a blank line inside the current containers, for code
  // blocks: strip each enclosing list item's indent (a blank line
  // inside a blockquote would have ended the blockquote already).
  const blankLineContent = (line) => {
    let s = line;
    for (const c of stack) {
      if (c.type === 'item') {
        const ex = expandLead(s, 0);
        s = ex.cols >= c.contentIndent ? ex.text.slice(c.contentIndent) : '';
      }
    }
    return s;
  };

  // Append a whitespace-only line to an open code block, keeping the
  // spaces that survive the code indent (indented code strips 4
  // columns, fenced code strips the opening fence's indent for
  // backticks).
  const appendCodeBlank = (content, li2) => {
    if (leaf.fenced) {
      let add = content;
      if (leaf.fenceChar === '`') add = content.slice(Math.min(leaf.indentStr.length, (content.match(/^\s*/) || [''])[0].length));
      leaf.text += add + (li2 < lines.length - 1 ? '\n' : '');
      leaf.lastItemLine = content;
    } else {
      leaf.text += stripCols(content, 4) + (li2 < lines.length - 1 ? '\n' : '');
    }
    leaf.lastAppendBlank = true;
  };

  // Content of line `li` after the containers that match (used for the
  // table look-ahead). Returns {content, matched} where matched is whether
  // all containers matched.
  const lineContentAt = (li2) => {
    const w = walkContainers(lines[li2]);
    return { content: w.content, matched: w.failedAt === -1 };
  };

  // Does an HTML block whose last content line is `k` keep a trailing
  // '\n' in its text? Marked's html token keeps exactly one trailing
  // newline when the next line in the block's container stream is
  // non-blank, or when the source ends with a single newline after it
  // (at the root). A blank line, a closed container, or EOF after two
  // newlines all drop it. Types 6-7 differ: marked's regex eats the
  // whole blank-line run after them (spaces/tabs included) and ge()
  // strips it, so they never keep a trailing newline except when the
  // block runs to EOF with a trailing newline.
  const htmlTrailingNL = (k, htmlType) => {
    if (htmlType >= 6) {
      return stack.length === 0 && k + 1 === lines.length - 1 && lines[k + 1] === '';
    }
    for (let j = k + 1; j < lines.length; j++) {
      const w = walkContainers(lines[j]);
      if (w.failedAt !== -1) {
        // The line failed a container, but it can still be lazy
        // content of the failed item (kept in the item's text, as
        // marked's list tokenizer appends it): then it is a
        // non-empty line in the item's stream and the newline after
        // the HTML block survives. A whitespace-only line also keeps
        // it; only a truly empty line drops it.
        const f = stack[w.failedAt];
        if (w.content === '') return false;
        if (w.content.trim() === '') return true;
        if (f && f.type === 'item' && isLazyLine(w.content) &&
            !itemEndsOnLazyLine(f.lastLineBlank, itemLastLine(f), f.contentIndent)) return true;
        return false;
      }
      // Only a truly empty line (zero characters after the containers)
      // consumes the newline after the HTML block: marked's html regex
      // eats `\n*`/`\n+` after the closing tag, and ge() strips the
      // trailing newline only when two or more newlines follow. A line
      // holding only spaces or tabs stops that consumption, so the
      // newline after the block's last line survives.
      if (w.content === '') {
        if (stack.length === 0 && j === lines.length - 1 && j - k === 1) return true;
        return false;
      }
      return true;
    }
    return false;
  };

  // Add a child block to the current holder, marking the enclosing list
  // loose when a blank line preceded it. Only containers that are
  // ancestors of the new block count: a block added to the root after a
  // list closed must not loosen that list.
  const addBlock = (b) => {
    let hIdx = -1;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].type !== 'list') { hIdx = k; break; }
    }
    let looseList = null;
    for (let k = hIdx; k >= 0; k--) {
      if (stack[k].lastLineBlank) {
        for (let j = k; j >= 0; j--) {
          if (stack[j].type === 'list') { looseList = stack[j]; break; }
        }
        break;
      }
    }
    if (looseList) looseList.loose = true;
    for (const c of stack) c.lastLineBlank = false;
    holder().children.push(b);
    // Containers above the holder are closed by this block (a bare list
    // left on the stack ends here; a later marker starts a new list).
    while (stack.length > hIdx + 1) stack.pop();
  };

  // Open a fenced code block from a fence line `content` (already stripped).
  const openFence = (content, li2) => {
    const f = parseFence(content);
    const b = { type: 'code', fenced: true, lang: f.info, text: '', fenceChar: f.char, fenceLen: f.len, indentStr: f.indentStr, closed: false, lastLineBlank: false, lastAppendBlank: false, lastItemLine: content };
    addBlock(b);
    leaf = b;
    return b;
  };

  // Open a paragraph with first line `text` (already stripped). `matched`
  // records whether the line matched all containers (chunk tracking).
  const openParagraph = (text, matched) => {
    closeLeaf();
    const b = { type: 'paragraph', lines: [{ t: text, m: matched }], lastLineBlank: false };
    addBlock(b);
    leaf = b;
    return b;
  };

  // Is the current leaf a paragraph directly inside a list item?
  const paraInItem = () => {
    if (!leaf || leaf.type !== 'paragraph') return false;
    const top = stack[stack.length - 1];
    return !!(top && top.type === 'item');
  };

  // The list item (if any) that directly contains the current leaf.
  const curItem = () => {
    const top = stack[stack.length - 1];
    return (top && top.type === 'item') ? top : null;
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const blank = /^[ \t]*$/.test(line);

    if (blank) {
      // A blank line ends any open blockquote (marked's blockquote token
      // never spans a blank line) but not a list: pop everything from
      // the outermost blockquote up.
      let bqIdx = -1;
      for (let k = 0; k < stack.length; k++) if (stack[k].type === 'blockquote') { bqIdx = k; break; }
      if (bqIdx >= 0) {
        for (const c of stack) c.lastLineBlank = true;
        closeTo(bqIdx);
        prevLazy = false; prevMatched = true;
        continue;
      }
      endEmptyItem();
      // A blank line is content inside an HTML block of types 1-5
      // (it does not end the block and does not loosen a list).
      if (leaf && leaf.type === 'html' && leaf.htmlType >= 1 && leaf.htmlType <= 5) {
        leaf.lines.push(blankLineContent(line));
        leaf.lastLineIdx = li;
        prevLazy = false; prevMatched = true;
        continue;
      }
      // A blank line is content inside a code block (it does not loosen
      // a list either).
      if (leaf && leaf.type === 'code') {
        appendCodeBlank(blankLineContent(line), li);
        prevLazy = false; prevMatched = true;
        continue;
      }
      // A whitespace-only line that contains a tab is a table row in
      // marked (its table-row regex only excludes lines matching
      // ` *\n`): the row is all empty cells.
      if (leaf && leaf.type === 'table' && line.includes('\t')) {
        leaf.rows.push(splitTableCells(line, leaf.headerCells.length));
        prevLazy = false; prevMatched = true;
        continue;
      }
      if (leaf) leaf.lastLineBlank = true;
      for (const c of stack) c.lastLineBlank = true;
      closeLeaf();
      prevLazy = false; prevMatched = true;
      continue;
    }

    // ---- Phase A: walk containers ----
    let w = walkContainers(line);
    let content = w.content;
    let matchedAll = w.failedAt === -1;

    // A line that is blank after its containers were stripped (e.g. a
    // lone `>` line) is a blank line in the container's stream: it ends
    // the leaf, but not the containers. Inside a code block it is an
    // empty content line.
    if (matchedAll && /^[ \t]*$/.test(content)) {
      // A blank line is content inside an HTML block of types 1-5.
      if (leaf && leaf.type === 'html' && leaf.htmlType >= 1 && leaf.htmlType <= 5) {
        leaf.lines.push(content);
        leaf.lastLineIdx = li;
        prevLazy = false; prevMatched = true;
        continue;
      }
      if (leaf && leaf.type === 'code') {
        appendCodeBlank(content, li);
        prevLazy = false; prevMatched = true;
        continue;
      }
      // A whitespace-only line that contains a tab is a table row in
      // marked (its table-row regex only excludes lines matching
      // ` *\n`): the row is all empty cells.
      if (leaf && leaf.type === 'table' && content.includes('\t')) {
        leaf.rows.push(splitTableCells(content, leaf.headerCells.length));
        prevLazy = false; prevMatched = true;
        continue;
      }
      // A whitespace-only line that is the last line of the input
      // continues a paragraph (marked's paragraph regex only excludes
      // such a line when a newline follows it).
      if (leaf && leaf.type === 'paragraph' && content !== '') {
        let last = true;
        for (let j = li + 1; j < lines.length; j++) if (lines[j] !== '') { last = false; break; }
        if (last) {
          leaf.lines.push({ t: content, m: true });
          prevLazy = false; prevMatched = true;
          continue;
        }
      }
      endEmptyItem();
      closeLeaf();
      // The blank line belongs to the innermost container that
      // consumed characters from it; only that container and the ones
      // below it are loosened (a blank line inside a blockquote does
      // not loosen a list above the blockquote).
      for (let k = Math.max(0, w.consumedAt); k < stack.length; k++) stack[k].lastLineBlank = true;
      prevLazy = false; prevMatched = true;
      continue;
    }

    if (!matchedAll) {
      // ---- lazy continuation? ----
      const failed = stack[w.failedAt];
      const lazyContent = content;
      let handled = false;
      if (leaf && leaf.type === 'code' && leaf.fenced && failed && failed.type === 'item' && isLazyLine(lazyContent) && !itemEndsOnLazyLine(leaf.lastAppendBlank, leaf.lastItemLine || '', failed.contentIndent)) {
        // A fenced code block inside a list item takes lazy lines as
        // content (marked's list tokenizer adds them unstripped to the
        // item's text). This does NOT apply inside a blockquote (its
        // lines must carry the `>` marker), and a fence line itself is
        // never lazy content (it ends the item's text instead). It also
        // does not apply when the item's previous line was blank, or
        // its last line is indented code or begins a fence / heading /
        // HTML block / hr: then the item ends here and the fence is
        // left unclosed (marked re-lexes the item's text, so the
        // opener alone becomes an empty code block and a later
        // fence line opens a new block at the outer level).
        let add = lazyContent;
        if (leaf.fenceChar === '`') add = lazyContent.slice(Math.min(leaf.indentStr.length, (lazyContent.match(/^\s*/) || [''])[0].length));
        leaf.text += add + (li < lines.length - 1 ? '\n' : '');
        leaf.lastAppendBlank = /^[ \t]*$/.test(add);
        leaf.lastItemLine = sliceR(lazyContent, failed.contentIndent);
        prevLazy = false; prevMatched = false;
        handled = true;
      }
      if (leaf && leaf.type === 'paragraph' && lazyContent.trim() !== '' && isLazyLine(lazyContent)) {
        // A lazy line stays inside the containers. (An empty lazy
        // line, e.g. a lone `>` after an inner blockquote failed, is
        // a blank line in the outer container's stream: it ends the
        // paragraph instead of appending an empty line to it.)
        const item = curItem();
        if (item) {
          // marked's list tokenizer ends the item (instead of taking a
          // lazy line) when the previous line was blank, or the item's
          // last line is indented code or begins a fence / heading /
          // HTML block / hr. A paragraph's last line can be indented
          // code, so check it here — using the line as appended to
          // the item text (orig, before any 4-column strip).
          const lastLine = leaf.lines.length ? (leaf.lines[leaf.lines.length - 1].orig ?? leaf.lines[leaf.lines.length - 1].t) : '';
          if (itemEndsOnLazyLine(false, lastLine, item.contentIndent)) {
            handled = false;
          } else {
          // list rule: expand leading WS base 0, strip R if indent >= R
          const ex = expandLead(lazyContent, 0);
          let add;
          const setext = parseSetext(lazyContent);
          if (setext && canBeSetextText(leaf.lines.map((x) => x.t).join('\n'))) {
            // setext special case: the line is re-lexed as indented code
            add = lazyContent.replace(/^ {0,3}/, '');
          } else if (ex.cols >= item.contentIndent) {
            add = ex.text.slice(item.contentIndent);
          } else if (ex.cols >= 4) {
            // code-like lazy line: indented code merged into the text
            // (marked strips 4 columns here)
            add = stripCols(lazyContent, 4);
          } else {
            add = lazyContent;
          }
          // table check on the lazy line + next line
          const nxt = li + 1 < lines.length ? lineContentAt(li + 1) : null;
          if (nxt && tryTableStart(add, nxt.content)) {
            // the table's header is the lazy line; the paragraph ends here
            closeLeaf();
            const tab = { type: 'table', headerCells: splitTableCells(add), aligns: parseTableDelimiter(nxt.content), rows: [], lastLineBlank: false };
            addBlock(tab);
            leaf = tab;
            li++; // consume the delimiter line
            prevLazy = false; prevMatched = nxt.matched;
            continue;
          }
          leaf.lines.push({ t: add, m: false, orig: sliceR(lazyContent, item.contentIndent) });
          prevLazy = true; prevMatched = false;
          handled = true;
          }
        } else {
          // paragraph directly in a blockquote (or root, impossible here)
          const setext = parseSetext(lazyContent);
          const nxt = li + 1 < lines.length ? lineContentAt(li + 1) : null;
          // table check first
          if (nxt && tryTableStart(lazyContent, nxt.content)) {
            // the table's header is the lazy line; the paragraph ends here
            closeLeaf();
            const tab = { type: 'table', headerCells: splitTableCells(lazyContent), aligns: parseTableDelimiter(nxt.content), rows: [], lastLineBlank: false };
            addBlock(tab);
            leaf = tab;
            li++;
            prevLazy = false; prevMatched = nxt.matched;
            handled = true;
          } else if (!prevLazy && colsOf(lazyContent) >= 4) {
            // code-like lazy line: indent stripped, trailing '\n' unless
            // it is the last line of the input
            let add = stripCols(lazyContent, 4);
            if (li + 1 < lines.length && !/^[ \t]*$/.test(lines[li + 1])) add += '\n';
            leaf.lines.push({ t: add, m: false });
            prevLazy = true; prevMatched = false;
            handled = true;
          } else {
            // plain lazy line; a non-first setext line is indented 4
            let add = lazyContent;
            if (prevLazy && setext) add = '    ' + lazyContent.replace(/^ {0,3}/, '');
            leaf.lines.push({ t: add, m: false });
            prevLazy = true; prevMatched = false;
            handled = true;
          }
        }
      } else if (leaf && leaf.type === 'table') {
        // a lazy line is NOT a table row; the table ends, the line starts
        // a new block inside the containers
        closeLeaf();
        // fall through to Phase B with the containers still open
        handled = false;
      } else if (leaf && leaf.type === 'paragraph') {
        // not a lazy line (starts a block that interrupts): close containers
        handled = false;
      } else if (!leaf && failed && failed.type === 'item' && lazyContent.trim() !== '' && isLazyLine(lazyContent)) {
        // A lazy line after a block that is not a paragraph or fenced
        // code (e.g. after an HTML <pre> block, whose closing tag does
        // not begin an HTML block): marked's list tokenizer keeps it
        // in the item unless the item's last line ends the item, so it
        // starts a new paragraph inside the item.
        if (!itemEndsOnLazyLine(failed.lastLineBlank, itemLastLine(failed), failed.contentIndent)) {
          // close containers above the item (e.g. a blockquote inside
          // it); the paragraph belongs to the item, after them
          // (closeTo pops the container at the given index too, so
          // pass one past the item to keep it open)
          closeTo(stack.indexOf(failed) + 1);
          openParagraph(lazyContent, false);
          leaf.lines[0].orig = sliceR(lazyContent, failed.contentIndent);
          prevLazy = true; prevMatched = false;
          handled = true;
        }
      }
      if (handled) continue;
      // Not a lazy continuation. The line may open a new item of an
      // enclosing list, or it may end containers. Loop until the line
      // matches all remaining containers.
      let lineDone = false;
      while (!matchedAll && !lineDone) {
        const fidx = w.failedAt;
        const fcont = stack[fidx];
        // new item of the enclosing list?
        if (fcont && fcont.type === 'item') {
          const lst = stack[fidx - 1];
          const lm = parseListMarker(content);
          if (lst && lst.type === 'list' && lm && !isThematicBreak(content) && lm.type === (lst.ordered ? 'ordered' : 'bullet') &&
              (lst.ordered ? lm.marker.endsWith('.') === lst.delimDot : lm.marker === lst.marker)) {
            const mind = (() => { let i = 0; while (i < 3 && content[i] === ' ') i++; return i; })();
            if (mind < fcont.contentIndent) {
              trimLeafForItemEnd();
              closeLeaf();
              // pop the failed item and everything above it (a new item
              // ends the old item's nested content too)
              while (stack.length > fidx) stack.pop();
              const ni = { type: 'item', contentIndent: lm.contentIndent, children: [], lastLineBlank: false, blankFirst: lm.rest.trim() === '' };
              lst.items.push(ni);
              stack.push(ni);
              if (lm.rest.trim() === '') { lineDone = true; prevLazy = false; prevMatched = true; break; }
              content = lm.rest;
              matchedAll = true;
              prevLazy = false;
              break; // fall through to Phase B with the new item's content
            }
          }
        }
        // otherwise close the failed container and re-walk
        closeTo(fidx);
        w = walkContainers(line);
        content = w.content;
        matchedAll = w.failedAt === -1;
      }
      if (lineDone) continue;
      // After closing containers and re-walking, the line may be blank
      // inside the remaining containers (e.g. a lone `>` after an inner
      // blockquote was popped): it is a blank line, not an empty
      // paragraph.
      if (matchedAll && /^[ \t]*$/.test(content)) {
        endEmptyItem();
        closeLeaf();
        for (let k = Math.max(0, w.consumedAt); k < stack.length; k++) stack[k].lastLineBlank = true;
        prevLazy = false; prevMatched = true;
        continue;
      }
      prevLazy = false;
    }

    // ---- Phase B: new block detection (all containers matched) ----
    let cur2 = content;

    // Leaf continuation takes precedence over new blocks: a fenced code
    // block consumes the line (a matching fence line closes it), an
    // indented code block consumes indented lines, an html block consumes
    // lines until its terminator (types 1-5) or a blank line (type 6).
    if (leaf && leaf.type === 'code' && leaf.fenced) {
      const f = parseFence(cur2);
      // a closing fence has no info string
      if (f && f.char === leaf.fenceChar && f.len >= leaf.fenceLen && f.info === '') {
        leaf.closed = true;
        // the newline just before the closing fence is the separator,
        // not content: drop one trailing newline when the last content
        // line was blank
        if (leaf.lastAppendBlank && leaf.text.endsWith('\n')) leaf.text = leaf.text.slice(0, -1);
        closeLeaf();
      } else {
        let add = cur2;
        if (leaf.fenceChar === '`') add = cur2.slice(Math.min(leaf.indentStr.length, (cur2.match(/^\s*/) || [''])[0].length));
        leaf.text += add + (li < lines.length - 1 ? '\n' : '');
        leaf.lastAppendBlank = /^[ \t]*$/.test(add);
        leaf.lastItemLine = cur2;
      }
      prevLazy = false; prevMatched = true;
      continue;
    }
    if (leaf && leaf.type === 'code' && !leaf.fenced && colsOf(cur2) >= 4) {
      leaf.text += stripCols(cur2, 4) + (li < lines.length - 1 ? '\n' : '');
      prevLazy = false; prevMatched = true;
      continue;
    }
    if (leaf && leaf.type === 'html') {
      leaf.lines.push(cur2);
      leaf.lastLineIdx = li;
      if (htmlEndsHere(leaf, cur2)) closeLeaf();
      prevLazy = false; prevMatched = true;
      continue;
    }

    // blockquote start (can interrupt a paragraph; may nest)
    let bq;
    let openedBq = false;
    while ((bq = matchBlockquote(cur2)) !== null) {
      closeLeaf();
      const b = { type: 'blockquote', children: [], lastLineBlank: false };
      addBlock(b);
      stack.push(b);
      cur2 = bq;
      openedBq = true;
    }
    // A line that is blank after its blockquote markers is a blank line
    // in the blockquote's stream: no paragraph is opened.
    if (openedBq && /^[ \t]*$/.test(cur2)) {
      closeLeaf();
      if (stack.length) stack[stack.length - 1].lastLineBlank = true;
      prevLazy = false; prevMatched = true;
      continue;
    }

    // fenced code: close current leaf first (a fence interrupts a paragraph)
    const fence = parseFence(cur2);
    if (fence) {
      closeLeaf();
      openFence(cur2, li);
      prevLazy = false; prevMatched = true;
      continue;
    }
    // ATX heading
    const atx = parseAtxHeading(cur2);
    if (atx) {
      closeLeaf();
      addBlock({ type: 'heading', level: atx.level, text: atx.text, lastLine: cur2, lastLineBlank: false });
      prevLazy = false; prevMatched = true;
      continue;
    }
    // setext heading (a --- line after a paragraph is a heading, not hr)
    if (leaf && leaf.type === 'paragraph') {
      const se = parseSetext(cur2);
      if (se && canBeSetextText(leaf.lines.map((x) => x.t).join('\n'))) {
        const txt = leaf.lines.map((x) => x.t).join('\n').trim();
        holder().children.pop();
        closeLeaf();
        addBlock({ type: 'heading', level: se, text: txt, lastLine: cur2, lastLineBlank: false });
        prevLazy = false; prevMatched = true;
        continue;
      }
    }
    // thematic break
    if (isThematicBreak(cur2)) {
      closeLeaf();
      addBlock({ type: 'hr', lastLine: cur2, lastLineBlank: false });
      prevLazy = false; prevMatched = true;
      continue;
    }
    // HTML block (types 1-5 and 7 can end on their opening line; type 7
    // cannot interrupt a paragraph, and unlike CommonMark it continues
    // until a blank line once open)
    const hinfo = htmlOpenInfo(cur2);
    if (hinfo && (hinfo.htmlType !== 7 || !leaf || leaf.type !== 'paragraph')) {
      if (hinfo.htmlType !== 7 && htmlEndsHere(hinfo, cur2)) {
        closeLeaf();
        addBlock({ type: 'html', text: htmlTrailingNL(li, hinfo.htmlType) ? cur2 + '\n' : cur2, lastLineBlank: false });
      } else {
        closeLeaf();
        const b = { type: 'html', htmlType: hinfo.htmlType, endRe: hinfo.endRe, lines: [cur2], lastLineIdx: li, lastLineBlank: false };
        addBlock(b);
        leaf = b;
      }
      prevLazy = false; prevMatched = true;
      continue;
    }
    // list start (a list interrupts a paragraph only for bullets or
    // 1./1) with non-empty content — except inside a list item, where
    // marked's list tokenizer ends the item's text at ANY list marker)
    const lm2 = parseListMarker(cur2);
    if (lm2) {
      const inItem = holder().type === 'item';
      const canInterrupt = !leaf || leaf.type !== 'paragraph' ||
        (inItem ? lm2.rest.trim() !== '' : ((lm2.type === 'bullet' || lm2.start === 1) && lm2.rest.trim() !== ''));
      if (canInterrupt) {
      closeLeaf();
      const ordered = lm2.type === 'ordered';
      // A marker matching the list on top of the stack continues that
      // list (a blank line after an empty item does not end it).
      let lst = null;
      const top = stack[stack.length - 1];
      if (top && top.type === 'list' && top.ordered === ordered &&
          (ordered ? top.delimDot === lm2.marker.endsWith('.') : top.marker === lm2.marker)) {
        lst = top;
      } else {
        lst = { type: 'list', ordered, start: ordered ? lm2.start : '', marker: ordered ? null : lm2.marker, delimDot: ordered ? lm2.marker.endsWith('.') : null, items: [], loose: false, lastLineBlank: false };
        addBlock(lst);
        stack.push(lst);
      }
      const ni = { type: 'item', contentIndent: lm2.contentIndent, children: [], lastLineBlank: false, blankFirst: lm2.rest.trim() === '' };
      lst.items.push(ni);
      stack.push(ni);
      if (lm2.rest.trim() !== '') {
        // process the item's first line content (it may itself be a list,
        // fence, heading, table, ...). Loop for nested lists.
        let cur3 = lm2.rest;
        let guard = 0;
        while (guard++ < 20) {
          // a line that is blank after its blockquote markers opens no
          // paragraph inside the blockquote
          if (/^[ \t]*$/.test(cur3)) break;
          const bq3 = matchBlockquote(cur3);
          if (bq3 !== null) {
            const b = { type: 'blockquote', children: [], lastLineBlank: false };
            addBlock(b);
            stack.push(b);
            cur3 = bq3;
            continue;
          }
          const fence3 = parseFence(cur3);
          if (fence3) { openFence(cur3, li); break; }
          const atx3 = parseAtxHeading(cur3);
          if (atx3) { addBlock({ type: 'heading', level: atx3.level, text: atx3.text, lastLine: cur3, lastLineBlank: false }); break; }
          if (isThematicBreak(cur3)) { addBlock({ type: 'hr', lastLine: cur3, lastLineBlank: false }); break; }
          const htype3 = htmlBlockType(cur3);
          if (htype3 > 0) { const b = { type: 'html', htmlType: htype3, lines: [cur3], lastLineIdx: li, lastLineBlank: false }; addBlock(b); leaf = b; break; }
          const lm3 = parseListMarker(cur3);
          if (lm3) {
            const ordered3 = lm3.type === 'ordered';
            const lst3 = { type: 'list', ordered: ordered3, start: ordered3 ? lm3.start : '', marker: ordered3 ? null : lm3.marker, delimDot: ordered3 ? lm3.marker.endsWith('.') : null, items: [], loose: false, lastLineBlank: false };
            addBlock(lst3);
            stack.push(lst3);
            const ni3 = { type: 'item', contentIndent: lm3.contentIndent, children: [], lastLineBlank: false, blankFirst: lm3.rest.trim() === '' };
            lst3.items.push(ni3);
            stack.push(ni3);
            if (lm3.rest.trim() === '') break;
            cur3 = lm3.rest;
            continue;
          }
          const nxt3 = li + 1 < lines.length ? lineContentAt(li + 1) : null;
          if (nxt3 && nxt3.matched && tryTableStart(cur3, nxt3.content)) {
            const tab = { type: 'table', headerCells: splitTableCells(cur3), aligns: parseTableDelimiter(nxt3.content), rows: [], lastLineBlank: false };
            addBlock(tab); leaf = tab; li++; prevMatched = nxt3.matched; break;
          }
          if (colsOf(cur3) >= 4) {
            const b = { type: 'code', fenced: false, text: stripCols(cur3, 4) + (li < lines.length - 1 ? '\n' : ''), lastLineBlank: false };
            addBlock(b); leaf = b; break;
          }
          openParagraph(cur3, true);
          break;
        }
        prevLazy = false; prevMatched = true;
        continue;
      }
      prevLazy = false; prevMatched = true;
      continue;
      }
    }
    // link reference definition (only when no paragraph leaf is open;
    // a code/html leaf the line does not continue has already ended)
    if (leaf && (leaf.type === 'code' || leaf.type === 'html') && /^ {0,3}\[/.test(cur2)) closeLeaf();
    if (!leaf && /^ {0,3}\[/.test(cur2)) {
      // build the remaining text (container-stripped) for the def parser
      let rem = cur2;
      for (let k = li + 1; k < lines.length; k++) {
        const wc = lineContentAt(k);
        if (wc.content === null) break;
        // stop at a line that does not match the containers
        if (!wc.matched) break;
        rem += '\n' + wc.content;
      }
      const d = parseLinkDef(rem, refs);
      if (d) {
        // how many lines does the def span?
        const defText = rem.slice(0, d.end);
        const nlines = defText.split('\n').length;
        li += nlines - 1;
        prevLazy = false; prevMatched = true;
        continue;
      }
    }
    // table whose header is the paragraph's last line (marked tries the
    // table at the paragraph's start, so a paragraph line followed by a
    // delimiter row becomes the table's header)
    if (leaf && leaf.type === 'paragraph' && leaf.lines.length) {
      const lastLine = leaf.lines[leaf.lines.length - 1].t;
      const tab0 = tryTableStart(lastLine, cur2);
      if (tab0) {
        leaf.lines.pop();
        if (leaf.lines.length === 0) {
          holder().children.pop();
          leaf = null;
        } else {
          closeLeaf();
        }
        const tab = { type: 'table', headerCells: tab0.headerCells, aligns: tab0.aligns, rows: [], lastLineBlank: false };
        addBlock(tab);
        leaf = tab;
        prevLazy = false; prevMatched = true;
        continue;
      }
    }
    // table start (current line + next line, same chunk: the delimiter
    // line must also match all containers)
    const nxt = li + 1 < lines.length ? lineContentAt(li + 1) : null;
    if (nxt && nxt.matched && colsOf(cur2) < 4 && tryTableStart(cur2, nxt.content)) {
      closeLeaf();
      const tab = { type: 'table', headerCells: splitTableCells(cur2), aligns: parseTableDelimiter(nxt.content), rows: [], lastLineBlank: false };
      addBlock(tab);
      leaf = tab;
      li++;
      prevLazy = false; prevMatched = nxt.matched;
      continue;
    }
    // indented code
    if (colsOf(cur2) >= 4 && !(leaf && leaf.type === 'paragraph')) {
      closeLeaf();
      const b = { type: 'code', fenced: false, text: stripCols(cur2, 4) + (li < lines.length - 1 ? '\n' : ''), lastLineBlank: false };
      addBlock(b);
      leaf = b;
      prevLazy = false; prevMatched = true;
      continue;
    }
    // paragraph continuation or new paragraph
    if (leaf && leaf.type === 'paragraph') {
      // inside a list item, marked re-lexes the item text with
      // top=false, so a continuation line indented >= 4 columns is an
      // indented-code token merged into the text token with 4 columns
      // stripped (codeRemoveIndent); at root / in a blockquote the
      // paragraph regex matches it as-is, spaces kept.
      const t = holder().type === 'item' && colsOf(cur2) >= 4 ? stripCols(cur2, 4) : cur2;
      leaf.lines.push({ t, m: true, orig: cur2 });
      prevLazy = false; prevMatched = true;
      continue;
    }
    // table row continuation
    if (leaf && leaf.type === 'table') {
      leaf.rows.push(splitTableCells(cur2, leaf.headerCells.length));
      prevLazy = false; prevMatched = true;
      continue;
    }
    openParagraph(cur2, true);
    prevLazy = false; prevMatched = true;
  }


  if (stack.some((c) => c.type === 'item')) trimLeafForItemEnd();
  closeLeaf();
  // finalize lists: compute loose flags already set during parsing
  return root;
}

// ---------------- inline parser ----------------

// Parse a link destination starting at `s[i]`. Returns {dest, end} (end
// just past the destination) or null. Handles <...> and bare destinations.
function parseLinkDest(s, i) {
  if (s[i] === '<') {
    let j = i + 1, d = '';
    while (j < s.length && s[j] !== '\n' && s[j] !== '>') {
      if (s[j] === '\\' && j + 1 < s.length && PUNCT.has(s[j + 1])) { d += s[j + 1]; j += 2; }
      else if (s[j] === '<') return null;
      else { d += s[j]; j++; }
    }
    if (s[j] !== '>') return null;
    return { dest: d, end: j + 1 };
  }
  let j = i, depth = 0, d = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && PUNCT.has(s[j + 1])) { d += s[j + 1]; j += 2; }
    else if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
    else if (c === '(') { depth++; d += c; j++; }
    else if (c === ')') { if (depth === 0) break; depth--; d += c; j++; }
    else { d += c; j++; }
  }
  if (d.length === 0 || depth !== 0) return null;
  return { dest: d, end: j };
}

// Parse a link title starting at `s[i]` ("...", '...', or (...)).
// Returns {title, end} or null.
function parseLinkTitle(s, i) {
  const open = s[i];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let j = i + 1, t = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && PUNCT.has(s[j + 1])) { t += s[j + 1]; j += 2; }
    else if (c === close) return { title: t, end: j + 1 };
    else if (c === '\n' && open === "'") {
      // a newline in a '...' title must not be followed by a blank line
      let q = j + 1;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
      if (s[q] === '\n' || q >= s.length) return null;
      t += c; j++;
    }
    else if (open === '(' && c === '(') return null;
    else { t += c; j++; }
  }
  return null;
}

// Skip spaces/tabs/newlines starting at `i`. Returns the new index.
function skipInlineWS(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

// Parse an inline link's (dest "title") starting at `s[i] === '('`.
// Returns {dest, title, end} (end just past ')') or null.
function parseInlineLink(s, i) {
  if (s[i] !== '(') return null;
  let j = skipInlineWS(s, i + 1);
  let dest = '', title = null;
  if (s[j] === ')') return { dest: '', title: null, end: j + 1 };
  const d = parseLinkDest(s, j);
  if (!d) return null;
  dest = d.dest;
  j = d.end;
  let k = skipInlineWS(s, j);
  if (s[k] === ')') return { dest, title: null, end: k + 1 };
  // a title is only allowed if there was whitespace before it
  if (k === j) return null;
  const t = parseLinkTitle(s, k);
  if (!t) return null;
  title = t.title;
  k = skipInlineWS(s, t.end);
  if (s[k] !== ')') return null;
  return { dest, title, end: k + 1 };
}

// Try to parse a code span starting at `s[i]` (a backtick run).
// Returns {text, end} (end just past the closing run) or null.
// Marked's regex is /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/: the opener
// backtracks from the longest run, the content must not start or end
// with a backtick, and the closer is the earliest run of the same
// length that gives valid content.
function parseCodeSpan(s, i) {
  let j = i;
  while (j < s.length && s[j] === '`') j++;
  const n = j - i;
  for (let m = n; m >= 1; m--) {
    let k = i + m;
    while (k < s.length) {
      const c = s.indexOf('`', k);
      if (c < 0) break;
      let mm = c;
      while (mm < s.length && s[mm] === '`') mm++;
      if (mm - c === m) {
        const raw = s.slice(i + m, c);
        if (raw.length === 0) { k = mm; continue; }
        if (raw[0] === '`') break; // a later closer cannot fix this
        if (raw[raw.length - 1] === '`') { k = mm; continue; }
        let text = raw.replace(/\n/g, ' ');
        if (text.length >= 2 && text[0] === ' ' && text[text.length - 1] === ' ' && text.trim() !== '') {
          text = text.slice(1, -1);
        }
        return { text, end: mm };
      }
      k = mm;
    }
  }
  return null;
}

const AUTOLINK_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^ \t\n<>]*$/;
const EMAIL_CHAR_RE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
function isEmailChar(c) { return c !== undefined && EMAIL_CHAR_RE.test(c); }
const AUTOLINK_EMAIL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// Try an autolink <...> starting at `s[i] === '<'`. Returns
// {href, text, isEmail, end} or null.
function parseAutolink(s, i) {
  const gt = s.indexOf('>', i + 1);
  if (gt < 0) return null;
  const inner = s.slice(i + 1, gt);
  if (inner.length === 0 || /[\s<>]/.test(inner)) return null;
  if (AUTOLINK_SCHEME.test(inner)) return { href: inner, text: inner, isEmail: false, end: gt + 1 };
  if (inner.indexOf('@') > 0 && AUTOLINK_EMAIL.test(inner)) return { href: 'mailto:' + inner, text: inner, isEmail: true, end: gt + 1 };
  return null;
}

// GFM extended autolink (marked's `url` rule + `_backpedal`).
const EXT_EMAIL = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXT_URL_RE = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))/;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

function parseExtAutolink(s, i) {
  const m = EXT_URL_RE.exec(s.slice(i));
  if (!m) return null;
  // preceding-character rules (marked's text rule): a bare email must
  // not follow an email character; www. must follow whitespace, *,
  // _, ~ or ( (or start); a scheme may follow anything; mailto:/xmpp:
  // must not follow an alphanumeric
  if (i > 0) {
    const prev = s[i - 1];
    if (m[2] === '@') {
      if (/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(prev)) return null;
    } else if (m[1] === 'www.') {
      if (!/[\s*_~(]/.test(prev)) return null;
    } else if (!m[1]) {
      if (/[A-Za-z0-9]/.test(prev)) return null;
    }
  }
  let t = m[0];
  let href;
  if (m[2] === '@') {
    href = 'mailto:' + t;
  } else {
    let r;
    do { r = t; t = (BACKPEDAL_RE.exec(t) || [''])[0]; } while (r !== t);
    if (!t) return null;
    href = m[1] === 'www.' ? 'http://' + t : t;
  }
  return { href, text: t, end: i + t.length };
}



// Parse an inline HTML tag starting at `s[i] === '<'`.
// Returns the tag string or null. Mirrors marked's inline `tag` rule:
// a comment is <!--(-?>|...-->), a closing tag carries no attributes.
function parseHtmlTag(s, i) {
  const m = /^(?:<!--(?:-?>|[\s\S]*?-->)|<\/[A-Za-z][A-Za-z0-9-]*\s*>|<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\?[\s\S]*?\?>|<![A-Za-z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>)/.exec(s.slice(i));
  return m ? m[0] : null;
}

// Find the index of the ']' matching the '[' at `openIdx` (balanced
// brackets, backslash escapes, code spans; no blank line inside).
// Returns -1 when there is none.
// marked 18.1.3's link-label regex (Lexer.rules.inline label `re`,
// GFM): a backtick run inside a label must either open a code span
// (closer = the first later backtick run, any length) or be a run of
// 2+ backticks immediately before the closing ']'. Anchored here for a
// whole-label validity test (label text + its closing ']').
const LINK_LABEL_RE = /^(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?\]$/;

function findLinkTextEnd(s, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
    if (c === '`') {
      // A backtick run inside a label opens a code span whose closer is
      // the FIRST later backtick run (any length -- marked's label regex
      // allows unequal opener/closer runs). Skip to just past it; if a
      // ']' comes before any later run, the run cannot be a code span
      // (its closer would lie outside the label), so it is literal text.
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      const b = s.indexOf('`', j);
      const r = s.indexOf(']', j);
      if (b < 0 || (r >= 0 && r < b)) { i = j; continue; }
      let m = b;
      while (m < s.length && s[m] === '`') m++;
      i = m;
      continue;
    }
    if (c === '\n') {
      let j = i + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
      if (s[j] === '\n' || j >= s.length) return -1;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        // The label must match marked's label regex exactly; an invalid
        // label (e.g. a stray backtick run) means no link starts here.
        // Test the label text plus its closing ']' (the regex expects
        // the label content, not the opening '[').
        if (!LINK_LABEL_RE.test(s.slice(openIdx + 1, i + 1))) return -1;
        return i;
      }
    }
    i++;
  }
  return -1;
}

// Try to match a link starting at the '[' at `openIdx` in `s`.
// Returns {text, dest, title, end} or null. `refs` maps normalized labels
// to {dest, title}.
// Marked's Be(): a link whose text contains a `<` that starts an HTML
// tag or autolink which is not fully contained in the link text is
// invalid (the tag/autolink is parsed instead). `end` is the index just
// past the link text's closing `]` in `s`; the text starts at openIdx+1.
function linkTextHasUnclosedTag(s, openIdx, end) {
  const text = s.slice(openIdx + 1, end);
  if (!text.includes('<')) return false;
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '\\') { k++; continue; }
    if (text[k] === '`') {
      const cs = parseCodeSpan(text, k);
      if (cs) { k = cs.end - 1; continue; }
    }
    if (text[k] !== '<') continue;
    const r = s.slice(openIdx + 1 + k);
    const tag = parseHtmlTag(r);
    const al = tag ? null : parseAutolink(r, 0);
    const len = tag ? tag.length : (al ? al.end : 0);
    if (len > 0) {
      if (len > text.length - k) return true;
      k += len - 1;
    }
  }
  return false;
}

function tryMatchLink(s, openIdx, refs) {
  const end = findLinkTextEnd(s, openIdx);
  if (end < 0) return null;
  const text = s.slice(openIdx + 1, end);
  if (linkTextHasUnclosedTag(s, openIdx, end)) return null;
  const j = end + 1;
  if (s[j] === '(') {
    const il = parseInlineLink(s, j);
    if (il) return { text, dest: il.dest, title: il.title, end: il.end };
    // fall through to the shortcut link
  } else if (s[j] === '[') {
    const lend = findLinkTextEnd(s, j);
    if (lend < 0) return null;
    const label = s.slice(j + 1, lend);
    const key = label.length === 0 ? normalizeLabel(text) : normalizeLabel(label);
    const ref = refs.get(key);
    if (!ref) return null;
    return { text, dest: ref.dest, title: ref.title, end: lend + 1 };
  }
  const ref = refs.get(normalizeLabel(text));
  if (!ref) return null;
  return { text, dest: ref.dest, title: ref.title, end: end + 1 };
}

// Does the node list contain a link formed from '[' (not an autolink)?
function containsBracketLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link' && nd.kind === 'bracket') return true;
    if (nd.c && containsBracketLink(nd.c)) return true;
  }
  return false;
}

// Plain-text rendering of inline nodes (for image alt text).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text' || nd.t === 'code' || nd.t === 'html') out += nd.s;
    else if (nd.t === 'br') out += '\n';
    else if (nd.c) out += plainText(nd.c);
    else if (nd.t === 'image') out += nd.alt || '';
    else if (nd.t === 'link' && nd.text) out += nd.text;
  }
  return out;
}

// Try to decode a numeric character reference at `s[i] === '&'`.
// Returns {ch, end} (ch is the decoded character, or the raw string
// '&amp;' for code point 38, which marked emits literally) or null.
// Only up to 7 decimal digits / 6 hex digits count (marked's
// numericCharacterReference); longer ones stay literal.
function tryDecodeEntity(s, i) {
  if (s[i] !== '&' || s[i + 1] !== '#') return null;
  let j = i + 2, code = -1;
  if (s[j] === 'x' || s[j] === 'X') {
    j++;
    const start = j;
    while (j < s.length && /[0-9a-fA-F]/.test(s[j]) && j - start < 6) j++;
    if (j > start && j - start <= 6 && s[j] === ';') code = parseInt(s.slice(start, j), 16);
  } else {
    const start = j;
    while (j < s.length && s[j] >= '0' && s[j] <= '9' && j - start < 7) j++;
    if (j > start && j - start <= 7 && s[j] === ';') code = parseInt(s.slice(start, j), 10);
  }
  if (code < 0) return null;
  if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) code = 0xFFFD;
  if (code === 38) return { ch: '&amp;', raw: true, end: j + 1 };
  return { ch: String.fromCodePoint(code), end: j + 1 };
}

// ---- marked's emStrong tokenizer (GFM rules), ported verbatim ----
// Regexes copied exactly from marked 18.1.3's runtime rules
// (Lexer.rules.inline.gfm): emStrongLDelim, emStrongRDelimAst,
// emStrongRDelimUnd.
const EM_STRONG_L_DELIM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const EM_STRONG_R_DELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const EM_STRONG_R_DELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const EM_STRONG_PUNCT_RE = /^((?![*_])[\s\p{P}\p{S}])/u;
const EM_STRONG_ALPHA_NUM_RE = /[\p{L}\p{N}]/u;

// marked's fe(): the last possible closer index for '*', '_' and '~'
// in the source (a run counts only when the character before it is not
// whitespace).
function lastPossibleEmStrongCloser(src) {
  const e = { '*': -1, _: -1, '~': -1 };
  const n = src.length;
  for (let s = 0; s < n; s++) {
    const r = src[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : src[s - 1];
    let i = s + 1;
    while (i < n && src[i] === r) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') e[r] = s;
    s = i - 1;
  }
  return e;
}

// Does `text` contain a `[` or `]` outside a code span? marked's
// blockSkip link pattern only allows brackets inside code spans, so a
// link whose text has one is not maskable (its inner delimiters stay
// visible to the emStrong closer search).
function linkTextHasBracketOutsideCode(text) {
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      const cs = parseCodeSpan(text, i);
      if (cs) { i = cs.end; continue; }
    }
    if (text[i] === '[' || text[i] === ']') return true;
    i++;
  }
  return false;
}

// marked's emStrong masking (#n + blockSkip): a same-length copy of the
// inline source in which code spans, links, autolinks and HTML tags are
// replaced by [aaa...] and escaped punctuation by '+' — so delimiters
// inside those constructs are invisible to the emStrong closer search.
// A link is only maskable when its text has no brackets outside a code
// span (marked's blockSkip link pattern); otherwise only the inner
// constructs are masked as the scan reaches them.
// marked 18.1.3's inline mask (Lexer#n), ported verbatim: the masked
// source hides code spans, links, autolinks and HTML from the emStrong
// / del closer search, so a delimiter inside one of those can never act
// as a closer for an opener outside it. The two regex replaces are the
// whole mask (plus the reflinkSearch pass when refs exist):
//  - anyPunctuationOutsideCode: replaces backticks inside a code span
//    with '+' (so a code span whose content holds a backtick becomes
//    backtick-free and the link pattern below can see it as one span);
//  - blockSkip: replaces a link-like span, a code span, or an HTML-ish
//    <...> span with '[aaa...]' of the same length.
const MASK_ANY_PUNCT = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const _MASK_LE = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const _MASK_LT = '(?:[^\\[\\]\\\\`]*(?:\\[(?:' + _MASK_LE + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const _MASK_BE = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const MASK_REFLINK_SEARCH = new RegExp('!?\\[(' + _MASK_LT + ')\\]\\[(' + _MASK_BE + ')\\]|!?\\[(' + _MASK_BE + ')\\](?:\\[\\])?(?!\\()', 'g');

// marked's linkInText (Be): does raw text `e` contain a link?
// `refs` maps normalized labels to {dest, title}.
function linkInText(e, refs) {
  if (!e.includes('[')) return false;
  for (const n of e.matchAll(MASK_BLOCK_SKIP)) {
    if (tryMatchLink(n[0], 0, refs) && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(MASK_REFLINK_SEARCH)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !refs.has(normalizeLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(s.slice(1, r - 1), refs))) return true;
  }
  return false;
}

function maskInline(src, refs) {
  let t = src;
  if (refs && refs.size > 0 && src.includes('[')) {
    const maskReflink = (r) => {
      const o = r.lastIndexOf('[');
      if (!refs.has(normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const i = r.slice(1, o - 1);
        if (linkInText(i, refs)) return '[' + i.replace(MASK_REFLINK_SEARCH, maskReflink) + '][' + 'a'.repeat(Math.max(0, r.length - o - 2)) + ']';
      }
      return '[' + 'a'.repeat(Math.max(0, r.length - 2)) + ']';
    };
    t = t.replace(MASK_REFLINK_SEARCH, maskReflink);
  }
  t = t.replace(MASK_ANY_PUNCT, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  t = t.replace(MASK_BLOCK_SKIP, (n, s, r) => { const o = r ? r.length : 0; return n.slice(0, o) + '[' + 'a'.repeat(Math.max(0, n.length - o - 2)) + ']'; });
  return t;
}

// marked's del tokenizer (GFM rules), ported verbatim: delLDelim and
// delRDelim from Lexer.rules.inline.gfm.
const DEL_L_DELIM = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const DEL_R_DELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;

// Try marked's del at the tilde run starting at `i` in `src`.
// `masked` is maskInline(src), `delCloser` is the last possible '~'
// closer index in `masked`, `prevChar` is marked's `r` (last char of
// the preceding text token, or '' after a non-text token).
// Returns {raw, text} or null. The caller parses `text` recursively,
// as marked's del tokenizer does (a fresh inline context, so a closer
// inside is judged without the trailing tildes visible).
function tryDel(src, masked, i, prevChar, delCloser) {
  const e = src.slice(i);
  let s = DEL_L_DELIM.exec(e);
  if (!s) return null;
  // marked proceeds unless the char after the tildes is punctuation
  // and the previous char is a non-punctuation character
  if (s[1] && prevChar && !EM_STRONG_PUNCT_RE.exec(prevChar)) return null;
  const o = [...s[0]].length - 1;
  let p = o;
  const d = i + o;
  if (delCloser < d) return null;
  const t = masked.slice(i + o);
  const k = delCloser - d;
  const A = DEL_R_DELIM;
  for (A.lastIndex = 0; (s = A.exec(t)) !== null && !(s.index > k);) {
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    let l = [...g].length;
    if (l !== o) continue;
    if (s[3] || s[4]) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    l = Math.min(l, l + p);
    const te = [...s[0]][0].length;
    const raw = e.slice(0, o + s.index + te + l);
    return { raw, text: raw.slice(o, -o) };
  }
  return null;
}

// Try marked's emStrong at the delimiter run starting at `i` in `src`.
// `masked` is maskInline(src), `closerIdx` is the result of
// lastPossibleEmStrongCloser(masked), `prevChar` is marked's `r` (last
// char of the preceding text token, or '' after a non-text token).
// Returns {raw, text, tag} or null.
function tryEmStrong(src, masked, i, closerIdx, prevChar) {
  const e = src.slice(i);
  let s = EM_STRONG_L_DELIM.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = prevChar === r;
  const start = i;
  let l = start;
  for (; l > 0 && masked[l - 1] === r;) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!EM_STRONG_PUNCT_RE.exec(p);
  let n = prevChar;
  if (l < start) n = p;
  const u = l < start ? h : !!EM_STRONG_PUNCT_RE.exec(n);
  if (s[4] && EM_STRONG_ALPHA_NUM_RE.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let g, b, m = k, f = 0;
    const y = start - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? EM_STRONG_R_DELIM_AST : EM_STRONG_R_DELIM_UND;
    const v = closerIdx[r];
    const Q = start + k;
    if (v < Q) return null;
    const t = masked.slice(start + k);
    const ee = v - Q;
    for (A.lastIndex = 0; (s = A.exec(t)) !== null && !(s.index > ee);) {
      if (g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !g) continue;
      if (b = [...g].length, s[3] || s[4]) { m += b; continue; }
      else if (s[5] || s[6] || R) {
        if (o && (s[5] || s[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      if (m -= b, m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...s[0]][0].length;
      const M = e.slice(0, k + s.index + te + b);
      if (Math.min(k, b) % 2) {
        return { raw: M, text: M.slice(1, -1), tag: 'em' };
      }
      return { raw: M, text: M.slice(2, -2), tag: 'strong' };
    }
  }
  return null;
}

// Document-level inline lexer state (marked's Lexer.state). `inLink`
// persists across every inline parse of the document: an unclosed
// `<a ...>` tag (inline HTML) suppresses extended autolinks for the
// rest of the document, until a `</a>` tag. `inRawBlock` is reset
// before each top-level inline parse (each paragraph, heading, table
// cell) but persists through the nested parses inside it (link labels,
// emphasis), so text inside an inline <pre>/<code>/<kbd>/<script>
// region is output raw (no entity decoding, no escaping).
let inlineState = { inLink: false, inRawBlock: false };

// Parse inline content into a node list. `refs` maps normalized labels to
// {dest, title}. When `inLink` is true, extended autolinks are suppressed.
function parseInlineNodes(src, refs, inLink) {
  const nodes = [];
  let i = 0;
  const n = src.length;
  let closerCache = null;
  let maskedCache = null;
  const getMasked = () => (maskedCache || (maskedCache = maskInline(src, refs)));
  const getCloserIdx = () => (closerCache || (closerCache = lastPossibleEmStrongCloser(getMasked())));
  // marked's `r`: last char of the preceding text token, '' after a
  // non-text token; a text token ending in '_' does not update it.
  let prevChar = '';
  const setPrevAfterText = (s) => {
    if (s[s.length - 1] !== '_') prevChar = s[s.length - 1];
  };
  const pushNode = (nd) => { nodes.push(nd); prevChar = ''; };

  const pushText = (s, enc) => {
    if (!s) return;
    enc = enc || 0;
    const last = nodes[nodes.length - 1];
    if (last && last.t === 'text' && last.enc === enc) last.s += s;
    else nodes.push({ t: 'text', s, enc });
    setPrevAfterText(s);
  };

  while (i < n) {
    const c = src[i];
    // backslash escape / hard break
    if (c === '\\' && i + 1 < n) {
      const nx = src[i + 1];
      if (PUNCT.has(nx)) { pushText(nx, 1); i += 2; continue; }
      if (nx === '\n') {
        let k = i + 2;
        while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
        if (k < n) {
          pushNode({ t: 'br' });
          i = i + 2;
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          continue;
        }
        pushText('\\'); i++;
        continue;
      }
    }
    // code span (a failed code span consumes the whole backtick run
    // as literal text; marked's text rule never retries inside a run)
    if (c === '`') {
      const cs = parseCodeSpan(src, i);
      if (cs) { pushNode({ t: 'code', s: cs.text }); i = cs.end; continue; }
      let j = i;
      while (j < n && src[j] === '`') j++;
      pushText(src.slice(i, j));
      i = j;
      continue;
    }
    // autolink <...> or inline HTML tag
    if (c === '<') {
      const al = parseAutolink(src, i);
      if (al) {
        pushNode({ t: 'link', kind: 'autolink', href: al.href, title: null, text: al.text, c: [{ t: 'text', s: al.text }] });
        i = al.end;
        continue;
      }
      const tag = parseHtmlTag(src, i);
      if (tag) {
        // marked's tag tokenizer updates the lexer's persistent state.
        // Inside a link label the inLink change is discarded (marked's
        // De saves and restores it), but inRawBlock is not restored
        // when the link is formed, so it updates even inside a label.
        if (!inLink) {
          if (!inlineState.inLink && /^<a /i.test(tag)) inlineState.inLink = true;
          else if (inlineState.inLink && /^<\/a>/i.test(tag)) inlineState.inLink = false;
        }
        if (!inlineState.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) inlineState.inRawBlock = true;
        else if (inlineState.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) inlineState.inRawBlock = false;
        pushNode({ t: 'html', s: tag }); i += tag.length; continue;
      }
    }
    // extended autolink (suppressed inside a link, and once an <a> tag
    // has opened anywhere earlier in the document)
    if (!inLink && !inlineState.inLink) {
      const ea = parseExtAutolink(src, i);
      if (ea) {
        pushNode({ t: 'link', kind: 'ext', href: ea.href, title: null, text: ea.text, c: [{ t: 'text', s: ea.text }] });
        i = ea.end;
        continue;
      }
    }
    // link / image opener
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const isImage = c === '!';
      const openIdx = isImage ? i + 1 : i;
      const link = tryMatchLink(src, openIdx, refs);
      if (link) {
        // marked's De restores inRawBlock when the label contains a
        // link and the link is rejected (but not when it is formed).
        const rawBefore = inlineState.inRawBlock;
        const textNodes = parseInlineNodes(link.text, refs, true);
        // A link whose text contains a link is not formed (marked's
        // link rule); an image's label may contain a link — its text
        // contributes to the alt text.
        if (isImage || !containsBracketLink(textNodes)) {
          if (isImage) {
            pushNode({ t: 'image', href: link.dest, title: link.title, alt: plainText(textNodes) });
          } else {
            pushNode({ t: 'link', kind: 'bracket', href: link.dest, title: link.title, c: textNodes });
          }
          i = link.end;
          continue;
        }
        inlineState.inRawBlock = rawBefore;
      }
      if (isImage) { pushText('!['); i += 2; }
      else { pushText('['); i += 1; }
      continue;
    }
    // emphasis / del delimiters
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && src[j] === c) j++;
      if (c !== '~') {
        // marked's emStrong tokenizer first (it resolves the tricky
        // nested/odd-run cases the delimiter stack gets wrong)
        const em = tryEmStrong(src, getMasked(), i, getCloserIdx(), prevChar);
        if (em) {
          pushNode({ t: em.tag, c: parseInlineNodes(em.text, refs, inLink) });
          i += em.raw.length;
          continue;
        }
        // marked tries emStrong at every position of a run: a rejected
        // run leaves its first character literal and retries the next
        // position (e.g. `**foo*` -> `*<em>foo</em>`)
        pushText(c);
        i++;
        continue;
      }
      // marked's del tokenizer (scan-time, like emStrong): on success
      // its inner text is parsed in a fresh inline context, so a
      // closer inside is judged without the trailing tildes visible
      const del = tryDel(src, getMasked(), i, prevChar, getCloserIdx()['~']);
      if (del) {
        pushNode({ t: 'del', c: parseInlineNodes(del.text, refs, inLink) });
        i += del.raw.length;
        continue;
      }
      // a rejected run stays literal text (marked's inlineText takes
      // the whole run)
      pushText(src.slice(i, j));
      i = j;
      continue;
    }
    // newline: hard break (2+ spaces) or soft break
    if (c === '\n') {
      const last = nodes[nodes.length - 1];
      let rest = i + 1;
      while (rest < n && (src[rest] === ' ' || src[rest] === '\t' || src[rest] === '\n')) rest++;
      if (last && last.t === 'text' && / {2,}$/.test(last.s) && rest < n) {
        last.s = last.s.replace(/ +$/, '');
        if (last.s === '') nodes.pop();
        pushNode({ t: 'br' });
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      pushText('\n');
      i++;
      continue;
    }
    // numeric entity in text (not decoded inside an inline
    // <pre>/<code>/<kbd>/<script> region: marked leaves the text raw)
    if (c === '&') {
      if (!inlineState.inRawBlock) {
        const dec = tryDecodeEntity(src, i);
        if (dec) { pushText(dec.ch, dec.raw ? 2 : 0); i = dec.end; continue; }
      }
      pushText('&', inlineState.inRawBlock ? 2 : 0);
      i++;
      continue;
    }
    // plain text run (stops before anything that may start an inline
    // construct, including an extended autolink)
    let j = i;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\' || ch === '`' || ch === '<' || ch === '[' || ch === '!' || ch === ']' || ch === '*' || ch === '_' || ch === '~' || ch === '\n' || ch === '&') break;
      if (ch === 'w' && src.startsWith('www.', j)) break;
      if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(src.slice(j, j + 8))) break;
      if ((ch === 'f' || ch === 'F') && src.slice(j, j + 6).toLowerCase() === 'ftp://') break;
      if (ch === 'm' && src.startsWith('mailto:', j)) break;
      if (ch === 'x' && src.startsWith('xmpp:', j)) break;
      // an email may start here (a word containing '@')
      if (isEmailChar(ch) && !isEmailChar(src[j - 1])) {
        let k = j;
        while (k < n && isEmailChar(src[k])) k++;
        if (k < n && src[k] === '@') break;
      }
      j++;
    }
    if (j === i) { pushText(src[i], inlineState.inRawBlock ? 2 : 0); i++; continue; }
    pushText(src.slice(i, j), inlineState.inRawBlock ? 2 : 0);
    i = j;
  }

  // marked has no delimiter-stack fallback for emphasis: its emStrong
  // and del tokenizers are the only emphasis mechanisms, so a run
  // either of them rejects stays literal.
  return nodes;
}

// Render inline nodes to HTML.
function renderInlineNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += nd.enc === 2 ? nd.s : esc(nd.s, nd.enc === 1);
    else if (nd.t === 'code') out += '<code>' + esc(nd.s, true) + '</code>';
    else if (nd.t === 'br') out += '<br>';
    else if (nd.t === 'html') out += nd.s;
    else if (nd.t === 'em') out += '<em>' + renderInlineNodes(nd.c) + '</em>';
    else if (nd.t === 'strong') out += '<strong>' + renderInlineNodes(nd.c) + '</strong>';
    else if (nd.t === 'del') out += '<del>' + renderInlineNodes(nd.c) + '</del>';
    else if (nd.t === 'link') {
      const cleaned = cleanUrl(nd.href);
      if (cleaned === null) { out += renderInlineNodes(nd.c); continue; }
      const href = esc(cleaned, nd.kind === 'autolink' || nd.kind === 'ext');
      const text = nd.kind === 'autolink' || nd.kind === 'ext' ? esc(nd.text, true) : renderInlineNodes(nd.c);
      out += '<a href="' + href + '"';
      if (nd.title) out += ' title="' + esc(nd.title, false) + '"';
      out += '>' + text + '</a>';
    } else if (nd.t === 'image') {
      const cleaned = cleanUrl(nd.href);
      if (cleaned === null) { out += esc(nd.alt, false); continue; }
      out += '<img src="' + esc(cleaned, false) + '" alt="' + esc(nd.alt, false) + '"';
      if (nd.title) out += ' title="' + esc(nd.title, false) + '"';
      out += '>';
    }
  }
  return out;
}

function parseInline(src, refs) {
  // marked resets inRawBlock before each queued inline parse; inLink
  // is not reset (it persists across the whole document).
  inlineState.inRawBlock = false;
  return renderInlineNodes(parseInlineNodes(src, refs, false));
}

// ---------------- block renderer ----------------

function renderBlocks(blocks, refs) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs);
  return out;
}

function renderBlock(b, refs) {
  switch (b.type) {
    case 'root': return renderBlocks(b.children, refs);
    case 'blockquote': return '<blockquote>\n' + renderBlocks(b.children, refs) + '</blockquote>\n';
    case 'paragraph': return '<p>' + parseInline(b.text, refs) + '</p>\n';
    case 'heading': return '<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n';
    case 'hr': return '<hr>\n';
    case 'code': {
      const lang = (b.lang || '').match(/^\S*/)[0];
      let text = b.text || '';
      text = text ? text.replace(/\n$/, '') + '\n' : '';
      const body = esc(text, true);
      if (lang) return '<pre><code class="language-' + esc(lang, false) + '">' + body + '</code></pre>\n';
      return '<pre><code>' + body + '</code></pre>\n';
    }
    case 'html': return b.text;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      let items = '';
      for (const it of b.items) items += renderListItem(it, b, refs);
      return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
    }
    case 'table': {
      let head = '';
      for (let k = 0; k < b.headerCells.length; k++) {
        const cell = b.headerCells[k];
        const align = b.aligns[k];
        head += align ? '<th align="' + align + '">' + parseInline(cell, refs) + '</th>\n' : '<th>' + parseInline(cell, refs) + '</th>\n';
      }
      let body = '';
      for (const row of b.rows) {
        let cells = '';
        for (let k = 0; k < row.length; k++) {
          const align = b.aligns[k];
          cells += align ? '<td align="' + align + '">' + parseInline(row[k], refs) + '</td>\n' : '<td>' + parseInline(row[k], refs) + '</td>\n';
        }
        body += '<tr>\n' + cells + '</tr>\n';
      }
      return '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
    }
    default: return '';
  }
}

function renderListItem(it, list, refs) {
  // task list: the item's first paragraph starts with [ ] / [x] / [X]
  // followed by whitespace and a non-space character.
  let taskChecked = null;
  let firstPara = null;
  if (it.children.length && it.children[0].type === 'paragraph') {
    firstPara = it.children[0];
    const m = /^\[([ xX])\][ \t]+[^ \t]/.exec(firstPara.text);
    if (m) taskChecked = m[1] !== ' ';
  }
  const stripTask = (text) => (taskChecked === null ? text : text.replace(/^\[[ xX]\][ \t]+/, ''));
  const checkbox = taskChecked === null ? '' : '<input ' + (taskChecked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
  if (!list.loose) {
    // tight list: every paragraph renders as bare inline text (marked
    // lexes list-item text as `text` tokens, not paragraphs, when the
    // list is tight)
    let out = '<li>';
    for (let k = 0; k < it.children.length; k++) {
      const b = it.children[k];
      if (b.type === 'paragraph') {
        out += (k === 0 ? checkbox : '') + parseInline(k === 0 ? stripTask(b.text) : b.text, refs);
      } else {
        out += renderBlock(b, refs);
      }
    }
    return out + '</li>\n';
  }
  // loose list: paragraphs wrap in <p>; the checkbox goes inside the first <p>
  let out = '<li>';
  for (let k = 0; k < it.children.length; k++) {
    const b = it.children[k];
    if (k === 0 && b.type === 'paragraph') {
      out += '<p>' + checkbox + parseInline(stripTask(b.text), refs) + '</p>\n';
    } else {
      out += renderBlock(b, refs);
    }
  }
  return out + '</li>\n';
}

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = new Map();
  inlineState.inLink = false;
  inlineState.inRawBlock = false;
  const root = parseBlocks(src, refs);
  return renderBlocks(root.children, refs);
}
