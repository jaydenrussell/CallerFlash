#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const tag = process.env.APP_VERSION || '1.4.2';
pkg.version = tag.replace(/^v/, '') || '1.4.2';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Package version set to: ${pkg.version}`);
