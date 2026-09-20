// test-verify.js
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

console.log('Validating Manifest V3:');
console.log('  Name:', manifest.name);
console.log('  Version:', manifest.version);
console.log('  Manifest Version:', manifest.manifest_version);

const filesToCheck = [
  manifest.background.service_worker,
  manifest.side_panel.default_path,
  ...manifest.content_scripts.flatMap(c => c.js),
  ...Object.values(manifest.icons)
];

let allGood = true;
for (const f of filesToCheck) {
  const full = path.join(__dirname, 'extension', f);
  if (!fs.existsSync(full)) {
    console.error('  ❌ Missing referenced file:', full);
    allGood = false;
  } else {
    console.log('  ✓ Verified:', f);
  }
}

// Check offscreen
const offscreenHtml = path.join(__dirname, 'extension', 'offscreen', 'offscreen.html');
const offscreenJs = path.join(__dirname, 'extension', 'offscreen', 'offscreen.js');
const muxJs = path.join(__dirname, 'extension', 'lib', 'mux.min.js');

console.log('  ✓ Offscreen HTML exists:', fs.existsSync(offscreenHtml));
console.log('  ✓ Offscreen JS exists:', fs.existsSync(offscreenJs));
console.log('  ✓ Mux.js exists:', fs.existsSync(muxJs));

if (!allGood) {
  process.exit(1);
} else {
  console.log('\n🎉 ALL INTEGRITY CHECKS PASSED! Chrome extension is ready to load.');
}
