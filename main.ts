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

type Edit = (tree: Tree) => void;

/** Moves that succeeded, for the R output lines (section 2): [old, new]. */
const moves: Array<[string, string]> = [];

/* ---- section 3: a file's lines, line break and final break ---- */

function fileParts(text: string): { lines: string[]; br: string; finalBreak: boolean } {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

/* ---- section 5: matching lines at three tiers ---- */

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** 0-based positions i where O matches file[i..], at the given tier, at or after `from`. */
function occurrences(file: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(file[i + j]!, tier) !== normLine(o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once. */
function findTier(file: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(file, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

type BodyItem = { kind: ' ' | '-' | '+' | '\\'; text: string };

/**
 * The N lines for a hunk/chunk whose O matched file[pos..]: context lines are the
 * file's own matched lines; at tier 2 every other N line is re-indented (section 5).
 */
function buildReplacement(items: BodyItem[], oLines: string[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  let f = '';
  let p = '';
  if (tier === 2 && oLines.length > 0) {
    f = leadingWS(fileLines[pos]!);
    p = leadingWS(oLines[0]!);
  }
  for (const it of items) {
    if (it.kind === ' ') { out.push(fileLines[pos + oi]!); oi++; }
    else if (it.kind === '-') { oi++; }
    else if (it.kind === '+') {
      let t = it.text;
      if (tier === 2 && oLines.length > 0 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** Split a hunk/chunk body into its O lines and its N items (context and '+' lines). */
function splitBody(items: BodyItem[]): { o: string[]; nItems: BodyItem[] } {
  const o: string[] = [];
  const nItems: BodyItem[] = [];
  for (const it of items) {
    if (it.kind === ' ') { o.push(it.text); nItems.push(it); }
    else if (it.kind === '-') { o.push(it.text); nItems.push(it); }
    else if (it.kind === '+') { nItems.push(it); }
  }
  return { o, nItems };
}

/* ---- section 6: unified diffs ---- */

interface Hunk { a: number; items: BodyItem[]; noNL: boolean }

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return m ? parseInt(m[1]!, 10) : null;
}

function parseHunk(lines: string[], start: number): { hunk: Hunk; next: number } {
  const a = parseHunkHeader(lines[start]!)!;
  const items: BodyItem[] = [];
  let i = start + 1;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') { items.push({ kind: ' ', text: '' }); i++; continue; }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') { items.push({ kind: c, text: l.slice(1) }); i++; continue; }
    break;
  }
  while (items.length > 0 && items[items.length - 1]!.kind === ' ' && items[items.length - 1]!.text === '') items.pop();
  let noNL = false;
  let lastCP = -1;
  items.forEach((it, k) => { if (it.kind === ' ' || it.kind === '+') lastCP = k; });
  if (lastCP >= 0 && items[lastCP + 1]?.kind === '\\') noNL = true;
  return { hunk: { a, items, noNL }, next: i };
}

/** The path after `--- ` / `+++ `: up to the first tab, trimmed, leading a/ or b/ removed. */
function parseDashPath(l: string): string {
  let p = l.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

function applyHunks(origText: string, hunks: Hunk[], strict: boolean, failPath: string): { lines: string[]; br: string; finalBreak: boolean } {
  let { lines, br, finalBreak } = fileParts(origText);
  let d = 0;
  for (const h of hunks) {
    const { o, nItems } = splitBody(h.items);
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = at === lines.length;
      const repl = buildReplacement(nItems, o, lines, at, 0);
      lines = [...lines.slice(0, at), ...repl, ...lines.slice(at)];
      if (atEnd) finalBreak = !h.noNL;
      d += repl.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (!found) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const touchesEnd = best + o.length === lines.length;
    const repl = buildReplacement(nItems, o, lines, best, found.tier);
    lines = [...lines.slice(0, best), ...repl, ...lines.slice(best + o.length)];
    if (touchesEnd) finalBreak = !h.noNL;
    d += repl.length - o.length;
  }
  return { lines, br, finalBreak };
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath === '/dev/null' ? null : sec.oldPath;
    const newP = sec.newPath === '/dev/null' ? null : sec.newPath;
    // Section 10: every path the edit names is checked for safety before anything else.
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreation = sec.creation || oldP === null;
    const isDeletion = !isCreation && (sec.deletion || newP === null);
    if (isCreation) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === '+') plus.push(it.text);
      let fb = true;
      if (plus.length === 0) fb = false;
      else {
        let lh = -1;
        let li = -1;
        sec.hunks.forEach((h, hi) => h.items.forEach((it, ii) => { if (it.kind === '+') { lh = hi; li = ii; } }));
        fb = !(sec.hunks[lh]!.items[li! + 1]?.kind === '\\');
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (fb ? '\n' : ''));
      return;
    }
    if (isDeletion) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    // oldP and newP are both non-null paths here.
    const oldPath = oldP!;
    const newPath = newP!;
    if (oldPath !== newPath) {
      const orig = tree.get(oldPath);
      if (orig === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const res = applyHunks(orig, sec.hunks, strict, oldPath);
      tree.now.set(newPath, joinFile(res.lines, res.br, res.finalBreak));
      tree.now.set(oldPath, null);
      moves.push([oldPath, newPath]);
      return;
    }
    const orig = tree.get(oldPath);
    if (orig === null) throw new Fail('missing', oldPath);
    const res = applyHunks(orig, sec.hunks, strict, oldPath);
    tree.now.set(oldPath, joinFile(res.lines, res.br, res.finalBreak));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, creation: false, deletion: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('@@')) {
        const a = parseHunkHeader(l);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        const r = parseHunk(lines, i);
        cur.hunks.push(r.hunk);
        inHeader = false;
        i = r.next;
        continue;
      }
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.oldPath = parseDashPath(l);
          cur.newPath = parseDashPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) { cur.oldPath = l.slice(12).trim(); i++; continue; }
      if (l.startsWith('rename to ')) { cur.newPath = l.slice(10).trim(); i++; continue; }
      if (l === 'new file mode' || l.startsWith('new file mode ')) { cur.creation = true; i++; continue; }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) { cur.deletion = true; i++; continue; }
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = { oldPath: parseDashPath(l), newPath: parseDashPath(lines[i + 1]!), creation: false, deletion: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = parseHunkHeader(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunk(lines, i);
      cur.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i++;
  }
  return sections.map((sec) => sectionEdit(sec, strict));
}

/* ---- section 7: SEARCH/REPLACE blocks ---- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: { path: string; old: string[]; nw: string[] }[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let j = s + 1;
    while (j < n && lines[j]!.trimEnd() !== '=======') {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${s + 1}`);
      j++;
    }
    if (j >= n) throw new Exit2(`error: parse ${s + 1}`);
    let k = j + 1;
    while (k < n && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${s + 1}`);
      k++;
    }
    if (k >= n) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, old: lines.slice(s + 1, j), nw: lines.slice(j + 1, k) });
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  return blocks.map((b) => (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const orig = tree.get(b.path);
    if (orig === null) throw new Fail('missing', b.path);
    const { lines: fl, br, finalBreak } = fileParts(orig);
    const found = findTier(fl, b.old, strict);
    if (!found) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const items: BodyItem[] = b.nw.map((t) => ({ kind: '+' as const, text: t }));
    const repl = buildReplacement(items, b.old, fl, pos, found.tier);
    const out = [...fl.slice(0, pos), ...repl, ...fl.slice(pos + b.old.length)];
    tree.now.set(b.path, joinFile(out, br, finalBreak));
  });
}

/* ---- section 8: V4A patches ---- */

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOV = '*** Move to: ';

function isV4ASectionStart(l: string): boolean {
  return l.startsWith(V4A_ADD) || l.startsWith(V4A_DEL) || l.startsWith(V4A_UPD);
}

function isV4ABodyLine(t: string): boolean {
  return t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+');
}

interface V4AChunk { anchor: string | null; items: BodyItem[]; eof: boolean }

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let idx = first + 1;
  while (idx < last) {
    const l = lines[idx]!;
    if (blank(l)) { idx++; continue; }
    if (l.startsWith(V4A_ADD)) {
      const path = l.slice(V4A_ADD.length).trim();
      idx++;
      const raw: { text: string; no: number }[] = [];
      while (idx < last && !isV4ASectionStart(lines[idx]!)) { raw.push({ text: lines[idx]!, no: idx + 1 }); idx++; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith(V4A_DEL)) {
      const path = l.slice(V4A_DEL.length).trim();
      idx++;
      const raw: { text: string; no: number }[] = [];
      while (idx < last && !isV4ASectionStart(lines[idx]!)) { raw.push({ text: lines[idx]!, no: idx + 1 }); idx++; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      for (const r of raw) throw new Exit2(`error: parse ${r.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (l.startsWith(V4A_UPD)) {
      const path = l.slice(V4A_UPD.length).trim();
      const updNo = idx + 1;
      idx++;
      const raw: { text: string; no: number }[] = [];
      while (idx < last && !isV4ASectionStart(lines[idx]!)) { raw.push({ text: lines[idx]!, no: idx + 1 }); idx++; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let p = 0;
      let moveTo: string | null = null;
      if (raw.length > 0 && raw[0]!.text.startsWith(V4A_MOV)) {
        moveTo = raw[0]!.text.slice(V4A_MOV.length).trim();
        p = 1;
      }
      const chunks: V4AChunk[] = [];
      let firstChunk = true;
      while (p < raw.length) {
        const cur = raw[p]!;
        if (cur.text === '*** End of File') {
          if (chunks.length === 0) throw new Exit2(`error: parse ${cur.no}`);
          chunks[chunks.length - 1]!.eof = true;
          p++;
          while (p < raw.length && blank(raw[p]!.text)) p++;
          continue;
        }
        if (cur.text.startsWith('@@')) {
          const anchor = cur.text.slice(2).trim();
          p++;
          const items: BodyItem[] = [];
          while (p < raw.length && isV4ABodyLine(raw[p]!.text)) {
            const t = raw[p]!.text;
            items.push(t === '' ? { kind: ' ', text: '' } : { kind: t[0]! as ' ' | '-' | '+', text: t.slice(1) });
            p++;
          }
          chunks.push({ anchor, items, eof: false });
          firstChunk = false;
          continue;
        }
        if (isV4ABodyLine(cur.text)) {
          if (!firstChunk) throw new Exit2(`error: parse ${cur.no}`);
          const items: BodyItem[] = [];
          while (p < raw.length && isV4ABodyLine(raw[p]!.text)) {
            const t = raw[p]!.text;
            items.push(t === '' ? { kind: ' ', text: '' } : { kind: t[0]! as ' ' | '-' | '+', text: t.slice(1) });
            p++;
          }
          chunks.push({ anchor: null, items, eof: false });
          firstChunk = false;
          continue;
        }
        throw new Exit2(`error: parse ${cur.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updNo}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const orig = tree.get(path);
        if (orig === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        let { lines: fl, br, finalBreak } = fileParts(orig);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null && ch.anchor !== '') {
            const found = findTier(fl, [ch.anchor], strict, cursor);
            if (!found) throw new Fail('no-match', path);
            cursor = found.occ[0]! + 1;
          }
          const { o, nItems } = splitBody(ch.items);
          if (o.length === 0) {
            const at = ch.eof ? fl.length : cursor;
            const repl = buildReplacement(nItems, o, fl, at, 0);
            fl = [...fl.slice(0, at), ...repl, ...fl.slice(at)];
            cursor = at + repl.length;
            continue;
          }
          const found = findTier(fl, o, strict, cursor);
          if (!found) throw new Fail('no-match', path);
          let occ = found.occ;
          if (ch.eof) occ = occ.filter((pp) => pp + o.length === fl.length);
          if (occ.length === 0) throw new Fail('no-match', path);
          const pos = occ[0]!;
          const repl = buildReplacement(nItems, o, fl, pos, found.tier);
          fl = [...fl.slice(0, pos), ...repl, ...fl.slice(pos + o.length)];
          cursor = pos + repl.length;
        }
        const out = joinFile(fl, br, finalBreak);
        if (moveTo !== null) {
          tree.now.set(moveTo, out);
          tree.now.set(path, null);
          moves.push([path, moveTo]);
        } else {
          tree.now.set(path, out);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  return edits;
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rowMap = new Map<string, { key: string; text: string }>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowMap.set(p, { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of moves) {
    const dRow = rowMap.get(oldP);
    const aRow = rowMap.get(newP);
    if (dRow !== undefined && dRow.text.startsWith('D ') && aRow !== undefined && aRow.text.startsWith('A ')) {
      rowMap.delete(oldP);
      rowMap.delete(newP);
      rowMap.set(`R:${newP}`, { key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  const rows = [...rowMap.values()].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key))).map((r) => r.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
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
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
