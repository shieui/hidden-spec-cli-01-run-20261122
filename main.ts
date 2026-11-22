// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. See SPEC.md for the whole
// contract. Node 22, standard library alone; run as `node main.ts [options]
// [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Set from --strict: only tier 0 is tried when matching lines. */
let strictOnly = false;

/** A whole-run rejection: exit 2 with one line. */
class Reject {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: exit 1 with `error: <code> <path>`. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file's text as lines, with its own line break and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: '\n' | '\r\n';
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const firstLf = text.indexOf('\n');
  const br: '\n' | '\r\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function renderFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move pairs recorded by successful move edits, for the R output lines. */
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  /** 'file' | 'dir' | 'none' for what the disk holds at a path right now. */
  diskKind(p: string): 'file' | 'dir' | 'none' {
    try {
      const st = statSync(p);
      if (st.isFile()) return 'file';
      if (st.isDirectory()) return 'dir';
      return 'none';
    } catch {
      return 'none';
    }
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  /** Does the path exist in the tree as the edits leave it (a directory counts as existing)? */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p)! !== null;
    return this.diskKind(p) !== 'none';
  }
}

type Edit = (tree: Tree) => void;

/** Compare two lines at a matching tier. */
function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** All 0-based positions where O occurs in lines at a tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineMatches(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions. */
function firstTier(lines: string[], o: string[], from: number): { tier: number; positions: number[] } | null {
  const maxTier = strictOnly ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const all = occurrences(lines, o, tier).filter((p) => p >= from);
    if (all.length > 0) return { tier, positions: all };
  }
  return null;
}

/**
 * Build the replacement lines for a matched block.
 * `n` holds the new lines; `ctx` maps an index of `n` to the index in `o` it
 * is a context line of (a context line is written as the file's own matched
 * line, never the patch's). At tier 2 every other line of N is re-indented:
 * P is the leading whitespace of O's first line, F that of the file's first
 * matched line; a non-empty, non-whitespace-only line starting with P has
 * that P replaced by F.
 */
function replacementLines(n: string[], ctx: Map<number, number>, o: string[], fileLines: string[], pos: number, tier: number): string[] {
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const f = fileLines.length > pos ? leadingWs(fileLines[pos]!) : '';
  return n.map((line, i) => {
    const oi = ctx.get(i);
    if (oi !== undefined) return fileLines[pos + oi]!;
    if (tier !== 2) return line;
    if (line === '' || line.trim() === '') return line;
    if (!line.startsWith(p)) return line;
    return f + line.slice(p.length);
  });
}

/** Detect the patch format (SPEC.md section 4); null when none holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const readExisting = (tree: Tree): string => {
    if (!isSafePath(p)) throw new EditFail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (tree.exists(p)) throw new EditFail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const atLine = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const model = parseFile(before);
      if (atLine < 0 || atLine > model.lines.length) throw new EditFail('no-match', p);
      model.lines.splice(atLine, 0, ...add);
      tree.now.set(p, renderFile(model));
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Reject('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Reject(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Reject(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Reject(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Reject(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** --- Unified diffs (SPEC.md section 6) --- */

interface HunkLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  a: number;
  body: HunkLine[];
}
interface UnifiedSection {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed, a leading a/ or b/ removed. */
function unifiedPath(raw: string): string {
  let s = raw;
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;

/** A hunk's body: lines starting with space, -, + or backslash, or empty lines. Trailing empty lines are not part of it. */
function hunkBody(lines: string[], i: number): { body: HunkLine[]; next: number } {
  const body: HunkLine[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: ' ', text: '' });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ kind: c as ' ' | '-' | '+' | '\\', text: l.slice(1) });
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === ' ' && last.text === '') body.pop();
    else break;
  }
  return { body, next: j };
}

/** Does a `\` line follow the hunk body's last context or `+` line? */
function backslashAfterLastAdded(body: HunkLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b.kind === ' ' || b.kind === '+') {
      return body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

/**
 * Parse one section's header and hunks, starting at line `i` (the section's
 * first line: a `diff --git` line or a `--- ` line). Returns the next line to
 * read: the start of the next section, or the end of the patch.
 */
function parseUnifiedSection(lines: string[], i: number, sec: UnifiedSection): number {
  const n = lines.length;
  let hasPair = false;
  let inHunks = false;
  while (i < n) {
    const line = lines[i]!;
    if (!inHunks) {
      if (line.startsWith('diff --git ')) return i;
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (hasPair) return i;
          sec.oldPath = unifiedPath(line.slice(4));
          sec.newPath = unifiedPath(lines[i + 1]!.slice(4));
          hasPair = true;
          i += 2;
          continue;
        }
        throw new Reject(`error: parse ${i + 2}`);
      }
      if (line.startsWith('@@')) {
        const m = HUNK_HEAD.exec(line);
        if (m === null) throw new Reject(`error: parse ${i + 1}`);
        inHunks = true;
        const { body, next } = hunkBody(lines, i + 1);
        sec.hunks.push({ a: Number(m[1]), body });
        i = next;
        continue;
      }
      if (line.startsWith('rename from ') && !hasPair) sec.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ') && !hasPair) sec.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.isCreate = true;
      else if (line.startsWith('deleted file mode')) sec.isDelete = true;
      i += 1;
      continue;
    }
    // After the first hunk: more hunks, a new section, or ignored prose.
    if (line.startsWith('diff --git ')) return i;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Reject(`error: parse ${i + 1}`);
      const { body, next } = hunkBody(lines, i + 1);
      sec.hunks.push({ a: Number(m[1]), body });
      i = next;
      continue;
    }
    i += 1;
  }
  return i;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Reject(`error: parse ${i + 1}`);
      const sec: UnifiedSection = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      i = parseUnifiedSection(lines, i + 1, sec);
      sections.push(sec);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UnifiedSection = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      i = parseUnifiedSection(lines, i, sec);
      sections.push(sec);
      continue;
    }
    if (line.startsWith('@@')) throw new Reject(`error: parse ${i + 1}`);
    i += 1;
  }
  return sections.map(unifiedSectionEdit);
}

/** Apply a section's hunks, in order, to a file model. */
function applyUnifiedHunks(model: FileModel, hunks: Hunk[], path: string): FileModel {
  const cur: FileModel = { lines: [...model.lines], br: model.br, finalBreak: model.finalBreak };
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: string[] = [];
    const ctx = new Map<number, number>();
    for (const bl of h.body) {
      if (bl.kind === ' ') {
        ctx.set(n.length, o.length);
        o.push(bl.text);
        n.push(bl.text);
      } else if (bl.kind === '-') {
        o.push(bl.text);
      } else if (bl.kind === '+') {
        n.push(bl.text);
      }
    }
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const atEnd = at === cur.lines.length;
      cur.lines.splice(at, 0, ...n);
      if (atEnd) cur.finalBreak = !backslashAfterLastAdded(h.body);
    } else {
      const found = firstTier(cur.lines, o, 0);
      if (found === null) throw new EditFail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const repl = replacementLines(n, ctx, o, cur.lines, best, found.tier);
      const runsToEnd = best + o.length === cur.lines.length;
      cur.lines.splice(best, o.length, ...repl);
      if (runsToEnd) cur.finalBreak = !backslashAfterLastAdded(h.body);
    }
    d += n.length - o.length;
  }
  return cur;
}

function unifiedSectionEdit(sec: UnifiedSection): Edit {
  return (tree) => {
    const oldP = sec.oldPath === '/dev/null' ? null : sec.oldPath;
    const newP = sec.newPath === '/dev/null' ? null : sec.newPath;
    if (oldP !== null && !isSafePath(oldP)) throw new EditFail('unsafe', oldP);
    if (newP !== null && !isSafePath(newP)) throw new EditFail('unsafe', newP);
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = !isCreate && (newP === null || sec.isDelete);
    if (isCreate && newP !== null) {
      if (tree.exists(newP)) throw new EditFail('exists', newP);
      const added: string[] = [];
      for (const h of sec.hunks) {
        for (const bl of h.body) if (bl.kind === '+') added.push(bl.text);
      }
      let finalBreak = true;
      if (added.length > 0) {
        const lastHunk = [...sec.hunks].reverse().find((h) => h.body.some((b) => b.kind === '+'));
        if (lastHunk !== undefined) finalBreak = !backslashAfterLastAdded(lastHunk.body);
      } else {
        finalBreak = false;
      }
      tree.now.set(newP, added.length === 0 ? '' : added.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete && oldP !== null) {
      if (tree.get(oldP) === null) throw new EditFail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new EditFail('missing', oldP);
      if (tree.exists(newP)) throw new EditFail('exists', newP);
      const done = applyUnifiedHunks(parseFile(before), sec.hunks, oldP);
      tree.now.set(newP, renderFile(done));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    const before = tree.get(p);
    if (before === null) throw new EditFail('missing', p);
    const done = applyUnifiedHunks(parseFile(before), sec.hunks, p);
    tree.now.set(p, renderFile(done));
  };
}

/** --- SEARCH/REPLACE blocks (SPEC.md section 7) --- */

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: SearchBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      path = prevPath;
      if (path === null) throw new Reject(`error: parse ${searchAt + 1}`);
    }
    let eq = -1;
    let rep = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Reject(`error: parse ${searchAt + 1}`);
    for (let k = eq + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Reject(`error: parse ${searchAt + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep + 1;
    prevPath = path;
    i = rep + 1;
  }
  return blocks.map(searchBlockEdit);
}

function searchBlockEdit(b: SearchBlock): Edit {
  return (tree) => {
    if (!isSafePath(b.path)) throw new EditFail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.exists(b.path)) throw new EditFail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new EditFail('missing', b.path);
    const model = parseFile(before);
    const found = firstTier(model.lines, b.oldLines, 0);
    if (found === null) throw new EditFail('no-match', b.path);
    if (found.positions.length > 1) throw new EditFail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const ctx = new Map<number, number>();
    const repl = replacementLines(b.newLines, ctx, b.oldLines, model.lines, pos, found.tier);
    model.lines.splice(pos, b.oldLines.length, ...repl);
    tree.now.set(b.path, renderFile(model));
  };
}

/** --- V4A patches (SPEC.md section 8) --- */

interface V4aChunk {
  anchor: string | null;
  endOfFile: boolean;
  o: string[];
  n: string[];
  ctx: Map<number, number>;
}
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number; // 1-based line of the section's header line
  moveTo: string | null;
  lines: string[]; // add: file lines
  chunks: V4aChunk[];
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Reject('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Reject(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Reject(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const kind = sectionStart(line);
    if (kind === null) throw new Reject(`error: parse ${i + 1}`);
    const headerNo = i + 1;
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const raw: Array<{ text: string; no: number }> = [];
    i += 1;
    while (i < last) {
      const l = lines[i]!;
      if (sectionStart(l) !== null) break;
      if (kind === 'add' && l !== '' && !l.startsWith('+')) throw new Reject(`error: parse ${i + 1}`);
      if (kind === 'delete' && !isBlank(l)) throw new Reject(`error: parse ${i + 1}`);
      raw.push({ text: l, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      sections.push({ kind, path, lineNo: headerNo, moveTo: null, lines: raw.map((r) => (r.text === '' ? '' : r.text.slice(1))), chunks: [] });
    } else if (kind === 'delete') {
      sections.push({ kind, path, lineNo: headerNo, moveTo: null, lines: [], chunks: [] });
    } else {
      const parsed = parseV4aUpdate(raw, headerNo);
      sections.push({ kind, path, lineNo: headerNo, moveTo: parsed.moveTo, lines: [], chunks: parsed.chunks });
    }
  }
  return sections.map(v4aSectionEdit);
}

/** Parse an Update File section's raw lines into a move target and chunks. */
function parseV4aUpdate(raw: Array<{ text: string; no: number }>, headerNo: number): { moveTo: string | null; chunks: V4aChunk[] } {
  let moveTo: string | null = null;
  let rest = raw;
  const firstNonBlank = raw.findIndex((r) => !isBlank(r.text));
  if (firstNonBlank >= 0 && raw[firstNonBlank]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[firstNonBlank]!.text.slice('*** Move to: '.length).trim();
    rest = raw.slice(firstNonBlank + 1);
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const flush = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (const r of rest) {
    const l = r.text;
    if (l.startsWith('@@')) {
      flush();
      cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), endOfFile: false, o: [], n: [], ctx: new Map() };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) cur = { anchor: null, endOfFile: true, o: [], n: [], ctx: new Map() };
      else cur.endOfFile = true;
      flush();
      continue;
    }
    if (cur === null) cur = { anchor: null, endOfFile: false, o: [], n: [], ctx: new Map() };
    if (l === '') {
      cur.ctx.set(cur.n.length, cur.o.length);
      cur.o.push('');
      cur.n.push('');
    } else if (l[0] === ' ') {
      cur.ctx.set(cur.n.length, cur.o.length);
      cur.o.push(l.slice(1));
      cur.n.push(l.slice(1));
    } else if (l[0] === '-') {
      cur.o.push(l.slice(1));
    } else if (l[0] === '+') {
      cur.n.push(l.slice(1));
    } else {
      throw new Reject(`error: parse ${r.no}`);
    }
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Reject(`error: parse ${headerNo}`);
  return { moveTo, chunks };
}

function v4aSectionEdit(sec: V4aSection): Edit {
  return (tree) => {
    if (!isSafePath(sec.path)) throw new EditFail('unsafe', sec.path);
    if (sec.moveTo !== null && !isSafePath(sec.moveTo)) throw new EditFail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.exists(sec.path)) throw new EditFail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : `${sec.lines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new EditFail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    // Update.
    const before = tree.get(sec.path);
    if (before === null) throw new EditFail('missing', sec.path);
    const moveTo = sec.moveTo;
    const chunks = sec.chunks;
    if (moveTo !== null && tree.exists(moveTo)) throw new EditFail('exists', moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        const maxTier = strictOnly ? 0 : 2;
        for (let tier = 0; tier <= maxTier && foundAt < 0; tier += 1) {
          for (let k = cursor; k < model.lines.length; k += 1) {
            if (lineMatches(model.lines[k]!, ch.anchor, tier)) {
              foundAt = k;
              break;
            }
          }
        }
        if (foundAt < 0) throw new EditFail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.endOfFile ? model.lines.length : cursor;
        model.lines.splice(at, 0, ...ch.n);
        cursor = at + ch.n.length;
        continue;
      }
      let found: { tier: number; positions: number[] } | null = null;
      const maxTier = strictOnly ? 0 : 2;
      for (let tier = 0; tier <= maxTier; tier += 1) {
        const all = occurrences(model.lines, ch.o, tier).filter((p) => p >= cursor);
        if (ch.endOfFile) {
          const atEnd = all.filter((p) => p + ch.o.length === model.lines.length);
          if (atEnd.length > 0) {
            found = { tier, positions: atEnd };
            break;
          }
        } else if (all.length > 0) {
          found = { tier, positions: all };
          break;
        }
      }
      if (found === null) throw new EditFail('no-match', sec.path);
      const pos = found.positions[0]!;
      const repl = replacementLines(ch.n, ch.ctx, ch.o, model.lines, pos, found.tier);
      model.lines.splice(pos, ch.o.length, ...repl);
      cursor = pos + repl.length;
    }
    const done = renderFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, done);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, moveTo]);
    } else {
      tree.now.set(sec.path, done);
    }
  };
}

/** --- Running (SPEC.md sections 1, 2 and 10) --- */

function parseArgs(args: string[]): { format: string; check: boolean; strict: boolean; file: string | null } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else throw new Reject('error: usage');
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) throw new Reject('error: usage');
  return { format: format ?? 'auto', check, strict, file: pos.length === 0 || pos[0] === '-' ? null : pos[0]! };
}

/**
 * Apply the edits to the tree and work out the output rows, without writing.
 * Rows are {sortKey, line, path, now, delPath}: `now` is the text to write
 * (null: delete); a successful move replaces its D and A rows with one R row,
 * whose delPath is the old path to remove.
 */
function planChanges(tree: Tree): Array<{ sortKey: string; line: string; path: string; now: string | null; delPath?: string }> {
  const rows = new Map<string, { sortKey: string; line: string; path: string; now: string | null; delPath?: string }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, {
      sortKey: p,
      line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`,
      path: p,
      now,
    });
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) === null || tree.get(oldP) !== null) continue;
    if (tree.original(newP) !== null || tree.get(newP) === null) continue;
    rows.delete(oldP);
    rows.delete(newP);
    rows.set(newP, { sortKey: newP, line: `R ${oldP} -> ${newP}`, path: newP, now: tree.get(newP), delPath: oldP });
  }
  return [...rows.values()].sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
}

function run(args: string[]): { code: number; out: string[] } {
  let opts: { format: string; check: boolean; strict: boolean; file: string | null };
  try {
    opts = parseArgs(args);
  } catch (e) {
    if (e instanceof Reject) return { code: 2, out: [e.line] };
    throw e;
  }
  let text = '';
  try {
    text = readFileSync(opts.file ?? 0, 'utf8');
  } catch {
    if (opts.file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = opts.format === 'auto' ? detectFormat(lines) : opts.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new Reject('error: parse 1');
  } catch (e) {
    if (e instanceof Reject) return { code: 2, out: [e.line] };
    throw e;
  }
  strictOnly = opts.strict;
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows = planChanges(tree);
  if (!opts.check) {
    for (const r of rows) {
      if (r.delPath !== undefined) rmSync(r.delPath, { force: true });
      if (r.now === null) {
        rmSync(r.path, { force: true });
      } else {
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, r.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
