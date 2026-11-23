// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  /** Successful moves, as (old, new) pairs, for the `R` output lines (section 2). */
  readonly moves: [string, string][] = [];
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
}

/** A file's lines under section 3: its break, its lines, and whether it ends with a break. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const onlyWs = (s: string): boolean => s === '' || /^[ \t]+$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position where O occurs in lines at one tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  pos: number[];
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: ctx >= 0 means it is a context line, the file's own line at pos + ctx. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * Build the replacement lines for a match at pos (section 5.5/5.6): context lines are the file's
 * own matched lines, and at tier 2 every other non-blank line that starts with P has P replaced
 * by F. With an empty O there is no match and no tier, so the lines are written as they are.
 */
function buildNew(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const eff = o.length === 0 ? 0 : tier;
  const f = leadWs(fileLines[pos] ?? '');
  const p = leadWs(o.length > 0 ? o[0]! : '');
  const out: string[] = [];
  for (const item of n) {
    if (item.ctx >= 0) {
      out.push(fileLines[pos + item.ctx]!);
      continue;
    }
    const t = item.text;
    if (eff === 2 && !onlyWs(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

type Edit = (tree: Tree) => void;

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

/** A unified hunk (section 6): O is its context and `-` lines, N its context and `+` lines. */
interface Hunk {
  /** Old start line, 1-based, from the `@@ -A ... @@` header. */
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** The `+` lines in order, for creations (section 6.10). */
  plus: string[];
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}

interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

function finishHunk(a: number, body: BodyLine[], bsAfter: boolean[]): Hunk {
  const o: string[] = [];
  const n: NLine[] = [];
  const plus: string[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, ctx: -1 });
      plus.push(b.text);
    }
  }
  let lastCtxNew = -1;
  let lastNew = -1;
  for (let k = body.length - 1; k >= 0; k--) {
    if (lastCtxNew < 0 && (body[k]!.kind === 'ctx' || body[k]!.kind === 'new')) lastCtxNew = k;
    if (lastNew < 0 && body[k]!.kind === 'new') lastNew = k;
    if (lastCtxNew >= 0 && lastNew >= 0) break;
  }
  return {
    a,
    o,
    n,
    noEol: lastCtxNew >= 0 ? (bsAfter[lastCtxNew] ?? false) : false,
    plus,
    plusNoEol: lastNew >= 0 ? (bsAfter[lastNew] ?? false) : false,
  };
}

/** One unified section (section 6). pair/rename paths are undefined when that source is absent. */
interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newUSection(): USection {
  return {
    gitOld: null,
    gitNew: null,
    pairOld: undefined,
    pairNew: undefined,
    renOld: undefined,
    renNew: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

/** The `@@ -A[,B] +C[,D] @@` header: A, or null when the line is not a hunk header. */
function hunkA(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return m === null ? null : Number(m[1]);
}

/** `diff --git a/<X> b/<Y>`: the two paths, or null when the line is not of that form. */
function gitPaths(line: string): [string, string] | null {
  const parts = line.slice('diff --git '.length).split(' ');
  if (parts.length < 2) return null;
  const a = parts[0]!;
  const b = parts[1]!;
  if (!a.startsWith('a/') || !b.startsWith('b/')) return null;
  return [a.slice(2), b.slice(2)];
}

/** The path a `--- `/`+++ ` header line names, up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

/** `/dev/null` means no file; otherwise one leading `a/` or `b/` is removed. */
function pathOrNull(raw: string): string | null {
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function startsWithWord(line: string, word: string): boolean {
  if (!line.startsWith(word)) return false;
  const c = line[word.length];
  return c === undefined || c === ' ' || c === '\t';
}

function resolveUPaths(s: USection): { oldP: string | null; newP: string | null } {
  const oldP = s.pairOld !== undefined ? s.pairOld : s.renOld !== undefined ? s.renOld : s.gitOld;
  const newP = s.pairNew !== undefined ? s.pairNew : s.renNew !== undefined ? s.renNew : s.gitNew;
  return { oldP, newP };
}

function uKind(s: USection): 'create' | 'delete' | 'move' | 'change' {
  const { oldP, newP } = resolveUPaths(s);
  if (oldP === null || s.newFile) return 'create';
  if (newP === null || s.deletedFile) return 'delete';
  if (oldP !== newP) return 'move';
  return 'change';
}

/** Apply one section's hunks in order to a file's text (sections 6.14-6.17). */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  let fm = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(h.a + d, fm.lines.length);
      const touchesEnd = pos === fm.lines.length;
      const repl = h.n.map((x) => x.text);
      const out = [...fm.lines.slice(0, pos), ...repl, ...fm.lines.slice(pos)];
      fm = { lines: out, br: fm.br, final: touchesEnd ? !h.noEol : fm.final };
      d += h.n.length;
      continue;
    }
    const found = findTier(fm.lines, h.o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = Math.max(0, Math.min(h.a - 1 + d, fm.lines.length - h.o.length));
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    const touchesEnd = best + h.o.length === fm.lines.length;
    const repl = buildNew(fm.lines, best, h.o, h.n, found.tier);
    const out = [...fm.lines.slice(0, best), ...repl, ...fm.lines.slice(best + h.o.length)];
    fm = { lines: out, br: fm.br, final: touchesEnd ? !h.noEol : fm.final };
    d += h.n.length - h.o.length;
  }
  return joinFile(fm);
}

function applyUnifiedSection(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const { oldP, newP } = resolveUPaths(sec);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    const kind = uKind(sec);
    if (kind === 'create') {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const lines: string[] = [];
      for (const h of sec.hunks) lines.push(...h.plus);
      let final = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.plus.length > 0) {
          final = !h.plusNoEol;
          break;
        }
      }
      tree.now.set(newP, lines.length === 0 ? '' : lines.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      if (oldP === null) throw new Fail('missing', '/dev/null');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (kind === 'move') {
      const before = tree.get(oldP!);
      if (before === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const result = applyHunks(before, sec.hunks, strict, oldP!);
      tree.now.set(newP!, result);
      tree.now.set(oldP!, null);
      tree.moves.push([oldP!, newP!]);
      return;
    }
    const path = oldP!;
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    tree.now.set(path, applyHunks(before, sec.hunks, strict, path));
  };
}

/** Read a patch's unified sections (section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let headerPair = false;
  let body: BodyLine[] | null = null;
  let bsAfter: boolean[] = [];
  let curHunkA = 0;
  let skip = false;

  const closeBody = (): void => {
    if (body === null || cur === null) return;
    // Section 6.8: empty lines at the end of a body are not part of it. An empty line is a
    // context line whose text is empty, whether the patch wrote it as a lone space or truly empty.
    while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') {
      body.pop();
      bsAfter.pop();
    }
    cur.hunks.push(finishHunk(curHunkA, body, bsAfter));
    body = null;
    bsAfter = [];
  };
  const closeSection = (): void => {
    closeBody();
    if (cur !== null) sections.push(cur);
    cur = null;
    headerPair = false;
    skip = false;
  };
  const startSection = (s: USection): void => {
    closeSection();
    cur = s;
    headerPair = false;
    skip = false;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const gp = gitPaths(line);
      if (gp === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newUSection();
      s.gitOld = gp[0];
      s.gitNew = gp[1];
      startSection(s);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (body !== null) closeBody();
      if (cur === null || cur.hunks.length > 0 || headerPair) {
        const s = newUSection();
        s.pairOld = pathOrNull(headerPath(line));
        s.pairNew = pathOrNull(headerPath(lines[i + 1]!));
        startSection(s);
        headerPair = true;
      } else {
        cur.pairOld = pathOrNull(headerPath(line));
        cur.pairNew = pathOrNull(headerPath(lines[i + 1]!));
        headerPair = true;
      }
      i += 2;
      continue;
    }
    if (skip) {
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      closeBody();
      if (uKind(cur) === 'delete') {
        skip = true;
        i++;
        continue;
      }
      const a = hunkA(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunkA = a;
      body = [];
      bsAfter = [];
      i++;
      continue;
    }
    if (body !== null) {
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
        if (line.startsWith(' ')) body.push({ kind: 'ctx', text: line.slice(1) });
        else if (line.startsWith('-')) body.push({ kind: 'old', text: line.slice(1) });
        else if (line.startsWith('+')) body.push({ kind: 'new', text: line.slice(1) });
        else body.push({ kind: 'ctx', text: '' });
        bsAfter.push(false);
        i++;
        continue;
      }
      if (line.startsWith('\\')) {
        if (body.length > 0) bsAfter[body.length - 1] = true;
        i++;
        continue;
      }
      closeBody();
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice(10).trim();
      else if (startsWithWord(line, 'new file mode')) cur.newFile = true;
      else if (startsWithWord(line, 'deleted file mode')) cur.deletedFile = true;
    }
    i++;
  }
  closeSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => applyUnifiedSection(s, strict));
}

/** One SEARCH/REPLACE block (section 7), applied in order. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fm = splitFile(before);
    const found = findTier(fm.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const nItems: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const repl = buildNew(fm.lines, pos, oldLines, nItems, found.tier);
    const out = [...fm.lines.slice(0, pos), ...repl, ...fm.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ lines: out, br: fm.br, final: fm.final }));
  };
}

/** Read a patch's SEARCH/REPLACE blocks (section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One V4A chunk (section 8): O is its context and `-` lines, N its context and `+` lines. */
interface VChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

interface RawLine {
  text: string;
  num: number;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = from; k < lines.length; k++) {
      if (lineEq(lines[k]!, anchor, t)) return k;
    }
  }
  return null;
}

function v4aAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fm = splitFile(before);
    let lines = fm.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        const repl = ch.n.map((x) => x.text);
        lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos)];
        cursor = pos + repl.length;
        continue;
      }
      const found = findTier(lines, ch.o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let pos = -1;
      for (const p of found.pos) {
        if (ch.eof && p + ch.o.length !== lines.length) continue;
        pos = p;
        break;
      }
      if (pos < 0) throw new Fail('no-match', path);
      const repl = buildNew(lines, pos, ch.o, ch.n, found.tier);
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + ch.o.length)];
      cursor = pos + repl.length;
    }
    const result = joinFile({ lines, br: fm.br, final: fm.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, result);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, result);
    }
  };
}

/** Read a patch's V4A sections (section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionLine = i + 1;
    const start = i + 1;
    let j = start;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      j++;
    }
    const raw: RawLine[] = [];
    for (let k = start; k < j; k++) raw.push({ text: lines[k]!, num: k + 1 });
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aAdd(path, fileLines));
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
      edits.push(v4aDelete(path));
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (const r of raw) {
        const t = r.text;
        if (cur === null && chunks.length === 0 && moveTo === null && t.startsWith('*** Move to: ')) {
          moveTo = t.slice(13).trim();
          continue;
        }
        if (t.startsWith('@@')) {
          const at = t.slice(2).trim();
          cur = { anchor: at === '' ? null : at, o: [], n: [], eof: false };
          chunks.push(cur);
          continue;
        }
        if (t === '*** End of File') {
          if (cur !== null) {
            cur.eof = true;
            cur = null;
          }
          continue;
        }
        if (t.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${r.num}`);
        if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
            cur = { anchor: null, o: [], n: [], eof: false };
            chunks.push(cur);
          }
          if (t.startsWith(' ')) {
            const x = t.slice(1);
            cur.o.push(x);
            cur.n.push({ text: x, ctx: cur.o.length - 1 });
          } else if (t.startsWith('-')) {
            cur.o.push(t.slice(1));
          } else if (t.startsWith('+')) {
            cur.n.push({ text: t.slice(1), ctx: -1 });
          } else {
            cur.o.push('');
            cur.n.push({ text: '', ctx: cur.o.length - 1 });
          }
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [old, nw] of tree.moves) {
    if (consumed.has(old) || consumed.has(nw)) continue;
    if (tree.original(old) !== null && tree.get(old) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      changed.push({ key: nw, line: `R ${old} -> ${nw}` });
      consumed.add(old);
      consumed.add(nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  // A strange input is always answered with a SPEC exit code, never with an uncaught exception.
  let r: { code: number; out: string[] };
  try {
    r = run(process.argv.slice(2));
  } catch {
    r = { code: 2, out: ['error: parse 1'] };
  }
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
