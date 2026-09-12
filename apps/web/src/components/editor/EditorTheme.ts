import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** CodeMirror 6 highlight theme mapped to the app's palette (mirrors the
 *  `.mdcode` hljs colors in theme.css). CM6 doesn't use hljs classes.
 *
 *  Colors are `var(--color-x)` references, not literal hex: HighlightStyle
 *  just writes these strings into generated CSS rules, so a CSS custom
 *  property resolves at paint time against whatever theme is active — this
 *  extension never needs rebuilding when the light/dark theme toggles. */
export const editorTheme = HighlightStyle.define([
  // keywords / control flow
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.meta, t.macroName, t.name], color: 'var(--color-info)' },
  // strings / attributes / regex
  { tag: [t.string, t.special(t.string), t.regexp, t.escape, t.attributeName, t.attributeValue], color: 'var(--color-ok)' },
  // numbers / literals / booleans / constants
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit, t.literal], color: 'var(--color-warn)' },
  // function names / definitions / headings
  { tag: [t.function(t.variableName), t.definition(t.function(t.name)), t.function(t.propertyName), t.definition(t.name), t.heading], color: 'var(--color-accent)' },
  // types / classes / namespaces
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--color-info)' },
  // comments / quotes
  { tag: [t.comment, t.blockComment, t.lineComment, t.quote, t.docComment], color: 'var(--color-faint)', fontStyle: 'italic' },
  // identifiers
  { tag: [t.variableName, t.attributeName, t.propertyName, t.definition(t.variableName)], color: 'var(--color-ink)' },
  // markup tag names / brackets
  { tag: [t.tagName, t.angleBracket], color: 'var(--color-mute)' },
  // andColor / bracket / punctuation → default (left unstyled)
  { tag: [t.invalid], color: 'var(--color-danger)' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: 'bold' },
  { tag: [t.link, t.url], textDecoration: 'underline' },
]);
