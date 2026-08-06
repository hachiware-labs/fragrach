$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$repository = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$benchmark = Join-Path $repository "target\benchmarks\enterprise-rag-bench"
$documents = Join-Path $repository "target\external\enterprise-rag-bench-data-metadata\data\documents\test.parquet"
$questions = Join-Path $benchmark "prepared-v3\questions.jsonl"
$goldDocuments = Join-Path $benchmark "prepared-v3\gold-documents.jsonl"
$bm25 = Join-Path $benchmark "bm25-v1\retrieval.jsonl"
$tantivy = Join-Path $benchmark "tantivy-bm25-v1"
$inputData = Join-Path $benchmark "ruri-chunks-512-input-v1"
$vectors = Join-Path $benchmark "ruri-chunks-512-vectors-v1"
$database = Join-Path $benchmark "lancedb-ruri-chunks-512-v1"
$flatOutput = Join-Path $benchmark "lancedb-ruri-chunks-512-flat-v1"
$dependencies = @("--with", "lancedb", "--with", "pyarrow", "--with", "numpy", "--with", "tantivy")

Set-Location $repository
if (-not (Test-Path -LiteralPath (Join-Path $inputData "manifest.json"))) {
    & uv run --with pyarrow --with transformers --with sentencepiece python `
        tests/benchmarks/rag-comparison/prepare-enterprise-rag-bench-dense-chunks.py `
        --documents $documents --output $inputData --chunk-tokens 512 --overlap-tokens 64 `
        --tokenizer ruri --shard-size 5000
    if ($LASTEXITCODE -ne 0) { throw "Chunk preparation failed with exit code $LASTEXITCODE" }
}

& node tests/benchmarks/rag-comparison/embed-enterprise-rag-bench-dense-shards.mjs `
    --input $inputData --output $vectors --questions $questions --batch-size 16 --ollama-num-batch 32768
if ($LASTEXITCODE -ne 0) { throw "Chunk embedding failed with exit code $LASTEXITCODE" }

& uv run @dependencies python tests/benchmarks/rag-comparison/build-enterprise-rag-bench-lancedb.py `
    --input $inputData --vectors $vectors --database $database --table enterprise_rag_bench_ruri_chunks_512
if ($LASTEXITCODE -ne 0) { throw "Chunk LanceDB ingestion failed with exit code $LASTEXITCODE" }

& uv run @dependencies python tests/benchmarks/rag-comparison/run-enterprise-rag-bench-lancedb.py `
    --database $database --table enterprise_rag_bench_ruri_chunks_512 --vectors $vectors `
    --questions $questions --gold-documents $goldDocuments --bm25 $bm25 --tantivy-index $tantivy `
    --output $flatOutput --mode flat --candidate-k 50 --chunk-oversample 10
if ($LASTEXITCODE -ne 0) { throw "Chunk flat evaluation failed with exit code $LASTEXITCODE" }

& uv run @dependencies python tests/benchmarks/rag-comparison/index-enterprise-rag-bench-lancedb.py `
    --database $database --table enterprise_rag_bench_ruri_chunks_512 --partitions 1024
if ($LASTEXITCODE -ne 0) { throw "Chunk ANN indexing failed with exit code $LASTEXITCODE" }

foreach ($nprobes in @(20, 80)) {
    & uv run @dependencies python tests/benchmarks/rag-comparison/run-enterprise-rag-bench-lancedb.py `
        --database $database --table enterprise_rag_bench_ruri_chunks_512 --vectors $vectors `
        --questions $questions --gold-documents $goldDocuments --bm25 $bm25 --tantivy-index $tantivy `
        --output (Join-Path $benchmark "lancedb-ruri-chunks-512-ann-p$nprobes-v1") `
        --mode ann --nprobes $nprobes --candidate-k 50 --chunk-oversample 10
    if ($LASTEXITCODE -ne 0) { throw "Chunk ANN evaluation failed for nprobes=$nprobes with exit code $LASTEXITCODE" }
}

& uv run @dependencies python tests/benchmarks/rag-comparison/select-enterprise-rag-bench-retrieval.py `
    --input $flatOutput --output (Join-Path $benchmark "strongest-chunk512-retrieval-v1")
if ($LASTEXITCODE -ne 0) { throw "Chunk retrieval selection failed with exit code $LASTEXITCODE" }
