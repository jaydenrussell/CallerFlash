// Build the C# preloader using the .NET Framework 4.x compiler (csc.exe).
// This produces a ~7KB native Windows executable with no runtime dependencies.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CSC = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
const SOURCE = path.join(__dirname, '..', 'preloader', 'installer.cs');
const OUT = path.join(__dirname, '..', 'buildResources', 'CallerFlash-Preloader.exe');

if (!fs.existsSync(SOURCE)) {
  console.log('[preloader] source not found, skipping:', SOURCE);
  process.exit(0);
}

console.log('[preloader] compiling:', SOURCE);
execFileSync(CSC, [
  '/target:winexe',
  '/out:' + OUT,
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Drawing.dll',
  SOURCE,
], { stdio: 'inherit' });

const size = fs.statSync(OUT).size;
console.log('[preloader] built:', OUT, `(${(size / 1024).toFixed(1)} KB)`);
