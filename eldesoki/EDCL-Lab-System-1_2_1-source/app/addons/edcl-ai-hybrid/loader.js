/* EDCL AI Hybrid add-on loader: the ONLY line the host page needs. Loads the add-on files in order; if one is missing the rest still work. */
(function(){var base=(document.currentScript&&document.currentScript.src||'').replace(/[^\/]*$/,'');var files=['hybrid-core.js','wada-docs-ui.js','edcl-ai-hybrid.js'];
files.reduce(function(p,f){return p.then(function(){return new Promise(function(ok){var s=document.createElement('script');s.src=base+f;s.onload=ok;s.onerror=function(){console.warn('EDCL AI Hybrid: cannot load '+f);ok()};document.head.appendChild(s)})})},Promise.resolve())})();
