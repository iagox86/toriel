import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchModel, modelProblem } from "../src/model-match.ts";

const models = [
  { provider: "anthropic", id: "claude-opus-5" },
  { provider: "anthropic", id: "claude-sonnet-5" },
  { provider: "litellm", id: "gemma4:12b" },
  { provider: "other", id: "claude-sonnet-5" },
];

describe("matchModel", () => {
  it("takes an exact provider/id even when the bare id exists elsewhere", () => {
    assert.deepEqual(matchModel(models, "other/claude-sonnet-5"), { kind: "one", model: models[3] });
  });

  it("takes a bare id that is unique", () => {
    assert.deepEqual(matchModel(models, "gemma4:12b"), { kind: "one", model: models[2] });
  });

  it("matches words anywhere, in any case, when only one model fits", () => {
    assert.deepEqual(matchModel(models, "OPUS"), { kind: "one", model: models[0] });
    assert.deepEqual(matchModel(models, "litellm gemma"), { kind: "one", model: models[2] });
  });

  it("reports every candidate when the words are ambiguous", () => {
    const r = matchModel(models, "claude-sonnet");
    assert.equal(r.kind, "many");
    assert.equal(r.kind === "many" && r.matches.length, 2);
  });

  it("reports nothing for an empty or unmatched query", () => {
    assert.deepEqual(matchModel(models, "  "), { kind: "none" });
    assert.deepEqual(matchModel(models, "gpt"), { kind: "none" });
  });
});

describe("modelProblem", () => {
  const models = [
    { provider: "litellm", id: "gemma4:12b" },
    { provider: "litellm", id: "glm-5.3-flash" },
    { provider: "zai", id: "glm-5.3-flash" },
  ];

  it("accepts only an exact provider/id", () => {
    assert.equal(modelProblem(models, "litellm/gemma4:12b"), undefined);
    assert.match(modelProblem(models, "gemma4:12b") ?? "", /no model "gemma4:12b"/);
  });

  it("names the closest models, matching on the id when the provider is wrong", () => {
    assert.match(modelProblem(models, "other/glm-5.3-flash") ?? "", /did you mean litellm\/glm-5\.3-flash, zai\/glm-5\.3-flash\?/);
    assert.match(modelProblem(models, "litellm/gemma") ?? "", /did you mean litellm\/gemma4:12b\?/);
  });

  it("suggests the model for a mistyped name", () => {
    assert.match(modelProblem(models, "litellm/gemma4:12bb") ?? "", /did you mean litellm\/gemma4:12b\?/);
    assert.match(modelProblem(models, "litellm/glm-5.3-flsh") ?? "", /did you mean litellm\/glm-5\.3-flash/);
  });

  it("says what pi does have when nothing is close", () => {
    assert.match(modelProblem(models, "nonsense/zzz") ?? "", /pi has 3 models, from litellm, zai/);
  });
});
