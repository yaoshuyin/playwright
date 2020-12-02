/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as css from './cssTokenizer';

type ClauseCombinator = '' | '>' | '+' | '~';
// TODO: consider
//   - key=value
//   - operators like `=`, `|=`, `~=`, `*=`, `/`
//   - <empty>~=value
export type CSSFunctionArgument = CSSComplexSelector | number | string;
export type CSSFunction = { name: string, args: CSSFunctionArgument[] };
export type CSSSimpleSelector = { css?: string, functions: CSSFunction[] };
export type CSSComplexSelector = { simple: { selector: CSSSimpleSelector, combinator: ClauseCombinator }[] };
export type CSSSelectorList = CSSComplexSelector[];

export function parseCSS(selector: string): CSSSelectorList {
  let tokens: css.CSSTokenInterface[];
  try {
    tokens = css.tokenize(selector);
    if (!(tokens[tokens.length - 1] instanceof css.EOFToken))
      tokens.push(new css.EOFToken());
  } catch (e) {
    const newMessage = e.message + ` while parsing selector "${selector}"`;
    const index = (e.stack || '').indexOf(e.message);
    if (index !== -1)
      e.stack = e.stack.substring(0, index) + newMessage + e.stack.substring(index + e.message.length);
    e.message = newMessage;
    throw e;
  }
  const unsupportedToken = tokens.find(token => {
    return (token instanceof css.AtKeywordToken) ||
      (token instanceof css.BadStringToken) ||
      (token instanceof css.BadURLToken) ||
      (token instanceof css.ColumnToken) ||
      (token instanceof css.CDOToken) ||
      (token instanceof css.CDCToken) ||
      (token instanceof css.SemicolonToken) ||
      // TODO: Consider using these for something, e.g. to escape complex strings.
      // For example :xpath{ (//div/bar[@attr="foo"])[2]/baz }
      // Or this way :xpath( {complex-xpath-goes-here("hello")} )
      (token instanceof css.OpenCurlyToken) ||
      (token instanceof css.CloseCurlyToken) ||
      // TODO: Consider treating these as strings?
      (token instanceof css.URLToken) ||
      (token instanceof css.PercentageToken);
  });
  if (unsupportedToken)
    throw new Error(`Unsupported token "${unsupportedToken.toSource()}" while parsing selector "${selector}"`);

  let pos = 0;

  function unexpected() {
    return new Error(`Unexpected token "${tokens[pos].toSource()}" while parsing selector "${selector}"`);
  }

  function skipWhitespace() {
    while (tokens[pos] instanceof css.WhitespaceToken)
      pos++;
  }

  function isIdent(p = pos) {
    return tokens[p] instanceof css.IdentToken;
  }

  function isString(p = pos) {
    return tokens[p] instanceof css.StringToken;
  }

  function isNumber(p = pos) {
    return tokens[p] instanceof css.NumberToken;
  }

  function isComma(p = pos) {
    return tokens[p] instanceof css.CommaToken;
  }

  function isCloseParen(p = pos) {
    return tokens[p] instanceof css.CloseParenToken;
  }

  function isStar(p = pos) {
    return (tokens[p] instanceof css.DelimToken) && tokens[p].value === '*';
  }

  function isEOF(p = pos) {
    return tokens[p] instanceof css.EOFToken;
  }

  function isClauseCombinator(p = pos) {
    return (tokens[p] instanceof css.DelimToken) && (['>', '+', '~'].includes(tokens[p].value));
  }

  function isSelectorClauseEnd(p = pos) {
    return isComma(p) || isCloseParen(p) || isEOF(p) || isClauseCombinator(p) || (tokens[p] instanceof css.WhitespaceToken);
  }

  function consumeFunctionArguments(): CSSFunctionArgument[] {
    const result = [consumeArgument()];
    while (true) {
      skipWhitespace();
      if (!isComma())
        break;
      pos++;
      result.push(consumeArgument());
    }
    return result;
  }

  function consumeArgument(): CSSFunctionArgument {
    skipWhitespace();
    if (isNumber())
      return tokens[pos++].value;
    if (isString())
      return tokens[pos++].value;
    return consumeComplexSelector();
  }

  function consumeComplexSelector(): CSSComplexSelector {
    skipWhitespace();
    const result = { simple: [{ selector: consumeSimpleSelector(), combinator: '' as ClauseCombinator }] };
    while (true) {
      skipWhitespace();
      if (isClauseCombinator()) {
        result.simple[result.simple.length - 1].combinator = tokens[pos++].value as ClauseCombinator;
        skipWhitespace();
      } else if (isSelectorClauseEnd()) {
        break;
      }
      result.simple.push({ combinator: '', selector: consumeSimpleSelector() });
    }
    return result;
  }

  function consumeSimpleSelector(): CSSSimpleSelector {
    let rawCSSString = '';
    const functions: CSSFunction[] = [];

    while (!isSelectorClauseEnd()) {
      if (isIdent() || isStar()) {
        rawCSSString += tokens[pos++].toSource();
      } else if (tokens[pos] instanceof css.HashToken) {
        rawCSSString += tokens[pos++].toSource();
      } else if ((tokens[pos] instanceof css.DelimToken) && tokens[pos].value === '.') {
        pos++;
        if (isIdent())
          rawCSSString += '.' + tokens[pos++].toSource();
        else
          throw unexpected();
      } else if (tokens[pos] instanceof css.ColonToken) {
        pos++;
        if (isIdent()) {
          if (builtinCSSFilters.has(tokens[pos].value))
            rawCSSString += ':' + tokens[pos++].toSource();
          else
            functions.push({ name: tokens[pos++].value, args: [] });
        } else if (tokens[pos] instanceof css.FunctionToken) {
          const name = tokens[pos++].value;
          if (builtinCSSFunctions.has(name))
            rawCSSString += `:${name}(${consumeBuiltinFunctionArguments()})`;
          else
            functions.push({ name, args: consumeFunctionArguments() });
          skipWhitespace();
          if (!isCloseParen())
            throw unexpected();
          pos++;
        } else {
          throw unexpected();
        }
      } else if (tokens[pos] instanceof css.OpenSquareToken) {
        rawCSSString += '[';
        pos++;
        while (!(tokens[pos] instanceof css.CloseSquareToken) && !isEOF())
          rawCSSString += tokens[pos++].toSource();
        if (!(tokens[pos] instanceof css.CloseSquareToken))
          throw unexpected();
        rawCSSString += ']';
        pos++;
      } else {
        throw unexpected();
      }
    }
    if (!rawCSSString && !functions.length)
      throw unexpected();
    return { css: rawCSSString || undefined, functions };
  }

  function consumeBuiltinFunctionArguments(): string {
    let s = '';
    while (!isCloseParen() && !isEOF())
      s += tokens[pos++].toSource();
    return s;
  }

  const result = consumeFunctionArguments();
  if (!isEOF())
    throw new Error(`Error while parsing selector "${selector}"`);
  if (result.some(arg => typeof arg !== 'object' || !('simple' in arg)))
    throw new Error(`Error while parsing selector "${selector}"`);
  return result as CSSComplexSelector[];
}

export function serializeSelector(args: CSSFunctionArgument[]) {
  return args.map(arg => {
    if (typeof arg === 'string')
      return `"${arg}"`;
    if (typeof arg === 'number')
      return String(arg);
    return arg.simple.map(({ selector, combinator }) => {
      let s = selector.css || '';
      s = s + selector.functions.map(func => `:${func.name}(${serializeSelector(func.args)})`).join('');
      if (combinator)
        s += ' ' + combinator;
      return s;
    }).join(' ');
  }).join(', ');
}

const builtinCSSFilters = new Set([
  'active', 'any-link', 'checked', 'blank', 'default', 'defined',
  'disabled', 'empty', 'enabled', 'first', 'first-child', 'first-of-type',
  'fullscreen', 'focus', 'focus-visible', 'focus-within', 'hover',
  'indeterminate', 'in-range', 'invalid', 'last-child', 'last-of-type',
  'link', 'only-child', 'only-of-type', 'optional', 'out-of-range', 'placeholder-shown',
  'read-only', 'read-write', 'required', 'root', 'target', 'valid', 'visited',
]);

const builtinCSSFunctions = new Set([
  'dir', 'lang', 'nth-child', 'nth-last-child', 'nth-last-of-type', 'nth-of-type',
]);