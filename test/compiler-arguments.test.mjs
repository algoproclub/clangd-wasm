import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCompilerArguments,
  tokenizeCompilerArguments,
} from "../lib/compiler-arguments.js";

test("tokenizes quoted, escaped, empty, and adjacent compiler arguments", () => {
  assert.deepEqual(
    tokenizeCompilerArguments(
      `-DNAME="Ada Lovelace" '-DMESSAGE=hello world' -Ipath\\ with\\ spaces "" pre"mid"post`,
    ),
    [
      "-DNAME=Ada Lovelace",
      "-DMESSAGE=hello world",
      "-Ipath with spaces",
      "",
      "premidpost",
    ],
  );
});

test("keeps shell expansion syntax literal", () => {
  assert.deepEqual(tokenizeCompilerArguments("-DHOME=$HOME *.cpp #literal"), [
    "-DHOME=$HOME",
    "*.cpp",
    "#literal",
  ]);
});

test("rejects incomplete quoted or escaped arguments", () => {
  assert.throws(() => tokenizeCompilerArguments(`"unfinished`), /unterminated/);
  assert.throws(() => tokenizeCompilerArguments("unfinished\\"), /escape/);
});

test("copies pre-tokenized arguments", () => {
  const input = ["-DNAME=Ada Lovelace", "-Wall"];
  const normalized = normalizeCompilerArguments(input);
  assert.deepEqual(normalized, input);
  assert.notEqual(normalized, input);
});
