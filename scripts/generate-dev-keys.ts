// Generate RSA key pair for local JWT signing
// Usage: tsx scripts/generate-dev-keys.ts

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keysDir = path.join(__dirname, '..', '.keys');

// Create .keys directory if it doesn't exist
if (!fs.existsSync(keysDir)) {
  fs.mkdirSync(keysDir, { recursive: true });
}

// Generate RSA 2048-bit key pair
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem',
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
  },
});

const privatePath = path.join(keysDir, 'private.pem');
const publicPath = path.join(keysDir, 'public.pem');

fs.writeFileSync(privatePath, privateKey);
fs.writeFileSync(publicPath, publicKey);

// Create .gitignore in .keys/ to prevent accidental commit
const gitignorePath = path.join(keysDir, '.gitignore');
if (!fs.existsSync(gitignorePath)) {
  fs.writeFileSync(gitignorePath, '*\n!.gitignore\n');
}

console.log('Dev RSA keys generated:');
console.log(`  Private: ${privatePath}`);
console.log(`  Public:  ${publicPath}`);
