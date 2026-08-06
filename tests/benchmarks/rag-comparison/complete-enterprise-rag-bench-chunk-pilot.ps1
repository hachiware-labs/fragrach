$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$repository = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$benchmark = Join-Path $repository "target\benchmarks\enterprise-rag-bench"
$documents = Join-Path $repository "target\external\enterprise-rag-bench-data-metadata\data\documents\test.parquet"
$questions = Join-Path $benchmark "prepared-v3\questions.jsonl"
$goldDocuments = Join-Path $benchmark "prepared-v3\gold-documents.jsonl"
$tantivy = Join-Path $benchmark "tantivy-bm25-v1"
$queryVectors = Join-Path $benchmark "ruri-full-corpus-v1"
$dependencies = @("--with", "lancedb", "--with", "pyarrow", "--with", "numpy", "--with", "tantivy")
$variants = @(
    @{ Name = "chunk512"; Tokens = 512; Overlap = 64 },
    @{ Name = "chunk1024"; Tokens = 1024; Overlap = 128 }
)

Set-Location $repository
foreach ($variant in $variants) {
    $name = $variant.Name
    $inputData = Join-Path $benchmark "ruri-semantic-pilot-$name-input-v1"
    $vectors = Join-Path $benchmark "ruri-semantic-pilot-$name-vectors-v1"
    $database = Join-Path $benchmark "lancedb-ruri-semantic-pilot-$name-v1"
    $result = Join-Path $benchmark "lancedb-ruri-semantic-pilot-$name-flat-v1"
    $table = "enterprise_rag_bench_ruri_semantic_pilot_$name"

    if (-not (Test-Path -LiteralPath (Join-Path $inputData "manifest.json"))) {
        & uv run --with pyarrow --with transformers --with sentencepiece python `
            tests/benchmarks/rag-comparison/prepare-enterprise-rag-bench-dense-chunks.py `
            --documents $documents --questions $questions --category semantic `
            --sample-documents 2000 --sample-seed enterprise-rag-bench-semantic-pilot-v1 `
            --output $inputData --chunk-tokens $variant.Tokens --overlap-tokens $variant.Overlap `
            --tokenizer ruri --shard-size 2000
        if ($LASTEXITCODE -ne 0) { throw "$name preparation failed with exit code $LASTEXITCODE" }
    }

    & node tests/benchmarks/rag-comparison/embed-enterprise-rag-bench-dense-shards.mjs `
        --input $inputData --output $vectors --questions $questions `
        --batch-size 16 --ollama-num-batch 32768
    if ($LASTEXITCODE -ne 0) { throw "$name embedding failed with exit code $LASTEXITCODE" }

    & uv run @dependencies python tests/benchmarks/rag-comparison/build-enterprise-rag-bench-lancedb.py `
        --input $inputData --vectors $vectors --database $database --table $table
    if ($LASTEXITCODE -ne 0) { throw "$name LanceDB ingestion failed with exit code $LASTEXITCODE" }

    if (-not (Test-Path -LiteralPath (Join-Path $result "report.json"))) {
        & uv run @dependencies python tests/benchmarks/rag-comparison/run-enterprise-rag-bench-lancedb.py `
            --database $database --table $table --vectors $queryVectors `
            --questions $questions --gold-documents $goldDocuments --tantivy-index $tantivy `
            --output $result --mode flat --candidate-k 50 --chunk-oversample 10 `
            --category semantic --dense-only
        if ($LASTEXITCODE -ne 0) { throw "$name Dense evaluation failed with exit code $LASTEXITCODE" }
    }
}

$comparison = Join-Path $benchmark "ruri-semantic-chunk-pilot-comparison-v1"
if (-not (Test-Path -LiteralPath (Join-Path $comparison "report.json"))) {
    & uv run --with pyarrow python tests/benchmarks/rag-comparison/compare-enterprise-rag-bench-chunk-pilot.py `
        --questions $questions `
        --variant chunk512 `
            (Join-Path $benchmark "ruri-semantic-pilot-chunk512-input-v1") `
            (Join-Path $benchmark "lancedb-ruri-semantic-pilot-chunk512-flat-v1") `
        --variant chunk1024 `
            (Join-Path $benchmark "ruri-semantic-pilot-chunk1024-input-v1") `
            (Join-Path $benchmark "lancedb-ruri-semantic-pilot-chunk1024-flat-v1") `
        --output $comparison
    if ($LASTEXITCODE -ne 0) { throw "Pilot comparison failed with exit code $LASTEXITCODE" }
}
