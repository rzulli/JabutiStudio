import { StreamLanguage, type StringStream } from '@codemirror/language'

/**
 * Syntax HIGHLIGHTING for Godot files (GDScript, .tscn, .tres). These are
 * token-level stream tokenizers on CodeMirror's own StreamLanguage: no AST,
 * no scope analysis, no type resolution. They colour what a token looks like;
 * they do not know what it means.
 */

const GD_KEYWORDS = new Set([
  'extends', 'class_name', 'class', 'func', 'signal', 'var', 'const', 'static', 'enum',
  'if', 'elif', 'else', 'for', 'while', 'match', 'when', 'break', 'continue', 'pass', 'return',
  'await', 'in', 'is', 'as', 'and', 'or', 'not', 'preload', 'yield', 'super', 'set', 'get', 'assert', 'breakpoint',
])
const GD_ATOMS = new Set(['true', 'false', 'null', 'self', 'PI', 'TAU', 'INF', 'NAN'])
const GD_BUILTIN_TYPES = new Set(['int', 'float', 'bool', 'void', 'Variant'])

interface GdState { afterDef: 'func' | 'var' | 'signal' | 'class' | null; tripleQuote: string | null }

function readString(stream: StringStream, quote: string): void {
  let escaped = false
  let ch: string | void
  while ((ch = stream.next()) != null) {
    if (ch === quote && !escaped) return
    escaped = !escaped && ch === '\\'
  }
}

export const gdscript = StreamLanguage.define<GdState>({
  name: 'gdscript',
  startState: () => ({ afterDef: null, tripleQuote: null }),
  languageData: { commentTokens: { line: '#' }, closeBrackets: { brackets: ['(', '[', '{', '"', "'"] } },
  token(stream, state) {
    if (state.tripleQuote) {
      while (!stream.eol()) {
        if (stream.match(state.tripleQuote)) { state.tripleQuote = null; break }
        stream.next()
      }
      return 'string'
    }
    if (stream.eatSpace()) return null
    if (stream.peek() === '#') { stream.skipToEnd(); return 'comment' }
    if (stream.match('"""') || stream.match("'''")) {
      state.tripleQuote = stream.current().slice(-3)
      while (!stream.eol()) {
        if (stream.match(state.tripleQuote)) { state.tripleQuote = null; break }
        stream.next()
      }
      return 'string'
    }
    // String name (&"x"), node path (^"x") and plain strings.
    if (stream.match(/^[&^]?(?=["'])/)) { /* prefix eaten, string follows */ }
    const q = stream.peek()
    if (q === '"' || q === "'") { stream.next(); readString(stream, q); return 'string' }
    if (stream.match(/^@[A-Za-z_]\w*/)) return 'meta' // @export, @onready, @export_range...
    // $Child/Path and %UniqueName node shortcuts.
    if (stream.match(/^[$%]("[^"]*"|[A-Za-z_][\w/]*)/)) return 'atom'
    if (stream.match(/^(0x[0-9a-fA-F_]+|0b[01_]+|(\d[\d_]*)?\.?\d[\d_]*([eE][+-]?\d+)?)/)) return 'number'
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const w = stream.current()
      const def = state.afterDef
      state.afterDef = null
      if (def === 'func' || def === 'signal') return 'def'
      if (def === 'var') return 'def'
      if (def === 'class') return 'typeName'
      if (GD_KEYWORDS.has(w)) {
        if (w === 'func') state.afterDef = 'func'
        else if (w === 'signal') state.afterDef = 'signal'
        else if (w === 'class' || w === 'class_name' || w === 'extends') state.afterDef = 'class'
        return 'keyword'
      }
      if (w === 'var' || w === 'const') { state.afterDef = 'var'; return 'keyword' }
      if (GD_ATOMS.has(w)) return 'atom'
      if (GD_BUILTIN_TYPES.has(w) || /^[A-Z][A-Za-z0-9]*$/.test(w) && !/^[A-Z0-9_]+$/.test(w)) return 'typeName'
      if (/^[A-Z][A-Z0-9_]+$/.test(w)) return 'atom' // CONSTANT_NAMES
      if (stream.match(/^(?=\s*\()/)) return 'variableName.function'
      return 'variableName'
    }
    if (stream.match(/^(->|[+\-*/%&|^<>=!]=?|<<|>>|\*\*|:=)/)) return 'operator'
    stream.next()
    return null
  },
  indent: () => null,
  tokenTable: undefined,
})

// ── .tscn / .tres ────────────────────────────────────────────────

interface TresState { inHeader: boolean; atLineStart: boolean }

const TRES_REF = new Set(['ExtResource', 'SubResource', 'NodePath', 'Object', 'Resource'])

export const godotResource = StreamLanguage.define<TresState>({
  name: 'godot-resource',
  startState: () => ({ inHeader: false, atLineStart: true }),
  languageData: { commentTokens: { line: ';' } },
  token(stream, state) {
    if (stream.sol()) { state.atLineStart = true; if (!state.inHeader) { /* new line, new statement */ } }
    if (stream.eatSpace()) return null
    const lineStart = state.atLineStart
    state.atLineStart = false
    if (stream.peek() === ';') { stream.skipToEnd(); return 'comment' }

    // [gd_scene format=3 uid="uid://..."], [ext_resource ...], [node name=... parent=...]
    if (lineStart && stream.peek() === '[') {
      stream.next()
      state.inHeader = true
      stream.match(/^[a-z_]+/)
      return 'keyword'
    }
    if (state.inHeader) {
      if (stream.peek() === ']') { stream.next(); state.inHeader = false; return 'keyword' }
      if (stream.match(/^[A-Za-z_][\w]*(?==)/)) return 'attributeName'
    } else if (lineStart && stream.match(/^[A-Za-z_][\w./:\-/]*(?=\s*=)/)) {
      return 'propertyName' // metadata/foo, script, position, ...
    }

    const q = stream.peek()
    if (q === '"') {
      // res:// uid:// user:// are links to other files, worth telling apart.
      if (stream.match(/^"(res|uid|user):\/\/(?:[^"\\]|\\.)*"/)) return 'link'
      stream.next(); readString(stream, '"'); return 'string'
    }
    if (stream.match(/^&?"/)) { readString(stream, '"'); return 'string' }
    if (stream.match(/^-?(0x[0-9a-fA-F]+|\d+\.?\d*([eE][+-]?\d+)?|\.\d+)/)) return 'number'
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const w = stream.current()
      if (TRES_REF.has(w)) return 'keyword'
      if (w === 'true' || w === 'false' || w === 'null' || w === 'inf' || w === 'nan') return 'atom'
      if (stream.match(/^(?=\()/)) return 'typeName' // Vector2(..), Color(..), PackedStringArray(..)
      return 'variableName'
    }
    stream.next()
    return null
  },
  indent: () => null,
})
