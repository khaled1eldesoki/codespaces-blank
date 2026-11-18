/* EDCL WADA Monitor Fix loader: the ONLY line the host page needs. */
(function(){var base=(document.currentScript&&document.currentScript.src||'').replace(/[^\/]*$/,'');var files=['wada-fix-ui.js'];
files.reduce(function(p,f){return p.then(function(){return new Promise(function(ok){var s=document.createElement('script');s.src=base+f;s.onload=ok;s.onerror=function(){console.warn('EDCL WADA Monitor Fix: cannot load '+f);ok()};document.head.appendChild(s)})})},Promise.resolve())})();
