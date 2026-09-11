import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** CodeMirror 6 highlight theme mapped to the app's palette (mirrors the
 *  `.mdcode` hljs colors in theme.css). CM6 doesn't use hljs classes. */
export const editorTheme = HighlightStyle.define([
  // keywords / control flow
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.meta, t.macroName, t.name], color: '#5cb2f0' },
  // strings / attributes / regex
  { tag: [t.string, t.special(t.string), t.regexp, t.escape, t.attributeName, t.attributeValue], color: '#59d499' },
  // numbers / literals / booleans / constants
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit, t.literal], color: '#e8b34b' },
  // function names / definitions / headings
  { tag: [t.function(t.variableName), t.definition(t.function(t.name)), t.function(t.propertyName), t.definition(t.name), t.heading], color: '#b7f04a' },
  // types / classes / namespaces
  { tag: [t.typeName, t.className, t.namespace], color: '#5cb2f0' },
  // comments / quotes
  { tag: [t.comment, t.blockComment, t.lineComment, t.quote, t.docComment], color: '#5c6577', fontStyle: 'italic' },
  // identifiers
  { tag: [t.variableName, t.attributeName, t.propertyName, t.definition(t.variableName)], color: '#e9edf5' },
  // markup tag names / brackets
  { tag: [t.tagName, t.angleBracket], color: '#8b94a7' },
  // andColor / bracket / punctuation → default (left unstyled)
  { tag: [t.invalid], color: '#f0625f' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: 'bold' },
  { tag: [t.link, t.url], textDecoration: 'underline' },
]);
