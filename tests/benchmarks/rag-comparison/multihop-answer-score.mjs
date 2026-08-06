function normalizeAnswer(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase()
    .replace(/\bthe answer is\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ").trim()
    .replace(/^(?:the|a|an)\s+/, "");
}

export function answerCorrect(predicted, gold) {
  const prediction = normalizeAnswer(predicted);
  const expected = normalizeAnswer(gold);
  if (!prediction || !expected) return false;
  if (prediction === expected) return true;
  return ` ${prediction} `.includes(` ${expected} `);
}
