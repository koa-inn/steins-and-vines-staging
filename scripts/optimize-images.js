#!/usr/bin/env node
/**
 * Generate responsive WebP images from product PNGs.
 * Outputs {sku}-400w.webp and {sku}-800w.webp alongside the originals.
 *
 * Usage: node scripts/optimize-images.js
 * Requires: npm install --save-dev sharp
 */

var fs = require('fs');
var path = require('path');
var sharp = require('sharp');

var SIZES = [400, 800];
var SRC_DIR = path.join(__dirname, '..', 'images', 'products');

async function run() {
  var files = fs.readdirSync(SRC_DIR).filter(function (f) {
    return f.endsWith('.png') && !f.match(/-\d+w\.webp$/);
  });

  console.log('Found ' + files.length + ' source images');
  var created = 0;
  var skipped = 0;

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var basename = file.replace(/\.png$/, '');
    var srcPath = path.join(SRC_DIR, file);

    for (var j = 0; j < SIZES.length; j++) {
      var w = SIZES[j];
      var outName = basename + '-' + w + 'w.webp';
      var outPath = path.join(SRC_DIR, outName);

      if (fs.existsSync(outPath)) {
        skipped++;
        continue;
      }

      try {
        var meta = await sharp(srcPath).metadata();
        // Only resize if source is wider than target
        var resizeW = (meta.width && meta.width > w) ? w : null;
        await sharp(srcPath)
          .resize(resizeW, null, { withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(outPath);
        created++;
      } catch (err) {
        console.error('Error processing ' + file + ' @ ' + w + 'w:', err.message);
      }
    }

    if ((i + 1) % 20 === 0) {
      console.log('  Processed ' + (i + 1) + '/' + files.length + '...');
    }
  }

  console.log('Done: ' + created + ' created, ' + skipped + ' skipped (already exist)');
}

run().catch(function (err) {
  console.error(err);
  process.exit(1);
});
