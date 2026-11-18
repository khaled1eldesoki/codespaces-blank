#!/usr/bin/env bash
# Rebuilds app/vendor/edcl-forms-engine.js (pdf-lib + fontkit + bidi-js + engine in one browser script) and copies OCR files. Needs: npm install
set -euo pipefail; cd "$(dirname "$0")/.."
node node_modules/esbuild/bin/esbuild app/forms-engine.src.mjs --bundle --format=iife --global-name=EDCLForms --platform=browser --external:node:crypto --minify --outfile=app/vendor/edcl-forms-engine.js --log-level=warning
mkdir -p app/vendor/tesseract/lang
cp node_modules/tesseract.js/dist/tesseract.min.js node_modules/tesseract.js/dist/worker.min.js app/vendor/tesseract/
cp node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js app/vendor/tesseract/
cp node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz node_modules/@tesseract.js-data/ara/4.0.0_best_int/ara.traineddata.gz app/vendor/tesseract/lang/
ls -la app/vendor app/vendor/tesseract | awk '{print $5, $9}'
