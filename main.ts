// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, as [old, new] pairs. */
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
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  noteMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines plus its own line break and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

// --- Matching lines (SPEC.md section 5) ------------------------------------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Positions where O matches lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once at or
 * after `from`, with every such occurrence's position. Null when O occurs at no tier.
 */
function findTier(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    const pos = occurrences(lines, o, tier).filter((i) => i >= from);
    if (pos.length > 0) return { tier, positions: pos };
  }
  return null;
}

/** One line of a chunk or hunk body: context, old or new. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/** Parse body lines (already known to start with ' ', '-', '+', or to be empty) into BodyLines. */
function parseBody(body: string[]): BodyLine[] {
  const out: BodyLine[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) continue;
    if (l === '') out.push({ kind: 'ctx', text: '' });
    else if (l[0] === ' ') out.push({ kind: 'ctx', text: l.slice(1) });
    else if (l[0] === '-') out.push({ kind: 'old', text: l.slice(1) });
    else if (l[0] === '+') out.push({ kind: 'new', text: l.slice(1) });
  }
  return out;
}

/**
 * The lines N of a chunk or hunk, each with the index of the O line it is a context line of
 * (null for an added line).
 */
interface NLine {
  text: string;
  oIndex: number | null;
}

function splitON(items: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      n.push({ text: it.text, oIndex: o.length });
      o.push(it.text);
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else {
      n.push({ text: it.text, oIndex: null });
    }
  }
  return { o, n };
}

/**
 * Build the replacement lines for an occurrence of O at position `at`: a context line is written
 * as the file's own matched line, never the patch's; at tier 2 every other line is re-indented
 * (section 5).
 */
function buildN(lines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadingWs(lines[at] ?? '');
    p = leadingWs(o[0] ?? '');
  }
  for (const nl of n) {
    if (nl.oIndex !== null) {
      out.push(lines[at + nl.oIndex]!);
    } else if (tier === 2) {
      const t = nl.text;
      if (!onlyWs(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/** Whether a `\` line follows the body's last context or `+` line (section 6's final-break rule). */
function backslashAfterLast(body: string[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j += 1) {
    const l = body[j]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') last = j;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.startsWith('\\');
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- JSON edits (SPEC.md section 9) ----------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Unified diffs (SPEC.md section 6) --------------------------------------

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  dash: string | null;
  plus: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/([^ \t]+) b\/([^ \t]+)$/;

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a/ or b/ removed. */
function diffPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let headerDone = false;
  let i = 0;
  const startSection = (diffOld: string | null, diffNew: string | null): UniSection => {
    const s: UniSection = { dash: null, plus: null, renameFrom: null, renameTo: null, diffOld, diffNew, create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    headerDone = false;
    return s;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !headerDone) {
        // The section's own header pair.
        cur.dash = diffPath(l);
        i += 1;
        continue;
      }
      startSection(null, null);
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (!isBodyLine(b)) break;
        body.push(b);
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      headerDone = true;
      continue;
    }
    if (cur !== null && !headerDone) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) cur.plus = diffPath(l);
      else if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) cur.create = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.del = true;
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and
      // any other line in the header are ignored.
      i += 1;
      continue;
    }
    // Outside a section, or after a section's first hunk: prose, ignored.
    i += 1;
  }
  return sections;
}

/** Apply one section's hunks, in order, to a file model; throws Fail on the first failure. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitON(parseBody(h.body));
    if (o.length > 0) {
      const found = findTier(model.lines, o, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let at = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(at - target)) at = p;
      }
      const touchesEnd = at + o.length === model.lines.length;
      const built = buildN(model.lines, at, o, n, found.tier);
      model.lines.splice(at, o.length, ...built);
      if (touchesEnd) model.final = !backslashAfterLast(h.body);
      d += n.length - o.length;
    } else {
      const idx = Math.min(Math.max(h.a + d, 0), model.lines.length);
      const atEnd = idx === model.lines.length;
      const built = n.map((x) => x.text);
      model.lines.splice(idx, 0, ...built);
      if (atEnd) model.final = !backslashAfterLast(h.body);
      d += n.length;
    }
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    // The `---`/`+++` pair names the paths; `rename from`/`to` when no pair does; the
    // `diff --git` paths when nothing else does.
    const oldPath = sec.dash ?? sec.renameFrom ?? sec.diffOld ?? '';
    const newPath = sec.plus ?? sec.renameTo ?? sec.diffNew ?? '';
    const isCreate = oldPath === '/dev/null' || sec.create;
    const isDelete = newPath === '/dev/null' || sec.del;
    const isMove = !isCreate && !isDelete && oldPath !== newPath;
    return (tree: Tree): void => {
      // Safety is checked for the paths this edit uses: `/dev/null` means no file, not a path.
      if (isCreate) {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus: string[] = [];
        for (const h of sec.hunks) {
          for (const b of h.body) {
            if (b[0] === '+') plus.push(b.slice(1));
          }
        }
        // A created file ends with a line break unless a `\` line follows its last `+` line.
        let final = true;
        for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
          const h = sec.hunks[hi]!;
          let lastPlus = -1;
          for (let j = 0; j < h.body.length; j += 1) if (h.body[j]![0] === '+') lastPlus = j;
          if (lastPlus >= 0) {
            const next = h.body[lastPlus + 1];
            final = !(next !== undefined && next.startsWith('\\'));
            break;
          }
        }
        tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
        return;
      }
      if (isDelete) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (isMove) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const model = parseFile(tree.get(oldPath)!);
        applyHunks(model, sec.hunks, strict, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, writeFile(model));
        tree.noteMove(oldPath, newPath);
        return;
      }
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      const model = parseFile(tree.get(oldPath)!);
      applyHunks(model, sec.hunks, strict, oldPath);
      tree.now.set(oldPath, writeFile(model));
    };
  });
}

// --- SEARCH/REPLACE blocks (SPEC.md section 7) --------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const model = parseFile(text);
      const found = findTier(model.lines, oldLines, 0, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const at = found.positions[0]!;
      const built = buildN(model.lines, at, oldLines, newLines.map((t) => ({ text: t, oIndex: null })), found.tier);
      model.lines.splice(at, oldLines.length, ...built);
      tree.now.set(p, writeFile(model));
    });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

// --- V4A patches (SPEC.md section 8) ------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

type V4aSection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[]; updateLine: number };

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    const start = i + 1;
    let j = start;
    while (j < last) {
      const m = lines[j]!;
      if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
      j += 1;
    }
    const raw = lines.slice(start, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const r = raw[k]!;
        if (r === '') fileLines.push('');
        else if (r[0] === '+') fileLines.push(r.slice(1));
        else throw new Exit2(`error: parse ${start + k + 1}`);
      }
      sections.push({ kind, path, fileLines });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${start + 1}`);
      sections.push({ kind, path });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice(13).trim();
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (; k < raw.length; k += 1) {
        const r = raw[k]!;
        const lineNo = start + k + 1;
        if (r.startsWith('@@')) {
          const anchor = r.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
        } else if (r === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          cur = null;
        } else if (r === '' || r[0] === ' ' || r[0] === '-' || r[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push(r);
        } else {
          throw new Exit2(`error: parse ${lineNo}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, moveTo, chunks, updateLine: headerLine });
    }
    i = j;
  }
  return sections.map((sec) => {
    if (sec.kind === 'add') {
      const { path, fileLines } = sec;
      return (tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      const { path } = sec;
      return (tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      };
    }
    const { path, moveTo, chunks } = sec;
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const text = tree.get(path);
      if (text === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const model = parseFile(text);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const found = findTier(model.lines, [ch.anchor], cursor, strict);
          if (found === null) throw new Fail('no-match', path);
          cursor = found.positions[0]! + 1;
        }
        const { o, n } = splitON(parseBody(ch.body));
        if (o.length === 0) {
          const idx = ch.eof ? model.lines.length : cursor;
          const built = n.map((x) => x.text);
          model.lines.splice(idx, 0, ...built);
          cursor = idx + built.length;
          continue;
        }
        let found: { tier: number; positions: number[] } | null = null;
        if (ch.eof) {
          // An end-of-file chunk takes only an occurrence that ends at the file's last line.
          const at = model.lines.length - o.length;
          if (at >= cursor) {
            for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
              let ok = true;
              for (let q = 0; q < o.length; q += 1) {
                if (!lineEq(model.lines[at + q]!, o[q]!, tier)) {
                  ok = false;
                  break;
                }
              }
              if (ok) {
                found = { tier, positions: [at] };
                break;
              }
            }
          }
        } else {
          found = findTier(model.lines, o, cursor, strict);
        }
        if (found === null) throw new Fail('no-match', path);
        const at = found.positions[0]!;
        const built = buildN(model.lines, at, o, n, found.tier);
        model.lines.splice(at, o.length, ...built);
        cursor = at + built.length;
      }
      const out = writeFile(model);
      if (moveTo !== null) {
        tree.now.set(path, null);
        tree.now.set(moveTo, out);
        tree.noteMove(path, moveTo);
      } else {
        tree.now.set(path, out);
      }
    };
  });
}

// --- The command line (SPEC.md sections 1, 2 and 10) --------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const covered = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.now.has(oldP) &&
      tree.now.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.now.has(newP) &&
      tree.now.get(newP) !== null
    ) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
