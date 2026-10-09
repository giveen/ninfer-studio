import { describe, expect, it } from 'vitest';
import { structuredOutputFields } from './chat';

describe('structuredOutputFields', () => {
  it('emits nothing when unset', () => {
    expect(structuredOutputFields(undefined)).toEqual({});
  });

  it('maps JSON object mode onto response_format', () => {
    expect(structuredOutputFields({ mode: 'json_object' })).toEqual({
      response_format: { type: 'json_object' },
    });
  });

  it('maps JSON schema mode, parsing the schema text', () => {
    const fields = structuredOutputFields({
      mode: 'json_schema',
      name: 'answer',
      schema: '{"type":"object","properties":{"n":{"type":"integer"}},"additionalProperties":false}',
      strict: true,
    });
    expect(fields).toEqual({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          schema: { type: 'object', properties: { n: { type: 'integer' } }, additionalProperties: false },
          strict: true,
        },
      },
    });
  });

  it('omits strict when not requested and defaults the name', () => {
    const fields = structuredOutputFields({ mode: 'json_schema', name: '  ', schema: '{"type":"object"}' });
    expect(fields).toEqual({
      response_format: { type: 'json_schema', json_schema: { name: 'response', schema: { type: 'object' } } },
    });
  });

  it('drops a schema that is not parseable JSON or has a non-object root', () => {
    expect(structuredOutputFields({ mode: 'json_schema', name: 'x', schema: '{ not json' })).toEqual({});
    expect(structuredOutputFields({ mode: 'json_schema', name: 'x', schema: '' })).toEqual({});
    expect(structuredOutputFields({ mode: 'json_schema', name: 'x', schema: '42' })).toEqual({});
    expect(structuredOutputFields({ mode: 'json_schema', name: 'x', schema: 'null' })).toEqual({});
  });

  it('maps grammar, choice and regex onto the structured_outputs extension', () => {
    expect(structuredOutputFields({ mode: 'grammar', grammar: 'root ::= "yes" | "no"' })).toEqual({
      structured_outputs: { grammar: 'root ::= "yes" | "no"' },
    });
    expect(structuredOutputFields({ mode: 'choice', choices: ['positive', 'neutral'] })).toEqual({
      structured_outputs: { choice: ['positive', 'neutral'] },
    });
    expect(structuredOutputFields({ mode: 'regex', pattern: '(BUG|TASK)-[0-9]{4}' })).toEqual({
      structured_outputs: { regex: '(BUG|TASK)-[0-9]{4}' },
    });
  });

  it('drops an empty grammar, an empty choice list and permits an empty regex', () => {
    expect(structuredOutputFields({ mode: 'grammar', grammar: '   ' })).toEqual({});
    expect(structuredOutputFields({ mode: 'choice', choices: [] })).toEqual({});
    // An empty regex is meaningful: it permits only empty content.
    expect(structuredOutputFields({ mode: 'regex', pattern: '' })).toEqual({
      structured_outputs: { regex: '' },
    });
    // An empty-string candidate is likewise meaningful.
    expect(structuredOutputFields({ mode: 'choice', choices: [''] })).toEqual({
      structured_outputs: { choice: [''] },
    });
  });
});
