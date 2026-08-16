<p align="center">
  <img src="assets/fragrach-logo-answerer.png" alt="Fragrach — The Answerer" width="360">
</p>

# Fragrach

Fragrach compiles source documents into evidence-preserving Knowledge Builds before they are ingested into a RAG system.

The name comes from Fragarach, also spelled Freagarthach, the Irish mythological sword called [“The Answerer”](https://archive.org/details/godsfightingmens00gregrich/page/22/mode/2up). Modern accounts describe it as compelling truthful answers; Fragrach applies that image to answers grounded in document validity and evidence. The mythological name and the project name use different spellings.

```console
npx fragarach --help
```

This package is the Node.js launcher. The Rust executable is supplied by an optional platform-specific package.

Version 0.1.0 is a development package and has not yet been published to the npm registry. It requires Node.js 18 or later. Claim extraction also requires a running Ollama server and an installed model.

Fragrach is not a vector database or a chat application. Use `fragarach export` to produce evidence-preserving JSONL for a downstream RAG system.
