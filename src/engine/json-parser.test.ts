import { describe, expect, test } from "bun:test";
import {
  extractFirstJsonObject,
  parseJsonFromModelOutput,
} from "./json-parser";

describe("json-parser", () => {
  describe("extractFirstJsonObject", () => {
    test("extracts direct object", () => {
      const input = '{"key": "value"}';
      expect(extractFirstJsonObject(input)).toBe('{"key": "value"}');
    });

    test("extracts object from surrounding text", () => {
      const input = 'Here is the result: {"key": "value"} and more text.';
      expect(extractFirstJsonObject(input)).toBe('{"key": "value"}');
    });

    test("handles nested objects", () => {
      const input = '{"outer": {"inner": 123}}';
      expect(extractFirstJsonObject(input)).toBe('{"outer": {"inner": 123}}');
    });

    test("handles strings with braces", () => {
      const input = '{"key": "value with } brace"}';
      expect(extractFirstJsonObject(input)).toBe(
        '{"key": "value with } brace"}',
      );
    });

    test("handles escaped quotes in strings", () => {
      const input = '{"key": "value with \\" quote"}';
      expect(extractFirstJsonObject(input)).toBe(
        '{"key": "value with \\" quote"}',
      );
    });

    test("returns null if no object found", () => {
      const input = "No JSON here.";
      expect(extractFirstJsonObject(input)).toBeNull();
    });
  });

  describe("parseJsonFromModelOutput", () => {
    test("parses direct JSON", () => {
      const input = '{"a": 1}';
      expect(parseJsonFromModelOutput<{ a: number }>(input)).toEqual({ a: 1 });
    });

    test("parses fenced JSON", () => {
      const input = "```json\n" + '{"a": 2}\n' + "```";
      expect(parseJsonFromModelOutput<{ a: number }>(input)).toEqual({ a: 2 });
    });

    test("parses fenced JSON without language tag", () => {
      const input = "```\n" + '{"a": 3}\n' + "```";
      expect(parseJsonFromModelOutput<{ a: number }>(input)).toEqual({ a: 3 });
    });

    test("parses extracted JSON object", () => {
      const input = 'The answer is: {"a": 4} Hope that helps.';
      expect(parseJsonFromModelOutput<{ a: number }>(input)).toEqual({ a: 4 });
    });

    test("throws on empty output", () => {
      expect(() => parseJsonFromModelOutput("   ")).toThrow(
        "Model output is empty.",
      );
    });

    test("throws on invalid JSON", () => {
      const input = '{"a": 1';
      expect(() => parseJsonFromModelOutput(input)).toThrow(
        "Model output is not valid JSON.",
      );
    });

    test("uses custom error message", () => {
      const input = "invalid";
      expect(() => parseJsonFromModelOutput(input, "Custom error.")).toThrow(
        "Custom error.",
      );
    });

    test("handles generic type parameter", () => {
      interface MyType {
        foo: string;
      }
      const input = '{"foo": "bar"}';
      const result = parseJsonFromModelOutput<MyType>(input);
      expect(result.foo).toBe("bar");
    });
  });
});
